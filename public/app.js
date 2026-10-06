/**
 * Emergency Chain - Client Application
 * Handles PWA setup, offline support, and real-time updates
 */

// ========================================
// 1. SERVICE WORKER REGISTRATION
// ========================================

/**
 * Register service worker for offline support and caching
 */
async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.register(
        "/service-worker.js",
        { scope: "/" },
      );
      console.log("[PWA] Service Worker registered:", registration);

      // Check for updates periodically
      setInterval(() => {
        registration.update();
      }, 60000); // Check every minute

      if (navigator.onLine !== false) {
        refreshCanonicalEmergencyState();
      }
    } catch (err) {
      console.error("[PWA] Service Worker registration failed:", err);
    }
  }
}

// Register on page load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", registerServiceWorker);
} else {
  registerServiceWorker();
}

// ========================================
// 2. OFFLINE DATABASE (IndexedDB)
// ========================================

class OfflineDB {
  constructor(dbName = "EmergencyChain", version = 2) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
  }

  /**
   * Open or create database
   */
  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => {
        console.error("[IndexedDB] Open error:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log("[IndexedDB] Database opened");
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // SOS alerts store
        if (!db.objectStoreNames.contains("sos")) {
          const sosStore = db.createObjectStore("sos", { keyPath: "id" });
          sosStore.createIndex("status", "status", { unique: false });
          sosStore.createIndex("timestamp", "timestamp", { unique: false });
        }

        // Locations store
        if (!db.objectStoreNames.contains("locations")) {
          const locStore = db.createObjectStore("locations", { keyPath: "id" });
          locStore.createIndex("status", "status", { unique: false });
          locStore.createIndex("timestamp", "timestamp", { unique: false });
        }

        // Cache metadata
        if (!db.objectStoreNames.contains("cache")) {
          db.createObjectStore("cache", { keyPath: "key" });
        }

        if (!db.objectStoreNames.contains("canonical-emergencies")) {
          const emergencyStore = db.createObjectStore("canonical-emergencies", {
            keyPath: "requestId",
          });
          emergencyStore.createIndex("status", "status", { unique: false });
          emergencyStore.createIndex("queuedAt", "queuedAt", { unique: false });
        }

        console.log("[IndexedDB] Database upgraded");
      };
    });
  }

  /**
   * Save to IndexedDB
   */
  async save(storeName, data) {
    if (!this.db) await this.open();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.add({
        ...data,
        id: data.id || Date.now(),
        timestamp: data.timestamp || new Date().toISOString(),
      });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        console.log(`[IndexedDB] Saved to ${storeName}`);
        resolve(request.result);
      };
    });
  }

  /**
   * Get all pending items
   */
  async getPending(storeName) {
    if (!this.db) await this.open();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const index = store.index("status");
      const request = index.getAll("pending");

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  /**
   * Update item status
   */
  async updateStatus(storeName, id, status) {
    if (!this.db) await this.open();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const data = getRequest.result;
        if (data) {
          data.status = status;
          const updateRequest = store.put(data);
          updateRequest.onerror = () => reject(updateRequest.error);
          updateRequest.onsuccess = () => resolve(updateRequest.result);
        }
      };
    });
  }

  async saveCanonicalEmergency(data) {
    if (!this.db) await this.open();

    const record = {
      requestId: data.requestId,
      emergencyType: data.emergencyType,
      description: data.description || "",
      latitude: data.latitude,
      longitude: data.longitude,
      accuracy: data.accuracy ?? null,
      status: data.status || "pending",
      queuedAt: data.queuedAt || new Date().toISOString(),
      retryCount: data.retryCount || 0,
      lastError: data.lastError || null,
      nextRetryAt: data.nextRetryAt || null,
      lockAt: null,
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(
        "canonical-emergencies",
        "readwrite",
      );
      const request = transaction
        .objectStore("canonical-emergencies")
        .put(record);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(record);
    });
  }

  async getCanonicalEmergency(requestId) {
    if (!this.db) await this.open();

    return new Promise((resolve, reject) => {
      const request = this.db
        .transaction("canonical-emergencies", "readonly")
        .objectStore("canonical-emergencies")
        .get(requestId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async listCanonicalEmergencies() {
    if (!this.db) await this.open();

    return new Promise((resolve, reject) => {
      const request = this.db
        .transaction("canonical-emergencies", "readonly")
        .objectStore("canonical-emergencies")
        .getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  async claimCanonicalEmergency(requestId) {
    if (!this.db) await this.open();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(
        "canonical-emergencies",
        "readwrite",
      );
      const store = transaction.objectStore("canonical-emergencies");
      const request = store.get(requestId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) {
          resolve(null);
          return;
        }

        if (
          record.status === "syncing" &&
          record.lockAt &&
          Date.now() - Date.parse(record.lockAt) < 30000
        ) {
          resolve(null);
          return;
        }

        record.status = "syncing";
        record.lockAt = new Date().toISOString();
        record.retryCount = (record.retryCount || 0) + 1;
        const updateRequest = store.put(record);
        updateRequest.onerror = () => reject(updateRequest.error);
        updateRequest.onsuccess = () => resolve(record);
      };
    });
  }

  async updateCanonicalEmergency(requestId, updates) {
    if (!this.db) await this.open();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(
        "canonical-emergencies",
        "readwrite",
      );
      const store = transaction.objectStore("canonical-emergencies");
      const request = store.get(requestId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (!request.result) {
          resolve(null);
          return;
        }
        const updateRequest = store.put({ ...request.result, ...updates });
        updateRequest.onerror = () => reject(updateRequest.error);
        updateRequest.onsuccess = () => resolve(updateRequest.result);
      };
    });
  }

  async removeCanonicalEmergency(requestId) {
    if (!this.db) await this.open();

    return new Promise((resolve, reject) => {
      const request = this.db
        .transaction("canonical-emergencies", "readwrite")
        .objectStore("canonical-emergencies")
        .delete(requestId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

const offlineDB = new OfflineDB();

let canonicalSyncPromise = null;
const CANONICAL_MAX_RETRIES = 5;
let socketConnectionState = "disconnected";

function dispatchConnectionState() {
  window.dispatchEvent(
    new CustomEvent("app-connection-state", {
      detail: {
        network: navigator.onLine === false ? "offline" : "online",
        socket: socketConnectionState,
      },
    }),
  );
}

function generateCanonicalRequestId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function dispatchCanonicalEmergencyStatus(status, detail = {}) {
  window.dispatchEvent(
    new CustomEvent("canonical-emergency-status", {
      detail: { status, ...detail },
    }),
  );
}

async function registerCanonicalEmergencySync() {
  if (!("serviceWorker" in navigator)) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.sync?.register) return false;
    await registration.sync.register("sync-canonical-emergency");
    return true;
  } catch (error) {
    console.warn("[Canonical SOS] Background Sync unavailable:", error);
    return false;
  }
}

async function handleCanonicalSyncResponse(record, response, data) {
  if ((response.status === 200 || response.status === 201) && data?.success) {
    await offlineDB.removeCanonicalEmergency(record.requestId);
    dispatchCanonicalEmergencyStatus("synced", {
      requestId: record.requestId,
      emergency: data.emergency,
    });
    return { state: "synced", data };
  }

  if (response.status === 401) {
    await offlineDB.updateCanonicalEmergency(record.requestId, {
      status: "auth-required",
      lockAt: null,
      lastError: "Login required to send queued emergency",
    });
    dispatchCanonicalEmergencyStatus("auth-required", {
      requestId: record.requestId,
    });
    return { state: "auth-required", data };
  }

  if (response.status === 400) {
    await offlineDB.updateCanonicalEmergency(record.requestId, {
      status: "failed",
      lockAt: null,
      lastError: data?.error || "Emergency could not be sent",
      latitude: null,
      longitude: null,
      accuracy: null,
    });
    dispatchCanonicalEmergencyStatus("failed", {
      requestId: record.requestId,
      error: data?.error,
    });
    return { state: "failed", data };
  }

  if (
    response.status === 409 &&
    (data?.idempotent === true ||
      data?.clientRequestId === record.requestId ||
      data?.emergency?.clientRequestId === record.requestId)
  ) {
    await offlineDB.removeCanonicalEmergency(record.requestId);
    dispatchCanonicalEmergencyStatus("synced", {
      requestId: record.requestId,
      emergency: data.emergency,
    });
    return { state: "synced", data };
  }

  if (response.status === 409) {
    await offlineDB.updateCanonicalEmergency(record.requestId, {
      status: "conflict",
      lockAt: null,
      lastError: data?.error || "Another active emergency already exists",
      latitude: null,
      longitude: null,
      accuracy: null,
    });
    dispatchCanonicalEmergencyStatus("conflict", {
      requestId: record.requestId,
      error: data?.error,
    });
    return { state: "conflict", data };
  }

  if (response.status >= 500) {
    throw new Error(`Canonical emergency server error: ${response.status}`);
  }

  await offlineDB.updateCanonicalEmergency(record.requestId, {
    status: "failed",
    lockAt: null,
    lastError: data?.error || "Emergency could not be sent",
    latitude: null,
    longitude: null,
    accuracy: null,
  });
  dispatchCanonicalEmergencyStatus("failed", {
    requestId: record.requestId,
    error: data?.error,
  });
  return { state: "failed", data };
}

async function syncCanonicalEmergency(requestId) {
  if (navigator.onLine === false) {
    return { state: "queued" };
  }

  const current = await offlineDB.getCanonicalEmergency(requestId);
  if (!current) return { state: "synced" };
  if (
    current.nextRetryAt &&
    Date.parse(current.nextRetryAt) > Date.now() &&
    current.status !== "auth-required"
  ) {
    return { state: "queued" };
  }

  const record = await offlineDB.claimCanonicalEmergency(requestId);
  if (!record) return { state: "syncing" };

  dispatchCanonicalEmergencyStatus("syncing", { requestId });
  try {
    const response = await fetch("/trigger-sos", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientRequestId: record.requestId,
        emergencyType: record.emergencyType,
        description: record.description,
        latitude: record.latitude,
        longitude: record.longitude,
        accuracy: record.accuracy,
      }),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    // Await so server-response failures reach the existing retry/backoff handler.
    return await handleCanonicalSyncResponse(record, response, data);
  } catch (error) {
    const retryCount = record.retryCount || 1;
    const shouldRetry = retryCount < CANONICAL_MAX_RETRIES;
    const updates = shouldRetry
      ? {
          status: "pending",
          lockAt: null,
          nextRetryAt: new Date(
            Date.now() + Math.min(300000, 1000 * 2 ** retryCount),
          ).toISOString(),
          lastError: "Network unavailable. Retrying later.",
        }
      : {
          status: "failed",
          lockAt: null,
          lastError: "Emergency could not be sent",
          latitude: null,
          longitude: null,
          accuracy: null,
        };
    await offlineDB.updateCanonicalEmergency(record.requestId, updates);
    dispatchCanonicalEmergencyStatus(shouldRetry ? "queued" : "failed", {
      requestId: record.requestId,
      error: error.message,
    });
    return { state: shouldRetry ? "queued" : "failed", error };
  }
}

async function syncCanonicalEmergencyQueue() {
  if (navigator.onLine === false) return;
  if (canonicalSyncPromise) return canonicalSyncPromise;

  canonicalSyncPromise = (async () => {
    const records = await offlineDB.listCanonicalEmergencies();
    const eligible = records.filter((record) =>
      ["pending", "auth-required"].includes(record.status),
    );
    for (const record of eligible) {
      await syncCanonicalEmergency(record.requestId);
    }
  })().finally(() => {
    canonicalSyncPromise = null;
  });

  return canonicalSyncPromise;
}

async function createCanonicalEmergency({
  emergencyType,
  description,
  latitude,
  longitude,
  accuracy,
  onStatus,
  onRequestId,
}) {
  const requestId = generateCanonicalRequestId();
  const payload = {
    requestId,
    emergencyType,
    description: description || "",
    latitude,
    longitude,
    accuracy: accuracy ?? null,
    status: "pending",
    queuedAt: new Date().toISOString(),
  };

  await offlineDB.saveCanonicalEmergency(payload);
  // Let the workflow retain this queue identity for reload recovery.
  onRequestId?.(requestId);
  const reportStatus = (status) => onStatus?.(status);

  if (navigator.onLine === false) {
    await registerCanonicalEmergencySync();
    reportStatus("queued");
    dispatchCanonicalEmergencyStatus("queued", { requestId });
    return { state: "queued", requestId };
  }

  reportStatus("syncing");
  const result = await syncCanonicalEmergency(requestId);
  if (result.state === "synced") {
    reportStatus("synced");
  } else if (result.state === "auth-required") {
    reportStatus("auth-required");
  } else if (result.state === "failed" || result.state === "conflict") {
    reportStatus("failed");
  } else if (result.state === "queued") {
    await registerCanonicalEmergencySync();
    reportStatus("queued");
  }
  return { ...result, requestId };
}

function refreshCanonicalEmergencyState() {
  return syncCanonicalEmergencyQueue().catch((error) => {
    console.warn("[Canonical SOS] Queue refresh failed:", error);
  });
}

// ========================================
// 3. GEOLOCATION & LOCATION TRACKING
// ========================================

class LocationTracker {
  constructor() {
    this.tracking = false;
    this.interval = null;
    this.updateFrequency = 10000; // 10 seconds
    this.socket = null;
  }

  /**
   * Request location permission
   */
  async requestPermission() {
    if ("permissions" in navigator) {
      try {
        const result = await navigator.permissions.query({
          name: "geolocation",
        });
        return result.state === "granted";
      } catch (err) {
        console.error("[Location] Permission query failed:", err);
        return false;
      }
    }
    return false;
  }

  /**
   * Get current location
   */
  getCurrentLocation() {
    return new Promise((resolve, reject) => {
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            resolve({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              timestamp: new Date(),
            });
          },
          (error) => {
            console.error("[Location] Geolocation error:", error);
            reject(error);
          },
          {
            timeout: 10000,
            enableHighAccuracy: true,
          },
        );
      } else {
        reject(new Error("Geolocation not supported"));
      }
    });
  }

  /**
   * Start continuous location tracking
   */
  async startTracking(socket) {
    if (this.tracking) return;

    this.socket = socket;
    this.tracking = true;

    console.log("[Location] Starting tracking...");

    this.interval = setInterval(async () => {
      try {
        const location = await this.getCurrentLocation();

        // Send to server if online
        if (navigator.onLine) {
          try {
            await fetch("/update-location", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(location),
            });

            // Emit via socket
            if (this.socket && this.socket.connected) {
              this.socket.emit("location-update", location);
            }
          } catch (err) {
            console.error("[Location] Update failed:", err);
            // Save locally for sync later
            await offlineDB.save("locations", {
              ...location,
              status: "pending",
            });
          }
        } else {
          // Offline: save locally
          await offlineDB.save("locations", {
            ...location,
            status: "pending",
          });
          console.log("[Location] Saved offline");
        }
      } catch (err) {
        console.error("[Location] Tracking error:", err);
      }
    }, this.updateFrequency);
  }

  /**
   * Stop location tracking
   */
  stopTracking() {
    if (this.interval) {
      clearInterval(this.interval);
      this.tracking = false;
      console.log("[Location] Tracking stopped");
    }
  }
}

const locationTracker = new LocationTracker();

// ========================================
// 4. SOCKET.IO REAL-TIME UPDATES
// ========================================

/**
 * Initialize Socket.io connection
 */
function initializeSocket() {
  if (!("io" in window)) {
    console.warn("[Socket] Socket.io not loaded");
    return null;
  }

  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
  });

  socket.on("connect", () => {
    console.log("[Socket] Connected:", socket.id);
    socketConnectionState = "connected";
    document.body.classList.remove("offline");
    document.body.classList.add("online");
    dispatchConnectionState();
    refreshCanonicalEmergencyState();
    window.dispatchEvent(new CustomEvent("app-socket-connected"));
  });

  socket.on("disconnect", () => {
    console.log("[Socket] Disconnected");
    socketConnectionState = "disconnected";
    document.body.classList.add("offline");
    document.body.classList.remove("online");
    dispatchConnectionState();
  });

  socket.on("connect_error", () => {
    socketConnectionState = "reconnecting";
    dispatchConnectionState();
  });

  socket.on("sos-level-1", (data) => {
    console.log("[Socket] Level 1 SOS:", data);
    showNotification("🚨 Emergency Alert", data.reason || "Emergency level 1");
  });

  socket.on("sos-level-2", (data) => {
    console.log("[Socket] Level 2 SOS:", data);
    showNotification("🔔 Help Needed", data.reason || "Emergency level 2");
  });

  socket.on("sos-level-3", (data) => {
    console.log("[Socket] Level 3 CRITICAL SOS:", data);
    showNotification(
      "🚨 CRITICAL EMERGENCY",
      `${data.userName} needs immediate help at location`,
    );
  });

  socket.on("alert-accepted", (data) => {
    console.log("[Socket] Alert accepted:", data);
  });

  socket.on("alert-cancelled", (data) => {
    console.log("[Socket] Alert cancelled:", data);
  });

  return socket;
}

function registerEmergencyUpdateListener(socket, handler) {
  if (!socket || typeof handler !== "function") return;

  socket.off("emergency:updated", handler);
  socket.on("emergency:updated", handler);
}

// ========================================
// 5. NOTIFICATIONS
// ========================================

/**
 * Show desktop notification
 */
async function showNotification(title, options = {}) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, {
        icon: "/icon-192x192.png",
        badge: "/badge-72x72.png",
        ...options,
      });
    } catch (err) {
      console.error("[Notification] Failed:", err);
    }
  }
}

/**
 * Request notification permission
 */
async function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

// ========================================
// 6. ONLINE/OFFLINE HANDLERS
// ========================================

/**
 * Handle online event
 */
window.addEventListener("online", async () => {
  console.log("[App] Back online!");
  document.body.classList.remove("offline");
  document.body.classList.add("online");
  dispatchConnectionState();

  // Trigger background sync
  if (
    "serviceWorker" in navigator &&
    "sync" in ServiceWorkerRegistration.prototype
  ) {
    const registration = await navigator.serviceWorker.ready;
    registration.sync.register("sync-sos");
    registration.sync.register("sync-location");
    console.log("[App] Background sync registered");
  }

  refreshCanonicalEmergencyState();

  // Dispatch custom event
  window.dispatchEvent(new CustomEvent("app-online"));
});

/**
 * Handle offline event
 */
window.addEventListener("offline", () => {
  console.log("[App] Gone offline!");
  document.body.classList.add("offline");
  document.body.classList.remove("online");
  dispatchConnectionState();

  // Dispatch custom event
  window.dispatchEvent(new CustomEvent("app-offline"));
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && navigator.onLine !== false) {
    refreshCanonicalEmergencyState();
  }
});

// ========================================
// 7. EXPORTS
// ========================================

window.EC = {
  offlineDB,
  locationTracker,
  initializeSocket,
  registerEmergencyUpdateListener,
  createCanonicalEmergency,
  syncCanonicalEmergencyQueue,
  refreshCanonicalEmergencyState,
  registerCanonicalEmergencySync,
  showNotification,
  requestNotificationPermission,
  getConnectionState: () => ({
    network: navigator.onLine === false ? "offline" : "online",
    socket: socketConnectionState,
  }),
};

console.log("[App] Emergency Chain initialized");
