const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const ejs = require("ejs");
const Emergency = require("../models/emergency");

const ROOT = path.join(__dirname, "..");
const USER_ID = "111111111111111111111111";
const EMERGENCY_ID = "222222222222222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const POINTER_KEY = `emergencychain:workflow:${USER_ID}`;
const STATES = Emergency.schema.path("status").enumValues;
const COPY = {
  TRIGGERED: /Emergency sent/i,
  SEARCHING_FOR_HELP: /Searching for help/i,
  RESPONDER_ASSIGNED: /Responder assigned/i,
  RESPONDER_ON_WAY: /Responder on the way/i,
  HELP_REACHED: /Help reached/i,
  RESOLVED: /Resolved/i,
  CANCELLED: /Cancelled/i,
};

class EventHub {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
}

// A small DOM fixture keeps these behavior tests dependency-free. The actual
// shared EJS supplies its IDs, data attributes, labels and element hierarchy.
class Element extends EventHub {
  constructor(tagName = "div", ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.style = {};
    this._text = "";
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classList.contains(name) : force;
        this.classList[enabled ? "add" : "remove"](name);
        return enabled;
      },
    };
  }
  get className() { return this.attributes.get("class") || ""; }
  set className(value) { this.attributes.set("class", value); }
  get id() { return this.attributes.get("id") || ""; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.children = []; this.textWrites = (this.textWrites || 0) + 1; }
  set innerHTML(value) { assert.equal(value, "", "Untrusted HTML must not be inserted by the workflow"); this.replaceChildren(); }
  get innerHTML() { return this.textContent; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
    if (name === "value") this.value = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "disabled") this.disabled = false;
    if (name === "hidden") this.hidden = false;
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(typeof child === "string" ? Object.assign(new Element("span", this.ownerDocument), { textContent: child }) : child); }
  replaceChildren(...children) { this.children = []; this._text = ""; this.append(...children); }
  focus() { this.ownerDocument.activeElement = this; }
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const match = /^([\w-]+)?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/.exec(selector);
    if (!match) return false;
    return (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || (this.hasAttribute(match[2]) && (match[3] === undefined || this.getAttribute(match[2]) === match[3])));
  }
  querySelectorAll(selector) {
    const results = [];
    const selectors = selector.split(",").map((value) => value.trim());
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((candidate) => child.matches(candidate))) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function makeDocument(userId) {
  const document = new EventHub();
  document.readyState = "loading";
  document.hidden = false;
  document.body = new Element("body", document);
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (text) => Object.assign(new Element("span", document), { textContent: text });
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  document.querySelector = (selector) => document.body.querySelector(selector);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  const html = ejs.render(fs.readFileSync(path.join(ROOT, "views/partials/emergency-workflow.ejs"), "utf8"), { userId, dashboard: true });
  const stack = [document.body];
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/?[\w-]+[^>]*>|[^<]+/g)) {
    const value = token[0];
    if (value.startsWith("<!--")) continue;
    if (value.startsWith("</")) { stack.pop(); continue; }
    if (value.startsWith("<")) {
      const [, tag, attrs] = /^<([\w-]+)([^>]*)>/.exec(value);
      const node = new Element(tag, document);
      for (const attr of attrs.matchAll(/([^\s=/>]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? "");
      stack.at(-1).appendChild(node);
      if (!["INPUT", "BR", "HR", "IMG", "META", "LINK"].includes(node.tagName)) stack.push(node);
    } else { stack.at(-1)._text += value; }
  }
  const logout = document.createElement("form");
  logout.setAttribute("action", "/logout");
  document.body.appendChild(logout);
  document.getElementById("reason").value = "Feeling unsafe";
  return document;
}

function response(status, data) { return { status, ok: status >= 200 && status < 300, json: async () => data }; }
function deferred() { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function history(statuses = ["TRIGGERED"]) {
  return response(200, { success: true, history: statuses.map((toStatus, index) => ({ emergency: EMERGENCY_ID, toStatus, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() })) });
}

function harness({ online = true, storage = new Map(), records = new Map(), userId = USER_ID, fetcher, confirm = true } = {}) {
  const document = makeDocument(userId);
  const windowEvents = new EventHub();
  const serviceWorker = new EventHub();
  const syncTags = [];
  serviceWorker.ready = Promise.resolve({ sync: { register: async (tag) => syncTags.push(tag) } });
  const socket = new EventHub();
  socket.on = socket.addEventListener.bind(socket);
  socket.off = socket.removeEventListener.bind(socket);
  socket.send = (payload) => { for (const listener of socket.listeners.get("emergency:updated") || []) listener(payload); };
  const requests = [];
  const navigator = { onLine: online, serviceWorker };
  const context = {
    document, navigator, console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      key: (index) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    },
    confirm: () => confirm,
    setTimeout, clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    ServiceWorkerRegistration: class {},
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (fetcher) return fetcher(url, options);
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8"), context, { filename: "public/app.js" });
  Object.assign(context.EC.offlineDB, {
    async saveCanonicalEmergency(record) { records.set(record.requestId, { ...record, retryCount: 0, lockAt: null }); return records.get(record.requestId); },
    async getCanonicalEmergency(id) { return records.has(id) ? { ...records.get(id) } : null; },
    async listCanonicalEmergencies() { return [...records.values()].map((record) => ({ ...record })); },
    async claimCanonicalEmergency(id) {
      const record = records.get(id);
      if (!record || (record.status === "syncing" && Date.now() - Date.parse(record.lockAt) < 30000)) return null;
      Object.assign(record, { status: "syncing", lockAt: new Date().toISOString(), retryCount: (record.retryCount || 0) + 1 });
      return { ...record };
    },
    async updateCanonicalEmergency(id, changes) { if (records.has(id)) Object.assign(records.get(id), changes); },
    async removeCanonicalEmergency(id) { records.delete(id); },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "public/emergency-workflow.js"), "utf8"), context, { filename: "public/emergency-workflow.js" });
  const ids = [];
  const workflow = context.EC.createEmergencyWorkflow({ socket, requestLocation: async () => {}, onEmergencyId: (id) => ids.push(id) });
  return {
    context, document, workflow, requests, records, storage, socket, serviceWorker, navigator, syncTags, ids,
    el: (id) => document.getElementById(id),
    step: (status) => document.querySelector(`[data-emergency-step="${status}"]`),
    async ready() { await workflow.initialize(); workflow.setLocation({ latitude: 0, longitude: 0, accuracy: 5 }); },
    socketState(status, updatedAt = "2026-01-02T00:00:00.000Z") { socket.send({ emergencyId: EMERGENCY_ID, status, updatedAt }); },
  };
}

function isHidden(element) { return element.hidden || element.classList.contains("hidden"); }
function assertCreationLocked(h, locked) {
  for (const id of ["level1Button", "level2Button", "level3Button", "reason", "msg"]) assert.equal(h.el(id).disabled, locked, `${id} lock`);
}

test("backend model accepts the three existing frontend type values without an enum change", async () => {
  for (const emergencyType of ["GENERAL", "SAFETY", "CRITICAL"]) {
    const model = new Emergency({ citizen: USER_ID, emergencyType, latitude: 0, longitude: 0 });
    await model.validate();
    assert.equal(model.status, "TRIGGERED");
  }
  assert.equal(Emergency.schema.path("emergencyType").enumValues.length, 0, "Types are accepted strings, not a server severity enum");
});

test("rapid double submission locks immediately, issues one UUID and POST, and stays locked while active", async () => {
  const pending = deferred();
  const h = harness({ fetcher: () => pending.promise });
  await h.ready();
  assertCreationLocked(h, false);
  const first = h.workflow.submit(3);
  assertCreationLocked(h, true);
  const second = h.workflow.submit(3);
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.records.size, 1);
  assert.match(h.el("emergencyFeedback").textContent + h.el("statusTextTop").textContent, /sending|submitt/i);
  const payload = JSON.parse(h.requests[0].body);
  assert.equal(payload.emergencyType, "CRITICAL");
  assert.equal(payload.latitude, 0, "Equator is a valid coordinate");
  assert.equal(payload.longitude, 0, "Prime meridian is a valid coordinate");
  assert.match(payload.clientRequestId, /^[a-f\d-]{36}$/);
  pending.resolve(response(201, { success: true, emergency: { id: EMERGENCY_ID, status: "TRIGGERED", clientRequestId: payload.clientRequestId } }));
  await Promise.all([first, second]);
  assert.match(h.el("statusTextTop").textContent, COPY.TRIGGERED);
  assert.equal(h.records.size, 0);
  assertCreationLocked(h, true);
  await h.workflow.submit(1);
  assert.equal(h.requests.length, 1);
});

test("GENERAL and SAFETY mappings and safety details use the existing canonical submission contract", async () => {
  for (const [level, type] of [[1, "GENERAL"], [2, "SAFETY"]]) {
    const h = harness({ fetcher: () => response(201, { success: true, emergency: { id: EMERGENCY_ID, status: "TRIGGERED" } }) });
    await h.ready();
    h.el("msg").value = "Near the entrance";
    await h.workflow.submit(level);
    const payload = JSON.parse(h.requests[0].body);
    assert.equal(payload.emergencyType, type);
    if (level === 2) {
      assert.match(payload.description, /Feeling unsafe/);
      assert.match(payload.description, /Near the entrance/);
    }
  }
});

test("permanent creation failure restores controls and clears only the request pointer", async () => {
  const h = harness({ fetcher: () => response(400, { error: "Invalid emergency details" }) });
  await h.ready();
  await h.workflow.submit(3);
  assertCreationLocked(h, false);
  assert.match(h.el("emergencyFeedback").textContent, /Invalid emergency details|could not|failed/i);
  assert.equal(h.storage.has(POINTER_KEY), false);
  const record = [...h.records.values()][0];
  assert.equal(record.status, "failed");
  assert.equal(record.latitude, null);
  assert.equal(record.longitude, null);
});

test("offline queue remains distinct from server creation and reconnect reuses the same clientRequestId", async () => {
  const h = harness({ online: false, fetcher: (url, options) => response(201, { success: true, emergency: { id: EMERGENCY_ID, status: "TRIGGERED", clientRequestId: JSON.parse(options.body).clientRequestId } }) });
  await h.ready();
  await h.workflow.submit(3);
  assert.equal(h.requests.length, 0);
  assert.equal(h.records.size, 1);
  assertCreationLocked(h, true);
  assert.match(h.el("statusTextTop").textContent + h.el("emergencyFeedback").textContent, /queued offline/i);
  assert.ok(isHidden(h.el("emergencyProgress")), "No canonical progress before server confirmation");
  assert.ok(h.syncTags.includes("sync-canonical-emergency"));
  const requestId = [...h.records.keys()][0];
  assert.equal(JSON.parse(h.storage.get(POINTER_KEY)).requestId, requestId);
  await h.workflow.submit(1);
  assert.equal(h.records.size, 1);
  h.navigator.onLine = true;
  await h.context.EC.refreshCanonicalEmergencyState();
  assert.equal(JSON.parse(h.requests[0].body).clientRequestId, requestId);
  assert.equal(h.records.size, 0);
  assert.match(h.el("statusTextTop").textContent, COPY.TRIGGERED);
});

test("temporary server failure keeps the original request queued and creation locked", async () => {
  const h = harness({ fetcher: () => response(503, { error: "Try later" }) });
  await h.ready();
  await h.workflow.submit(3);
  assertCreationLocked(h, true);
  assert.equal([...h.records.values()][0].status, "pending");
  assert.match(h.el("statusTextTop").textContent + h.el("emergencyFeedback").textContent, /queued|retry/i);
  assert.ok(isHidden(h.el("emergencyProgress")));
});

test("all seven server states share accessible rendering and exact citizen action permissions", async () => {
  for (const status of STATES) {
    const h = harness();
    await h.ready();
    h.socketState(status);
    assert.match(h.el("statusTextTop").textContent, COPY[status], status);
    assert.equal(h.step(status).getAttribute("aria-current"), "step", status);
    const canCancel = ["TRIGGERED", "SEARCHING_FOR_HELP", "RESPONDER_ASSIGNED", "RESPONDER_ON_WAY"].includes(status);
    assert.equal(isHidden(h.el("cancelEmergencyButton")), !canCancel, `${status} cancellation`);
    assert.equal(isHidden(h.el("resolveEmergencyButton")), status !== "HELP_REACHED", `${status} resolution`);
    assertCreationLocked(h, !["RESOLVED", "CANCELLED"].includes(status));
    assert.equal(h.el("statusTextTop").getAttribute("aria-live"), "polite");
    assert.equal(h.step(status).dataset.stepState, "current");
    if (status === "CANCELLED") {
      assert.equal(h.step("RESOLVED").dataset.stepState, "pending", "Cancellation is not successful completion");
      assert.equal(h.storage.has(POINTER_KEY), false);
    }
    if (status === "RESPONDER_ON_WAY") assert.equal(h.step("TRIGGERED").dataset.stepState, "pending", "Unobserved milestones must not be invented");
  }
});

test("late HTTP creation response cannot regress a newer Socket.IO emergency state", async () => {
  const pending = deferred();
  const h = harness({ fetcher: () => pending.promise });
  await h.ready();
  const submission = h.workflow.submit(3);
  await flush();
  h.socketState("RESPONDER_ASSIGNED");
  pending.resolve(response(201, { success: true, emergency: { id: EMERGENCY_ID, status: "TRIGGERED" } }));
  await submission;
  assert.match(h.el("statusTextTop").textContent, COPY.RESPONDER_ASSIGNED);
});

test("history recovery renders through the same workflow and does not regress newer socket updates", async () => {
  const storage = new Map([[POINTER_KEY, JSON.stringify({ emergencyId: EMERGENCY_ID, requestId: null })]]);
  const pending = deferred();
  let calls = 0;
  const h = harness({ storage, fetcher: () => ++calls === 1 ? history(["TRIGGERED", "SEARCHING_FOR_HELP"]) : pending.promise });
  await h.ready();
  assert.match(h.el("statusTextTop").textContent, COPY.SEARCHING_FOR_HELP);
  assert.equal(h.step("TRIGGERED").dataset.stepState, "recorded");
  assert.equal(h.requests[0].url, `/emergency/${EMERGENCY_ID}/history`);
  const recovery = h.workflow.recover();
  await flush();
  h.socketState("RESPONDER_ON_WAY");
  pending.resolve(history(["TRIGGERED", "SEARCHING_FOR_HELP"]));
  await recovery;
  assert.match(h.el("statusTextTop").textContent, COPY.RESPONDER_ON_WAY);
});

test("a failed cancellation remains active; successful cancellation clears recovery IDs", async () => {
  let fail = true;
  const h = harness({ fetcher: (url, options) => {
    if (options.method === "PATCH") return fail ? response(500, { error: "Cancellation unavailable" }) : response(200, { success: true, emergency: { _id: EMERGENCY_ID, status: "CANCELLED", updatedAt: "2026-01-03T00:00:00Z" } });
    return history(["TRIGGERED"]);
  } });
  await h.ready();
  h.socketState("TRIGGERED");
  await h.workflow.cancelEmergency();
  assert.match(h.el("statusTextTop").textContent, COPY.TRIGGERED);
  assert.match(h.el("emergencyFeedback").textContent, /Cancellation unavailable|cancel.*fail|could not.*cancel/i);
  assertCreationLocked(h, true);
  fail = false;
  await h.workflow.cancelEmergency();
  assert.match(h.el("statusTextTop").textContent, COPY.CANCELLED);
  assertCreationLocked(h, false);
  assert.equal(h.storage.has(POINTER_KEY), false);
  const patches = h.requests.filter((request) => request.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.equal(JSON.parse(patches[0].body).status, "CANCELLED");
});

test("cancellation requires confirmation and cannot be submitted after help has reached", async () => {
  const h = harness({ confirm: false });
  await h.ready();
  h.socketState("TRIGGERED");
  await h.workflow.cancelEmergency();
  assert.equal(h.requests.length, 0);
  h.socketState("HELP_REACHED", "2026-01-03T00:00:00Z");
  await h.workflow.cancelEmergency();
  assert.equal(h.requests.length, 0);
});

test("citizen resolution is exposed only from HELP_REACHED and uses the existing status API", async () => {
  const h = harness({ fetcher: () => response(200, { success: true, emergency: { _id: EMERGENCY_ID, status: "RESOLVED", updatedAt: "2026-01-04T00:00:00Z" } }) });
  await h.ready();
  h.socketState("TRIGGERED");
  await h.workflow.resolveEmergency();
  assert.equal(h.requests.length, 0);
  h.socketState("HELP_REACHED", "2026-01-03T00:00:00Z");
  await h.workflow.resolveEmergency();
  assert.equal(h.requests[0].url, `/emergency/${EMERGENCY_ID}/status`);
  assert.equal(JSON.parse(h.requests[0].body).status, "RESOLVED");
  assert.match(h.el("statusTextTop").textContent, COPY.RESOLVED);
});

test("search transitions only once and gives visible no-responder feedback", async () => {
  const h = harness({ fetcher: (url, options) => options.method === "PATCH"
    ? response(200, { success: true, emergency: { _id: EMERGENCY_ID, status: "SEARCHING_FOR_HELP", updatedAt: "2026-01-03T00:00:00Z" } })
    : response(200, { success: true, responders: [] }) });
  await h.ready();
  h.socketState("TRIGGERED");
  await h.workflow.searchNearbyResponders();
  assert.match(h.el("statusTextTop").textContent, COPY.SEARCHING_FOR_HELP);
  assert.match(h.el("nearbyResponders").textContent + h.el("emergencyFeedback").textContent, /no.*responder/i);
  await h.workflow.searchNearbyResponders();
  assert.equal(h.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.equal(h.requests.filter((request) => request.url.includes("nearby-responders")).length, 2);
});

test("active-emergency conflict does not invent a canonical status or unlock another SOS", async () => {
  const h = harness({ fetcher: () => response(409, { error: "You already have an active emergency request.", status: "TRIGGERED" }) });
  await h.ready();
  await h.workflow.submit(3);
  assertCreationLocked(h, true);
  assert.doesNotMatch(h.el("statusTextTop").textContent, /^Emergency sent$/i);
  assert.ok(isHidden(h.el("emergencyProgress")));
  assert.match(h.el("emergencyFeedback").textContent + h.el("statusTextLive").textContent, /active|original|another/i);
});

test("service-worker messages update only the matching request in the same shared renderer", async () => {
  const h = harness({ online: false });
  await h.ready();
  await h.workflow.submit(3);
  const requestId = [...h.records.keys()][0];
  h.serviceWorker.dispatchEvent({ type: "message", data: { type: "canonical-emergency-status", status: "synced", requestId: REQUEST_ID, emergency: { id: EMERGENCY_ID, status: "TRIGGERED" } } });
  assert.ok(isHidden(h.el("emergencyProgress")));
  h.serviceWorker.dispatchEvent({ type: "message", data: { type: "canonical-emergency-status", status: "synced", requestId, emergency: { id: EMERGENCY_ID, status: "TRIGGERED" } } });
  assert.match(h.el("statusTextTop").textContent, COPY.TRIGGERED);
});

test("recovery pointers contain only IDs, are user-scoped, and are cleared on logout", async () => {
  const storage = new Map();
  const h = harness({ storage });
  await h.ready();
  h.socketState("TRIGGERED");
  const pointer = JSON.parse(storage.get(POINTER_KEY));
  assert.equal(pointer.emergencyId, EMERGENCY_ID);
  assert.ok(Object.keys(pointer).every((key) => ["emergencyId", "requestId"].includes(key)));
  const otherUser = harness({ storage, userId: "aaaaaaaaaaaaaaaaaaaaaaaa" });
  await otherUser.ready();
  assert.equal(otherUser.requests.length, 0);
  assertCreationLocked(otherUser, false);
  h.document.querySelector('form[action="/logout"]').dispatchEvent({ type: "submit" });
  assert.equal(storage.has(POINTER_KEY), false);
});

test("reload of a pending offline request locks creation without reading unrelated queue entries", async () => {
  const storage = new Map([[POINTER_KEY, JSON.stringify({ emergencyId: null, requestId: REQUEST_ID })]]);
  const records = new Map([[REQUEST_ID, { requestId: REQUEST_ID, emergencyType: "CRITICAL", latitude: 0, longitude: 0, status: "pending", retryCount: 0 }]]);
  const h = harness({ online: false, storage, records });
  await h.ready();
  assertCreationLocked(h, true);
  assert.match(h.el("statusTextTop").textContent + h.el("emergencyFeedback").textContent, /queued offline/i);
  assert.equal(h.requests.length, 0);
});

test("missing queue record after background sync is reported as unconfirmed, not as success", async () => {
  const storage = new Map([[POINTER_KEY, JSON.stringify({ emergencyId: null, requestId: REQUEST_ID })]]);
  const h = harness({ storage });
  await h.ready();
  assertCreationLocked(h, true);
  assert.ok(isHidden(h.el("emergencyProgress")));
  assert.match(h.el("statusTextTop").textContent + h.el("statusTextLive").textContent + h.el("emergencyFeedback").textContent, /confirm|recover|unknown|unavailable/i);
  assert.equal(h.requests.length, 0, "No invented active-emergency lookup endpoint");
});

test("location failure explains permission and keeps SOS disabled until valid coordinates are available", async () => {
  const h = harness();
  await h.workflow.initialize();
  h.workflow.setLocationUnavailable({ code: 1, message: "Permission denied" });
  for (const id of ["level1Button", "level2Button", "level3Button"]) assert.equal(h.el(id).disabled, true);
  assert.match(h.el("sosLocationStatus").textContent, /location|permission/i);
  assert.equal(h.el("retryLocationButton").disabled, false);
  h.workflow.setLocation({ latitude: 0, longitude: 0, accuracy: 5 });
  assertCreationLocked(h, false);
});

test("citizen dashboard and SOS both integrate the same workflow without duplicate DOM contracts", () => {
  const required = ["emergencyWorkflow", "level1Button", "level2Button", "level3Button", "reason", "msg", "statusTextTop", "statusTextLive", "cancelEmergencyButton", "searchRespondersButton", "nearbyResponders"];
  for (const filename of ["dashboard.ejs", "sos.ejs"]) {
    const fullPath = path.join(ROOT, "views", filename);
    const source = fs.readFileSync(fullPath, "utf8");
    assert.match(source, /include\(['"]partials\/emergency-workflow['"]/);
    assert.match(source, /emergency-workflow\.js/);
    for (const role of ["citizen", "police"]) {
      const rendered = ejs.render(source, { title: "UI test", isLoggedIn: true, userRole: role, userId: USER_ID, userName: "Citizen", user: { _id: USER_ID, name: "Citizen", role, phone: "5550000" } }, { filename: fullPath });
      for (const id of required) assert.equal((rendered.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, role === "citizen" ? 1 : 0, `${filename} ${role} ${id}`);
      for (const script of rendered.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        if (!/\bsrc=/.test(script[1]) && script[2].trim()) new vm.Script(script[2], { filename: `${filename} inline` });
      }
      for (const label of rendered.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["'][^>]*>/g)) assert.match(rendered, new RegExp(`id=["']${label[1]}["']`));
    }
  }
});
