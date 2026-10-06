const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("responder dashboard uses authoritative acceptance and lifecycle transitions", () => {
  const dashboard = read("views/dashboard.ejs");
  assert.match(dashboard, /button\.disabled = true/);
  assert.match(dashboard, /Accepting…/);
  assert.match(dashboard, /\/api\/emergency\/\$\{emergencyId\}\/accept/);
  assert.match(dashboard, /RESPONDER_ASSIGNED/);
  assert.match(dashboard, /RESPONDER_ON_WAY/);
  assert.match(dashboard, /HELP_REACHED/);
});

test("map remains touch-usable and history uses the existing endpoint", () => {
  const dashboard = read("views/dashboard.ejs");
  const workflow = read("public/emergency-workflow.js");
  assert.match(dashboard, /dragging: true/);
  assert.match(dashboard, /tap: true/);
  assert.match(workflow, /\/emergency\/\$\{id\}\/history/);
  assert.match(workflow, /renderHistory\(history\)/);
});

test("history timeline renders only returned events without internal identifiers", () => {
  const workflow = read("public/emergency-workflow.js");
  assert.match(workflow, /entry\.toStatus/);
  assert.match(workflow, /entry\.actorRole/);
  assert.match(workflow, /toLocaleString/);
  assert.doesNotMatch(workflow, /entry\.actor\b/);
  assert.doesNotMatch(workflow, /assignedResponder/);
});
