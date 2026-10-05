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
  constructor(dbName = "EmergencyChain", version = 1) {
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
}

const offlineDB = new OfflineDB();

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
    document.body.classList.remove("offline");
    document.body.classList.add("online");
  });

  socket.on("disconnect", () => {
    console.log("[Socket] Disconnected");
    document.body.classList.add("offline");
    document.body.classList.remove("online");
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

  // Dispatch custom event
  window.dispatchEvent(new CustomEvent("app-offline"));
});

// ========================================
// 7. EXPORTS
// ========================================

window.EC = {
  offlineDB,
  locationTracker,
  initializeSocket,
  registerEmergencyUpdateListener,
  showNotification,
  requestNotificationPermission,
};

console.log("[App] Emergency Chain initialized");
