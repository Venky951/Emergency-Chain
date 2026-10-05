const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/signup");
const Emergency = require("../models/emergency");
const EmergencyHistory = require("../models/emergencyhistory");
const controller = require("../controllers/emergencycontroller");
const { requireAuth } = require("../middleware/auth");

let mongoServer;

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        resolve(this);
        return this;
      },
    };
    handler(req, res, reject);
  });
}

function makeIo() {
  const emitted = [];
  return {
    emitted,
    use() {},
    on() {},
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
  };
}

async function createUser(role = "citizen") {
  const suffix = Math.random().toString(36).slice(2);
  return User.create({
    name: `${role}-${suffix}`,
    phone: `555${suffix.slice(0, 7)}`,
    email: `${role}-${suffix}@example.com`,
    password: "hashed-password",
    emergencyContact: "5550001",
    role,
    isActive: true,
    isAvailable: true,
    geoLocation: { type: "Point", coordinates: [78.4, 20.3] },
    location: {
      latitude: 20.3,
      longitude: 78.4,
      accuracy: 5,
      updatedAt: new Date(),
    },
    lastLocationUpdate: new Date(),
  });
}

async function createCanonicalEmergency(citizen, description = "Priority 2.7") {
  const result = await invoke(controller.createEmergency, {
    session: { userId: citizen._id },
    body: {
      latitude: 20.3,
      longitude: 78.4,
      emergencyType: "MEDICAL",
      description,
    },
  });
  assert.equal(result.statusCode, 201);
  return Emergency.findById(result.body.emergency.id);
}

async function updateStatus(emergency, actor, status) {
  return invoke(controller.updateEmergencyStatus, {
    params: { id: emergency._id.toString() },
    session: { userId: actor._id },
    body: { status },
  });
}

async function getHistory(emergency, actor) {
  return invoke(controller.getEmergencyHistory, {
    params: { id: emergency._id.toString() },
    session: { userId: actor._id },
  });
}

test.before(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    User.createIndexes(),
    Emergency.createIndexes(),
    EmergencyHistory.createIndexes(),
  ]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

test(
  "creation records one CREATED entry with the authenticated actor",
  { concurrency: false },
  async () => {
    controller.setIO(null);
    const citizen = await createUser();
    const emergency = await createCanonicalEmergency(citizen);
    const history = await EmergencyHistory.find({
      emergency: emergency._id,
    }).lean();

    assert.equal(history.length, 1);
    assert.equal(history[0].event, "CREATED");
    assert.equal(history[0].fromStatus, null);
    assert.equal(history[0].toStatus, "TRIGGERED");
    assert.equal(String(history[0].actor), String(citizen._id));
    assert.equal(history[0].actorRole, "citizen");
    assert.equal(history[0].assignedResponder, null);
  },
);

test(
  "assignment and responder lifecycle transitions are audited with actors",
  { concurrency: false },
  async () => {
    const io = makeIo();
    controller.setIO(io);
    const citizen = await createUser();
    const responder = await createUser("volunteer");
    const emergency = await createCanonicalEmergency(citizen);

    assert.equal(
      (await updateStatus(emergency, citizen, "SEARCHING_FOR_HELP")).statusCode,
      200,
    );
    const accepted = await invoke(controller.acceptEmergency, {
      params: { id: emergency._id.toString() },
      session: { userId: responder._id },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(
      (await updateStatus(emergency, responder, "RESPONDER_ON_WAY")).statusCode,
      200,
    );
    assert.equal(
      (await updateStatus(emergency, responder, "HELP_REACHED")).statusCode,
      200,
    );
    assert.equal(
      (await updateStatus(emergency, citizen, "RESOLVED")).statusCode,
      200,
    );

    const history = await EmergencyHistory.find({ emergency: emergency._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    assert.deepEqual(
      history.map((entry) => entry.event),
      [
        "CREATED",
        "SEARCHING_FOR_HELP",
        "RESPONDER_ASSIGNED",
        "RESPONDER_ON_WAY",
        "HELP_REACHED",
        "RESOLVED",
      ],
    );
    const assignment = history[2];
    assert.equal(String(assignment.actor), String(responder._id));
    assert.equal(assignment.actorRole, "volunteer");
    assert.equal(String(assignment.assignedResponder), String(responder._id));
    assert.ok(assignment.createdAt);
    assert.equal(history[3].actorRole, "volunteer");
    assert.equal(history[4].actorRole, "volunteer");
    assert.equal(history[5].actorRole, "citizen");
    assert.equal(
      io.emitted.filter(({ event }) => event === "emergency:updated").length,
      10,
    );
  },
);

test(
  "cancellation is audited and invalid or unauthorized operations add no history",
  { concurrency: false },
  async () => {
    controller.setIO(null);
    const citizen = await createUser();
    const unrelated = await createUser();
    const emergency = await createCanonicalEmergency(citizen);
    const initialCount = await EmergencyHistory.countDocuments({
      emergency: emergency._id,
    });

    const invalid = await updateStatus(emergency, citizen, "RESOLVED");
    assert.equal(invalid.statusCode, 409);
    assert.equal(
      await EmergencyHistory.countDocuments({ emergency: emergency._id }),
      initialCount,
    );

    const unauthorized = await updateStatus(emergency, unrelated, "CANCELLED");
    assert.equal(unauthorized.statusCode, 403);
    assert.equal(
      await EmergencyHistory.countDocuments({ emergency: emergency._id }),
      initialCount,
    );

    const cancelled = await updateStatus(emergency, citizen, "CANCELLED");
    assert.equal(cancelled.statusCode, 200);
    const entry = await EmergencyHistory.findOne({
      emergency: emergency._id,
      event: "CANCELLED",
    }).lean();
    assert.equal(entry.fromStatus, "TRIGGERED");
    assert.equal(entry.toStatus, "CANCELLED");
    assert.equal(String(entry.actor), String(citizen._id));
  },
);

test(
  "history endpoint authorizes involved users and preserves terminal history",
  { concurrency: false },
  async () => {
    const citizen = await createUser();
    const responder = await createUser("volunteer");
    const unrelatedCitizen = await createUser();
    const unrelatedResponder = await createUser("ambulance_driver");
    const emergency = await createCanonicalEmergency(citizen);
    await updateStatus(emergency, citizen, "SEARCHING_FOR_HELP");
    const accepted = await invoke(controller.acceptEmergency, {
      params: { id: emergency._id.toString() },
      session: { userId: responder._id },
    });
    assert.equal(accepted.statusCode, 200);
    await updateStatus(emergency, citizen, "CANCELLED");

    const citizenHistory = await getHistory(emergency, citizen);
    assert.equal(citizenHistory.statusCode, 200);
    assert.equal(citizenHistory.body.history.at(-1).toStatus, "CANCELLED");
    assert.equal(
      Object.hasOwn(citizenHistory.body.history[0], "password"),
      false,
    );

    const responderHistory = await getHistory(emergency, responder);
    assert.equal(responderHistory.statusCode, 200);

    assert.equal(
      (await getHistory(emergency, unrelatedCitizen)).statusCode,
      403,
    );
    assert.equal(
      (await getHistory(emergency, unrelatedResponder)).statusCode,
      403,
    );
    assert.equal(
      (await getHistory({ _id: "not-an-id" }, citizen)).statusCode,
      404,
    );

    const missing = await invoke(controller.getEmergencyHistory, {
      params: { id: new mongoose.Types.ObjectId().toString() },
      session: { userId: citizen._id },
    });
    assert.equal(missing.statusCode, 404);

    const unauthenticated = { statusCode: 200, body: null };
    unauthenticated.status = function status(code) {
      this.statusCode = code;
      return this;
    };
    unauthenticated.json = function json(body) {
      this.body = body;
      return this;
    };
    requireAuth(
      { headers: { accept: "application/json" } },
      unauthenticated,
      () => {
        throw new Error("next should not be called");
      },
    );
    assert.equal(unauthenticated.statusCode, 401);
  },
);

test(
  "concurrent transitions create exactly one winning history entry and socket event",
  { concurrency: false },
  async () => {
    const io = makeIo();
    controller.setIO(io);
    const citizen = await createUser();
    const emergency = await createCanonicalEmergency(citizen);

    const [first, second] = await Promise.all([
      updateStatus(emergency, citizen, "CANCELLED"),
      updateStatus(emergency, citizen, "CANCELLED"),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
    assert.equal(
      await EmergencyHistory.countDocuments({
        emergency: emergency._id,
        event: "CANCELLED",
      }),
      1,
    );
    assert.equal(
      io.emitted.filter(
        ({ event, payload }) =>
          event === "emergency:updated" &&
          payload.emergencyId === emergency._id.toString() &&
          payload.status === "CANCELLED",
      ).length,
      1,
    );
  },
);
