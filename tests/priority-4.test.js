const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/signup");
const controller = require("../controllers/emergencycontroller");
const authController = require("../controllers/authcontroller");
const locationController = require("../controllers/locationcontroller");
const { sameOrigin } = require("../middleware/sameorigin");

let mongoServer;

function response(resolve = () => {}) {
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
    redirectTarget: null,
    redirect(target) {
      this.redirectTarget = target;
      resolve(this);
      return this;
    },
  };
}

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    handler(req, response(resolve), reject);
  });
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

test.before(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await User.createIndexes();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

test("same-origin mutation protection accepts legitimate and rejects cross-origin or missing origin", () => {
  let called = false;
  sameOrigin(
    {
      method: "POST",
      protocol: "http",
      get(name) {
        if (name === "host") return "localhost:3000";
        if (name === "origin") return "http://localhost:3000";
        return undefined;
      },
    },
    response(),
    () => {
      called = true;
    },
  );
  assert.equal(called, true);

  const crossOrigin = response();
  sameOrigin(
    {
      method: "POST",
      protocol: "http",
      get(name) {
        if (name === "host") return "localhost:3000";
        if (name === "origin") return "https://evil.example";
        return undefined;
      },
    },
    crossOrigin,
    () => {
      throw new Error("cross-origin request should be rejected");
    },
  );
  assert.equal(crossOrigin.statusCode, 403);

  const missingOrigin = response();
  sameOrigin(
    {
      method: "PATCH",
      protocol: "http",
      get(name) {
        return name === "host" ? "localhost:3000" : undefined;
      },
    },
    missingOrigin,
    () => {
      throw new Error("missing-origin request should be rejected");
    },
  );
  assert.equal(missingOrigin.statusCode, 403);
});

test("successful login regenerates the session identifier before authentication", async () => {
  const originalFindOne = User.findOne;
  const passwordHash = await bcrypt.hash("correct-password", 4);
  const user = {
    _id: new mongoose.Types.ObjectId(),
    role: "citizen",
    name: "Test Citizen",
    isActive: true,
    password: passwordHash,
  };
  User.findOne = () => ({ select: async () => user });

  try {
    let sessionId = "pre-auth-session";
    const req = {
      body: { email: "citizen@example.com", password: "correct-password" },
      session: {
        regenerate(callback) {
          sessionId = "new-auth-session";
          callback(null);
        },
      },
    };
    const res = response();
    await authController.postLogin(req, res);
    assert.equal(sessionId, "new-auth-session");
    assert.equal(req.session.isLoggedIn, true);
    assert.equal(String(req.session.userId), String(user._id));
  } finally {
    User.findOne = originalFindOne;
  }
});

test("legacy level 3 notifications use responder rooms without phone or exact coordinates", async () => {
  const user = await createUser("citizen");
  const responder = await createUser("volunteer");
  const emissions = [];
  controller.setIO({
    use() {},
    on() {},
    to(room) {
      return {
        emit(event, payload) {
          emissions.push({ room, event, payload });
        },
      };
    },
  });

  const result = await invoke(controller.triggerLevel3, {
    session: { userId: user._id },
    body: { latitude: 20.3, longitude: 78.4, reason: "Critical test" },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(
    emissions.some((item) => item.event === "sos-level-3"),
    true,
  );
  assert.equal(
    emissions.some((item) => Object.hasOwn(item.payload, "userPhone")),
    false,
  );
  assert.equal(
    emissions.some((item) => Object.hasOwn(item.payload, "latitude")),
    false,
  );
  assert.equal(
    emissions.every((item) => item.room === `user:${responder._id}`),
    true,
  );
});

test("nearby-user radius is capped and phone is not returned", async () => {
  const citizen = await createUser();
  await assert.rejects(
    invoke(locationController.getNearbyUsers, {
      session: { userId: citizen._id },
      query: { latitude: 20.3, longitude: 78.4, radius: 999999 },
    }),
    (error) => error.statusCode === 400,
  );

  await User.create({
    name: "Nearby Responder",
    phone: "5559999",
    email: "nearby-hardening@example.com",
    password: "hashed-password",
    emergencyContact: "5550001",
    role: "volunteer",
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
  const nearby = await invoke(locationController.getNearbyUsers, {
    session: { userId: citizen._id },
    query: { latitude: 20.3, longitude: 78.4, radius: 1000 },
  });
  assert.equal(nearby.statusCode, 200);
  assert.equal(Object.hasOwn(nearby.body.users[0], "phone"), false);
});

test("private API caching and dynamic dashboard rendering are hardened", () => {
  const serviceWorker = fs.readFileSync(
    path.join(__dirname, "../public/service-worker.js"),
    "utf8",
  );
  const dashboard = fs.readFileSync(
    path.join(__dirname, "../views/dashboard.ejs"),
    "utf8",
  );
  const app = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

  assert.match(serviceWorker, /isPrivateApiRequest/);
  assert.match(serviceWorker, /event\.respondWith\(fetch\(request\)\)/);
  assert.match(serviceWorker, /emergency-chain-v4/);
  assert.doesNotMatch(dashboard, /helpersList\.innerHTML\s*\+=/);
  assert.doesNotMatch(dashboard, /alertsList\.innerHTML\s*\+=/);
  assert.doesNotMatch(dashboard, /bindPopup\(`\$\{/);
  assert.match(app, /sameOrigin/);
  assert.doesNotMatch(app, /cors:\s*\{\s*origin:\s*"\*"/);
});
