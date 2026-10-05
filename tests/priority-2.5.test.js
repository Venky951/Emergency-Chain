const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/signup");
const Emergency = require("../models/emergency");
const controller = require("../controllers/emergencycontroller");

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
  let connectionHandler;
  let middleware;

  return {
    emitted,
    use(handler) {
      middleware = handler;
    },
    on(event, handler) {
      if (event === "connection") connectionHandler = handler;
    },
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
    async authenticate(socket) {
      await new Promise((resolve, reject) => {
        middleware(socket, (error) => (error ? reject(error) : resolve()));
      });
      connectionHandler(socket);
    },
  };
}

async function createUser(role, suffix) {
  return User.create({
    name: `${role}-${suffix}`,
    phone: `555-${suffix}`,
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

async function createEmergency(citizen, status = "TRIGGERED") {
  return Emergency.create({
    citizen: citizen._id,
    emergencyType: "MEDICAL",
    description: "Priority 2.5 test",
    latitude: 20.3,
    longitude: 78.4,
    status,
  });
}

test.before(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

test(
  "Socket.IO authenticates sessions and joins only the derived user room",
  { concurrency: false },
  async () => {
    const io = makeIo();
    controller.setIO(io);

    const citizen = await createUser("citizen", "socket-citizen");
    const socket = {
      id: "socket-1",
      request: { session: { isLoggedIn: true, userId: citizen._id } },
      data: {},
      join(room) {
        this.room = room;
      },
      on() {},
    };

    await io.authenticate(socket);
    assert.equal(socket.data.userId, String(citizen._id));
    assert.equal(socket.room, `user:${citizen._id}`);

    await assert.rejects(
      io.authenticate({
        request: { session: {} },
        data: {},
        join() {},
        on() {},
      }),
      /Authentication required/,
    );
  },
);

test(
  "lifecycle updates emit private persisted emergency payloads",
  { concurrency: false },
  async () => {
    const io = makeIo();
    controller.setIO(io);

    const citizen = await createUser("citizen", "lifecycle-citizen");
    const responder = await createUser("volunteer", "lifecycle-responder");
    const unrelatedCitizen = await createUser("citizen", "unrelated-citizen");

    const created = await invoke(controller.createEmergency, {
      session: { userId: citizen._id },
      body: {
        latitude: 20.3,
        longitude: 78.4,
        emergencyType: "MEDICAL",
        description: "Lifecycle event test",
      },
    });
    const emergencyId = created.body.emergency.id.toString();
    assert.equal(created.statusCode, 201);

    const searching = await invoke(controller.updateEmergencyStatus, {
      params: { id: emergencyId },
      session: { userId: citizen._id },
      body: { status: "SEARCHING_FOR_HELP" },
    });
    assert.equal(searching.statusCode, 200);

    const accepted = await invoke(controller.acceptEmergency, {
      params: { id: emergencyId },
      session: { userId: responder._id },
    });
    assert.equal(accepted.statusCode, 200);

    const onWay = await invoke(controller.updateEmergencyStatus, {
      params: { id: emergencyId },
      session: { userId: responder._id },
      body: { status: "RESPONDER_ON_WAY" },
    });
    assert.equal(onWay.statusCode, 200);

    const reached = await invoke(controller.updateEmergencyStatus, {
      params: { id: emergencyId },
      session: { userId: responder._id },
      body: { status: "HELP_REACHED" },
    });
    assert.equal(reached.statusCode, 200);

    const resolved = await invoke(controller.updateEmergencyStatus, {
      params: { id: emergencyId },
      session: { userId: citizen._id },
      body: { status: "RESOLVED" },
    });
    assert.equal(resolved.statusCode, 200);

    const secondCreated = await invoke(controller.createEmergency, {
      session: { userId: citizen._id },
      body: {
        latitude: 20.3,
        longitude: 78.4,
        emergencyType: "SAFETY",
      },
    });
    const secondEmergencyId = secondCreated.body.emergency.id.toString();
    const cancelled = await invoke(controller.updateEmergencyStatus, {
      params: { id: secondEmergencyId },
      session: { userId: citizen._id },
      body: { status: "CANCELLED" },
    });
    assert.equal(cancelled.statusCode, 200);

    const lifecycleEvents = io.emitted.filter(
      ({ event, payload }) =>
        event === "emergency:updated" &&
        [emergencyId, secondEmergencyId].includes(payload.emergencyId),
    );
    assert.deepEqual(
      [
        ...new Map(
          lifecycleEvents.map(({ payload }) => [
            `${payload.emergencyId}:${payload.status}`,
            payload.status,
          ]),
        ).values(),
      ],
      [
        "TRIGGERED",
        "SEARCHING_FOR_HELP",
        "RESPONDER_ASSIGNED",
        "RESPONDER_ON_WAY",
        "HELP_REACHED",
        "RESOLVED",
        "TRIGGERED",
        "CANCELLED",
      ],
    );

    const assignmentEvent = lifecycleEvents.find(
      ({ payload }) => payload.status === "RESPONDER_ASSIGNED",
    );
    assert.deepEqual(
      new Set(
        lifecycleEvents
          .filter(({ payload }) => payload.emergencyId === emergencyId)
          .map(({ room }) => room),
      ),
      new Set([`user:${citizen._id}`, `user:${responder._id}`]),
    );
    assert.equal(
      assignmentEvent.payload.assignedResponder,
      String(responder._id),
    );
    assert.ok(assignmentEvent.payload.assignedAt);
    assert.ok(assignmentEvent.payload.updatedAt);
    assert.equal(
      lifecycleEvents.some(
        ({ room }) => room === `user:${unrelatedCitizen._id}`,
      ),
      false,
    );
    assert.deepEqual(Object.keys(assignmentEvent.payload).sort(), [
      "assignedAt",
      "assignedResponder",
      "emergencyId",
      "status",
      "updatedAt",
    ]);
  },
);

test(
  "HTTP lifecycle operations still work without an active Socket.IO instance",
  { concurrency: false },
  async () => {
    controller.setIO(null);
    const citizen = await createUser("citizen", "http-only-citizen");
    const created = await invoke(controller.createEmergency, {
      session: { userId: citizen._id },
      body: {
        latitude: 20.3,
        longitude: 78.4,
        emergencyType: "MEDICAL",
      },
    });
    assert.equal(created.statusCode, 201);
  },
);
