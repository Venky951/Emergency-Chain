const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/signup");
const Emergency = require("../models/emergency");
const EmergencyContact = require("../models/emergencycontact");
const EmergencyHistory = require("../models/emergencyhistory");
const EmergencyNotification = require("../models/emergencynotification");
const controller = require("../controllers/emergencycontroller");

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

async function createUser() {
  const suffix = Math.random().toString(36).slice(2);
  return User.create({
    name: `offline-${suffix}`,
    phone: `555${suffix.slice(0, 7)}`,
    email: `offline-${suffix}@example.com`,
    password: "hashed-password",
    emergencyContact: "5550001",
    role: "citizen",
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

function createRequest(userId, clientRequestId) {
  return {
    session: { userId },
    body: {
      clientRequestId,
      emergencyType: "MEDICAL",
      description: "Priority 3 test",
      latitude: 20.3,
      longitude: 78.4,
      accuracy: 5,
    },
  };
}

test.before(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    User.createIndexes(),
    Emergency.createIndexes(),
    EmergencyContact.createIndexes(),
    EmergencyHistory.createIndexes(),
    EmergencyNotification.createIndexes(),
  ]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

test(
  "online canonical SOS creates once and repeated UUID returns the existing Emergency",
  { concurrency: false },
  async () => {
    controller.setIO(null);
    const citizen = await createUser();
    const contact = await EmergencyContact.create({
      owner: citizen._id,
      name: "Offline Contact",
      relationship: "Friend",
      phone: "+919876543210",
    });
    const requestId = "11111111-1111-4111-8111-111111111111";

    const first = await invoke(
      controller.createEmergency,
      createRequest(citizen._id, requestId),
    );
    const second = await invoke(
      controller.createEmergency,
      createRequest(citizen._id, requestId),
    );

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.idempotent, true);
    assert.equal(
      String(first.body.emergency.id),
      String(second.body.emergency.id),
    );
    assert.equal(
      await Emergency.countDocuments({
        citizen: citizen._id,
        clientRequestId: requestId,
      }),
      1,
    );
    assert.equal(
      await EmergencyHistory.countDocuments({
        emergency: first.body.emergency.id,
      }),
      1,
    );
    assert.equal(
      await EmergencyNotification.countDocuments({
        emergency: first.body.emergency.id,
        recipientContact: contact._id,
      }),
      1,
    );
  },
);

test(
  "invalid UUIDs are rejected and concurrent retries create one Emergency",
  { concurrency: false },
  async () => {
    controller.setIO(null);
    const citizen = await createUser();
    const invalid = await invoke(
      controller.createEmergency,
      createRequest(citizen._id, "not-a-uuid"),
    );
    assert.equal(invalid.statusCode, 400);

    const requestId = "22222222-2222-4222-8222-222222222222";
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        invoke(
          controller.createEmergency,
          createRequest(citizen._id, requestId),
        ),
      ),
    );
    assert.equal(
      results.filter((result) => result.statusCode === 201).length,
      1,
    );
    assert.equal(
      results.filter((result) => result.statusCode === 200).length,
      2,
    );
    assert.equal(
      await Emergency.countDocuments({
        citizen: citizen._id,
        clientRequestId: requestId,
      }),
      1,
    );
  },
);

test("offline queue and service-worker contracts are present without private contact data", () => {
  const publicApp = fs.readFileSync(
    path.join(__dirname, "../public/app.js"),
    "utf8",
  );
  const serviceWorker = fs.readFileSync(
    path.join(__dirname, "../public/service-worker.js"),
    "utf8",
  );
  const sosView = fs.readFileSync(
    path.join(__dirname, "../views/sos.ejs"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.join(__dirname, "../public/emergency-workflow.js"),
    "utf8",
  );

  assert.match(publicApp, /canonical-emergencies/);
  assert.match(publicApp, /clientRequestId/);
  assert.match(publicApp, /sync-canonical-emergency/);
  assert.match(publicApp, /auth-required/);
  assert.match(sosView, /include\(['"]partials\/emergency-workflow['"]/);
  assert.match(workflow, /Queued offline — not yet sent to server/);
  assert.match(workflow, /Emergency sent/);
  assert.match(serviceWorker, /sync-canonical-emergency/);
  assert.match(serviceWorker, /sync-sos/);
  assert.match(serviceWorker, /sync-location/);
  assert.match(serviceWorker, /tile\.openstreetmap\.org/);
  assert.doesNotMatch(publicApp, /EmergencyNotification/);
  assert.doesNotMatch(publicApp, /EmergencyHistory/);
  assert.doesNotMatch(serviceWorker, /EmergencyNotification/);
  assert.doesNotMatch(serviceWorker, /EmergencyHistory/);
  assert.doesNotMatch(publicApp, /emergencyContact/);
});
