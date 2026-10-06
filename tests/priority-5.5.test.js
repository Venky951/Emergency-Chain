const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("visual polish preserves critical DOM contracts and reduced motion", () => {
  const workflow = read("views/partials/emergency-workflow.ejs");
  const dashboard = read("views/dashboard.ejs");
  const styles = read("src/styles.css");

  for (const selector of [
    "level1Button", "level2Button", "level3Button", "statusTextTop",
    "statusTextLive", "cancelEmergencyButton", "searchRespondersButton",
    "nearbyResponders", "map", "locationStatus", "helpersList",
    "alertsList", "nearbyCount", "alertsCount", "searchingEmergenciesList",
    "connectionStatus",
  ]) {
    assert.match(`${workflow}\n${dashboard}`, new RegExp(`id="${selector}"`), selector);
  }
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /translateY\(1px\)/);
  assert.doesNotMatch(styles, /three\.js|webgl|gsap/i);
});

test("visual polish remains CSS-only and does not add fake emergency claims", () => {
  const styles = read("src/styles.css");
  const landing = read("views/index.ejs");
  const head = read("views/partials/head.ejs");

  assert.match(styles, /emergency-history-item::before/);
  assert.match(styles, /#assignedEmergencyPanel/);
  assert.match(styles, /#map/);
  assert.doesNotMatch(`${landing}\n${head}`, /guaranteed rescue|guaranteed arrival|ambulance dispatch/i);
  assert.doesNotMatch(head, /three\.js|gsap|react|vue/i);
});
