const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/signup");
const Emergency = require("../models/emergency");
const { acceptEmergency } = require("../controllers/emergencycontroller");
const { requireAuth, requireRole } = require("../middleware/auth");

let mongoServer;

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeController(controller, req, res) {
  await new Promise((resolve, reject) => {
    controller(req, res, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function createUser(overrides = {}) {
  const user = await User.create({
    name: "Test User",
    phone: "5550000",
    email: `test-${Math.random().toString(36).slice(2)}@example.com`,
    password: "hashed-password",
    emergencyContact: "5550001",
    role: "citizen",
    isActive: true,
    isAvailable: true,
    geoLocation: { type: "Point", coordinates: [0, 0] },
    location: { latitude: 0, longitude: 0, accuracy: 5, updatedAt: new Date() },
    lastLocationUpdate: new Date(),
    ...overrides,
  });
  return user;
}

async function createEmergency(overrides = {}) {
  return Emergency.create({
    citizen: overrides.citizen || (await createUser())._id,
    emergencyType: "MEDICAL",
    description: "Test emergency",
    latitude: 20.3,
    longitude: 78.4,
    locationAccuracy: 5,
    status: "SEARCHING_FOR_HELP",
    assignedResponder: null,
    assignedAt: null,
    ...overrides,
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

test("requireAuth rejects unauthenticated JSON requests", async () => {
  const res = makeRes();
  await requireAuth({ headers: { accept: "application/json" } }, res, () => {
    throw new Error("next should not be called");
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "Authentication required.");
});

test("requireRole rejects non-responder roles", async () => {
  const res = makeRes();
  await requireRole("volunteer", "ambulance_driver", "hospital_staff")(
    { user: { role: "citizen" }, headers: { accept: "application/json" } },
    res,
    () => {
      throw new Error("next should not be called");
    },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "Forbidden: insufficient permissions.");
});

test("acceptEmergency assigns a valid responder and marks them unavailable", async () => {
  const citizen = await createUser({ role: "citizen" });
  const responder = await createUser({
    role: "volunteer",
    isActive: true,
    isAvailable: true,
  });
  const emergency = await createEmergency({ citizen: citizen._id });

  const req = {
    params: { id: emergency._id.toString() },
    session: { userId: responder._id.toString() },
  };
  const res = makeRes();

  await invokeController(acceptEmergency, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.emergency.status, "RESPONDER_ASSIGNED");
  assert.equal(
    String(res.body.emergency.assignedResponder),
    String(responder._id),
  );

  const updatedResponder = await User.findById(responder._id).select(
    "isAvailable",
  );
  assert.equal(updatedResponder.isAvailable, false);
});

test("acceptEmergency rejects invalid emergency IDs", async () => {
  const responder = await createUser({
    role: "ambulance_driver",
    isActive: true,
    isAvailable: true,
  });
  const req = {
    params: { id: "not-a-valid-id" },
    session: { userId: responder._id.toString() },
  };
  const res = makeRes();

  await invokeController(acceptEmergency, req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "Emergency not found.");
});

test("acceptEmergency rejects already assigned emergencies", async () => {
  const citizen = await createUser({ role: "citizen" });
  const responder = await createUser({
    role: "hospital_staff",
    isActive: true,
    isAvailable: true,
  });
  const responder2 = await createUser({
    role: "volunteer",
    isActive: true,
    isAvailable: true,
  });
  const emergency = await createEmergency({
    citizen: citizen._id,
    status: "SEARCHING_FOR_HELP",
    assignedResponder: responder2._id,
    assignedAt: new Date(),
  });

  const req = {
    params: { id: emergency._id.toString() },
    session: { userId: responder._id.toString() },
  };
  const res = makeRes();

  await invokeController(acceptEmergency, req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(
    res.body.error,
    "Emergency is no longer available for acceptance.",
  );
});

test("acceptEmergency enforces atomic single-winner assignment", async () => {
  const citizen = await createUser({ role: "citizen" });
  const responderA = await createUser({
    role: "volunteer",
    isActive: true,
    isAvailable: true,
  });
  const responderB = await createUser({
    role: "ambulance_driver",
    isActive: true,
    isAvailable: true,
  });
  const emergency = await createEmergency({
    citizen: citizen._id,
    status: "SEARCHING_FOR_HELP",
  });

  const firstReq = {
    params: { id: emergency._id.toString() },
    session: { userId: responderA._id.toString() },
  };
  const secondReq = {
    params: { id: emergency._id.toString() },
    session: { userId: responderB._id.toString() },
  };

  const firstRes = makeRes();
  const secondRes = makeRes();

  await invokeController(acceptEmergency, firstReq, firstRes);
  await invokeController(acceptEmergency, secondReq, secondRes);

  const updatedEmergency = await Emergency.findById(emergency._id).lean();
  assert.equal(updatedEmergency.status, "RESPONDER_ASSIGNED");
  assert.equal(
    [String(firstRes.statusCode), String(secondRes.statusCode)].includes(
      "200",
    ) &&
      [String(firstRes.statusCode), String(secondRes.statusCode)].includes(
        "409",
      ),
    true,
  );
  assert.equal(
    String(updatedEmergency.assignedResponder) === String(responderA._id) ||
      String(updatedEmergency.assignedResponder) === String(responderB._id),
    true,
  );
});
