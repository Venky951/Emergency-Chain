const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/signup");
const Emergency = require("../models/emergency");
const controller = require("../controllers/emergencycontroller");
const { requireAuth } = require("../middleware/auth");

let mongoServer;

function makeResponse(resolve) {
  return {
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
}

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = makeResponse(resolve);
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
    geoLocation: { type: "Point", coordinates: [0, 0] },
    location: { latitude: 0, longitude: 0, accuracy: 5, updatedAt: new Date() },
    lastLocationUpdate: new Date(),
  });
}

async function createEmergency(citizen, status, assignedResponder = null) {
  return Emergency.create({
    citizen: citizen._id,
    emergencyType: "MEDICAL",
    description: "Priority 2.6 test",
    latitude: 20.3,
    longitude: 78.4,
    status,
    assignedResponder,
    assignedAt: assignedResponder ? new Date() : null,
  });
}

async function assignEmergency(citizen, responder) {
  const emergency = await createEmergency(citizen, "SEARCHING_FOR_HELP");
  const result = await invoke(controller.acceptEmergency, {
    params: { id: emergency._id.toString() },
    session: { userId: responder._id },
  });
  assert.equal(result.statusCode, 200);
  return Emergency.findById(emergency._id);
}

async function updateStatus(emergency, user, status) {
  return invoke(controller.updateEmergencyStatus, {
    params: { id: emergency._id.toString() },
    session: user ? { userId: user._id } : {},
    body: { status },
  });
}

test.before(async () => {
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
  });
  await mongoose.connect(mongoServer.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

test(
  "citizens can cancel every allowed active source state and cleanup availability",
  { concurrency: false },
  async () => {
    const io = makeIo();
    controller.setIO(io);
    const sourceStates = [
      "TRIGGERED",
      "SEARCHING_FOR_HELP",
      "RESPONDER_ASSIGNED",
      "RESPONDER_ON_WAY",
    ];

    for (const sourceStatus of sourceStates) {
      const citizen = await createUser();
      const responder =
        sourceStatus === "RESPONDER_ASSIGNED" ||
        sourceStatus === "RESPONDER_ON_WAY"
          ? await createUser("volunteer")
          : null;
      const emergency = responder
        ? await assignEmergency(citizen, responder)
        : await createEmergency(citizen, sourceStatus);

      if (sourceStatus === "RESPONDER_ON_WAY") {
        const onWay = await updateStatus(
          emergency,
          responder,
          "RESPONDER_ON_WAY",
        );
        assert.equal(onWay.statusCode, 200);
      }

      const cancelled = await updateStatus(emergency, citizen, "CANCELLED");
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.body.emergency.status, "CANCELLED");

      if (responder) {
        const updatedResponder = await User.findById(responder._id).lean();
        assert.equal(updatedResponder.isAvailable, true);
      }

      const repeated = await updateStatus(emergency, citizen, "CANCELLED");
      assert.equal(repeated.statusCode, 409);
    }
  },
);

test(
  "cancellation rejects terminal states and unauthorized users",
  { concurrency: false },
  async () => {
    for (const sourceStatus of ["HELP_REACHED", "RESOLVED", "CANCELLED"]) {
      const citizen = await createUser();
      const emergency = await createEmergency(citizen, sourceStatus);
      const result = await updateStatus(emergency, citizen, "CANCELLED");
      assert.equal(result.statusCode, 409);
    }

    const citizen = await createUser();
    const responder = await createUser("volunteer");
    const unrelatedCitizen = await createUser();
    const emergency = await assignEmergency(citizen, responder);

    const responderResult = await updateStatus(
      emergency,
      responder,
      "CANCELLED",
    );
    assert.equal(responderResult.statusCode, 403);

    const unrelatedResult = await updateStatus(
      emergency,
      unrelatedCitizen,
      "CANCELLED",
    );
    assert.equal(unrelatedResult.statusCode, 403);

    const unauthenticatedResponse = { statusCode: 200, body: null };
    unauthenticatedResponse.status = function status(code) {
      this.statusCode = code;
      return this;
    };
    unauthenticatedResponse.json = function json(body) {
      this.body = body;
      return this;
    };
    requireAuth(
      { headers: { accept: "application/json" } },
      unauthenticatedResponse,
      () => {
        throw new Error("next should not be called");
      },
    );
    assert.equal(unauthenticatedResponse.statusCode, 401);
  },
);

test(
  "citizens alone can resolve HELP_REACHED and terminal cleanup is idempotent",
  { concurrency: false },
  async () => {
    const io = makeIo();
    controller.setIO(io);
    const citizen = await createUser();
    const responder = await createUser("volunteer");
    const emergency = await assignEmergency(citizen, responder);
    const reached = await updateStatus(
      emergency,
      responder,
      "RESPONDER_ON_WAY",
    );
    assert.equal(reached.statusCode, 200);
    const helped = await updateStatus(emergency, responder, "HELP_REACHED");
    assert.equal(helped.statusCode, 200);

    const responderResult = await updateStatus(
      emergency,
      responder,
      "RESOLVED",
    );
    assert.equal(responderResult.statusCode, 403);

    const resolved = await updateStatus(emergency, citizen, "RESOLVED");
    assert.equal(resolved.statusCode, 200);
    assert.equal(resolved.body.emergency.status, "RESOLVED");
    assert.equal((await User.findById(responder._id)).isAvailable, true);

    const repeated = await updateStatus(emergency, citizen, "RESOLVED");
    assert.equal(repeated.statusCode, 409);
    assert.equal((await User.findById(responder._id)).isAvailable, true);

    const noResponderCitizen = await createUser();
    const noResponderEmergency = await createEmergency(
      noResponderCitizen,
      "HELP_REACHED",
    );
    const noResponderResult = await updateStatus(
      noResponderEmergency,
      noResponderCitizen,
      "RESOLVED",
    );
    assert.equal(noResponderResult.statusCode, 200);
  },
);

test(
  "resolution is rejected from every non-HELP_REACHED source state",
  { concurrency: false },
  async () => {
    for (const sourceStatus of [
      "TRIGGERED",
      "SEARCHING_FOR_HELP",
      "RESPONDER_ASSIGNED",
      "RESPONDER_ON_WAY",
      "RESOLVED",
      "CANCELLED",
    ]) {
      const citizen = await createUser();
      const emergency = await createEmergency(citizen, sourceStatus);
      const result = await updateStatus(emergency, citizen, "RESOLVED");
      assert.equal(result.statusCode, 409);
    }
  },
);

test(
  "concurrent transitions allow exactly one winner and emit one event",
  { concurrency: false },
  async () => {
    const io = makeIo();
    controller.setIO(io);
    const citizen = await createUser();
    const emergency = await createEmergency(citizen, "TRIGGERED");

    const [first, second] = await Promise.all([
      updateStatus(emergency, citizen, "CANCELLED"),
      updateStatus(emergency, citizen, "CANCELLED"),
    ]);

    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
    assert.equal((await Emergency.findById(emergency._id)).status, "CANCELLED");
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
