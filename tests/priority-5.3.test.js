const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("connection UX keeps network and server state separate", () => {
  const app = read("public/app.js");
  const workflow = read("public/emergency-workflow.js");
  const dashboard = read("views/dashboard.ejs");

  assert.match(app, /app-connection-state/);
  assert.match(app, /socketConnectionState = "reconnecting"/);
  assert.match(workflow, /Queued offline — not yet sent to server/);
  assert.match(workflow, /Server confirmed/);
  assert.match(dashboard, /Online · Server connected/);
  assert.match(dashboard, /Online · Reconnecting…/);
});

test("offline fallback does not create a second emergency queue", () => {
  const offline = read("views/offline.html");

  assert.match(offline, /does not create a separate local SOS request/);
  assert.doesNotMatch(offline, /triggerLocalSOS|indexedDB\.open|sync-sos/);
});

test("location status remains independent and accessible", () => {
  const workflow = read("public/emergency-workflow.js");
  const partial = read("views/partials/emergency-workflow.ejs");

  assert.match(workflow, /\.dataset\.locationState = "requesting"/);
  assert.match(workflow, /\.dataset\.locationState = "available"/);
  assert.match(workflow, /\.dataset\.locationState = error\?\.code === 1 \? "denied" : "unavailable"/);
  assert.match(partial, /id="sosLocationStatus" role="status" aria-live="polite"/);
});
