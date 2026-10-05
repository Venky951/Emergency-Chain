const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/signup");
const Emergency = require("../models/emergency");
const EmergencyContact = require("../models/emergencycontact");
const EmergencyHistory = require("../models/emergencyhistory");
const EmergencyNotification = require("../models/emergencynotification");
const emergencyController = require("../controllers/emergencycontroller");
const contactController = require("../controllers/emergencycontactcontroller");
const {
  createEmergencyContactNotifications,
} = require("../services/emergencyNotificationService");
const { requireAuth, requireRole } = require("../middleware/auth");

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

function makeAuthResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
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

async function createContact(owner, overrides = {}) {
  return EmergencyContact.create({
    owner: owner._id,
    name: "Trusted Contact",
    relationship: "Friend",
    phone: "+919876543210",
    ...overrides,
  });
}

async function createEmergency(owner) {
  const result = await invoke(emergencyController.createEmergency, {
    session: { userId: owner._id },
    body: {
      latitude: 20.3,
      longitude: 78.4,
      emergencyType: "MEDICAL",
      description: "Priority 2.8 test",
    },
  });
  assert.equal(result.statusCode, 201);
  return Emergency.findById(result.body.emergency.id);
}

test.before(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    User.createIndexes(),
    Emergency.createIndexes(),
    EmergencyHistory.createIndexes(),
    EmergencyContact.createIndexes(),
    EmergencyNotification.createIndexes(),
  ]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

test(
  "contact CRUD is citizen-owned and server derives the owner",
  { concurrency: false },
  async () => {
    const citizen = await createUser();
    const otherCitizen = await createUser();
    const responder = await createUser("volunteer");

    const created = await invoke(contactController.createContact, {
      session: { userId: citizen._id },
      body: {
        owner: otherCitizen._id,
        name: "Parent",
        relationship: "Parent",
        phone: "+91 98765-43210",
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.contact.phone, "+919876543210");
    assert.equal("owner" in created.body.contact, false);

    const own = await invoke(contactController.listContacts, {
      session: { userId: citizen._id },
    });
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.contacts.length, 1);

    const updated = await invoke(contactController.updateContact, {
      params: { id: created.body.contact._id },
      session: { userId: citizen._id },
      body: {
        name: "Updated Parent",
        relationship: "Parent",
        phone: "919876543210",
      },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.contact.name, "Updated Parent");
    assert.equal(updated.body.contact.phone, "919876543210");

    const otherUpdate = await invoke(contactController.updateContact, {
      params: { id: created.body.contact._id },
      session: { userId: otherCitizen._id },
      body: { name: "No Access", relationship: "Other", phone: "919876543211" },
    });
    assert.equal(otherUpdate.statusCode, 404);

    const responderList = await invoke(contactController.listContacts, {
      session: { userId: responder._id },
    });
    assert.equal(responderList.statusCode, 200);
    assert.equal(responderList.body.contacts.length, 0);

    const deactivated = await invoke(contactController.deactivateContact, {
      params: { id: created.body.contact._id },
      session: { userId: citizen._id },
    });
    assert.equal(deactivated.statusCode, 200);
    assert.equal(deactivated.body.contact.isActive, false);
  },
);

test(
  "contact authorization, validation, and active-contact limit are enforced",
  { concurrency: false },
  async () => {
    const citizen = await createUser();
    const contact = await createContact(citizen);
    const invalid = await invoke(contactController.createContact, {
      session: { userId: citizen._id },
      body: { name: "Invalid", relationship: "Friend", phone: "not-a-phone" },
    });
    assert.equal(invalid.statusCode, 400);

    const unauthenticated = makeAuthResponse();
    requireAuth(
      { headers: { accept: "application/json" } },
      unauthenticated,
      () => {
        throw new Error("next should not be called");
      },
    );
    assert.equal(unauthenticated.statusCode, 401);

    const responder = await createUser("hospital_staff");
    const forbidden = makeAuthResponse();
    requireRole("citizen")(
      { user: responder, headers: { accept: "application/json" } },
      forbidden,
      () => {
        throw new Error("next should not be called");
      },
    );
    assert.equal(forbidden.statusCode, 403);

    const max = contactController.getMaxContacts();
    await Promise.all(
      Array.from({ length: max - 1 }, (_, index) =>
        createContact(citizen, {
          name: `Contact ${index}`,
          phone: `+9198765432${String(index).padStart(2, "0")}`,
        }),
      ),
    );
    const limit = await invoke(contactController.createContact, {
      session: { userId: citizen._id },
      body: {
        name: "Overflow",
        relationship: "Friend",
        phone: "+919876543299",
      },
    });
    assert.equal(limit.statusCode, 409);
    assert.ok(contact);
  },
);

test(
  "canonical creation notifies active contacts without copying phone numbers",
  { concurrency: false },
  async () => {
    emergencyController.setIO(null);
    const citizen = await createUser();
    const activeContact = await createContact(citizen, {
      phone: "+919876543211",
    });
    const inactiveContact = await createContact(citizen, {
      phone: "+919876543212",
      isActive: false,
    });

    const emergency = await createEmergency(citizen);
    const notifications = await EmergencyNotification.find({
      emergency: emergency._id,
    }).lean();
    assert.equal(notifications.length, 1);
    assert.equal(
      String(notifications[0].recipientContact),
      String(activeContact._id),
    );
    assert.equal(notifications[0].event, "EMERGENCY_CREATED");
    assert.equal(notifications[0].channel, "SMS");
    assert.equal(notifications[0].deliveryStatus, "UNAVAILABLE");
    assert.equal(notifications[0].retryCount, 0);
    assert.equal("phone" in notifications[0], false);
    assert.equal(
      String(notifications[0].recipientContact) === String(inactiveContact._id),
      false,
    );
  },
);

test(
  "notification creation is idempotent and failed emergency creation leaves no rows",
  { concurrency: false },
  async () => {
    emergencyController.setIO(null);
    const citizen = await createUser();
    const contact = await createContact(citizen);
    const emergency = await createEmergency(citizen);
    const before = await EmergencyNotification.countDocuments({
      emergency: emergency._id,
    });
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await createEmergencyContactNotifications({
          emergency,
          ownerId: citizen._id,
          session,
        });
        await createEmergencyContactNotifications({
          emergency,
          ownerId: citizen._id,
          session,
        });
      });
    } finally {
      await session.endSession();
    }
    assert.equal(
      await EmergencyNotification.countDocuments({ emergency: emergency._id }),
      before,
    );
    assert.ok(contact);

    const failed = await invoke(emergencyController.createEmergency, {
      session: { userId: citizen._id },
      body: { latitude: 20.3, longitude: 78.4, emergencyType: "SAFETY" },
    });
    assert.equal(failed.statusCode, 409);
    assert.equal(
      await EmergencyNotification.countDocuments({ emergency: emergency._id }),
      before,
    );
  },
);
