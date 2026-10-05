/**
 * Service Worker for Emergency Chain PWA
 * Enables offline support, background sync, and caching strategies
 *
 * Cache Strategy:
 * - Network first for API calls (with fallback to cache)
 * - Cache first for static assets
 * - OSM tiles bypass the service worker and remain online-only
 */

const CACHE_NAME = "emergency-chain-v4";
const PRIVATE_API_PREFIXES = [
  "/api/",
  "/emergency/",
  "/nearby-users",
  "/update-location",
];
const OSM_TILE_HOSTS = new Set([
  "tile.openstreetmap.org",
  "a.tile.openstreetmap.org",
  "b.tile.openstreetmap.org",
  "c.tile.openstreetmap.org",
]);
const ASSETS_TO_CACHE = [
  "/",
  "/index.css",
  "/app.js",
  "/manifest.json",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/leaflet.js",
];

/**
 * Install: Cache essential assets
 */
self.addEventListener("install", (event) => {
  console.log("[Service Worker] Installing...");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Caching assets");
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn("[Service Worker] Some assets failed to cache", err);
      });
    }),
  );
  self.skipWaiting();
});

/**
 * Activate: Clean up old caches
 */
self.addEventListener("activate", (event) => {
  console.log("[Service Worker] Activating...");
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log("[Service Worker] Deleting old cache:", cacheName);
            return caches.delete(cacheName);
          }

          return removeOsmTiles(cacheName);
        }),
      );
    }),
  );
  self.clients.claim();
});

/**
 * Fetch: Implement caching strategy
 * - Network first for API calls
 * - Cache first for static assets
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") {
    return;
  }

  // Let the browser request OSM tiles directly; never intercept or cache them.
  if (isOsmTileRequest(request)) {
    return;
  }

  // API calls: Network first
  if (isPrivateApiRequest(url)) {
    event.respondWith(fetch(request));
  }
  // HTML must reflect the current authentication session.
  else if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
  }
  // Static assets: Cache first
  else {
    event.respondWith(cacheFirst(request));
  }
});

function isPrivateApiRequest(url) {
  return PRIVATE_API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/**
 * Network first strategy (API calls)
 */
function networkFirst(request) {
  return fetch(request)
    .then((response) => {
      if (!response || response.status !== 200 || response.type === "error") {
        return response;
      }
      // Cache successful responses
      return caches.open(CACHE_NAME).then((cache) => {
        cache.put(request, response.clone());
        return response;
      });
    })
    .catch(() => {
      // Return cached version if network fails
      return caches.match(request);
    });
}

function isOsmTileRequest(request) {
  const url = new URL(request.url);
  return url.protocol === "https:" && OSM_TILE_HOSTS.has(url.hostname);
}

async function removeOsmTiles(cacheName) {
  const cache = await caches.open(cacheName);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => isOsmTileRequest(request))
      .map((request) => cache.delete(request)),
  );
}

/**
 * Cache first strategy (Static assets)
 */
function cacheFirst(request) {
  return caches.match(request).then((response) => {
    if (response) {
      return response;
    }
    return fetch(request)
      .then((response) => {
        if (!response || response.status !== 200) {
          return response;
        }
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, response.clone());
          return response;
        });
      })
      .catch(() => {
        // Return offline page if both fail
        return caches.match("/offline.html");
      });
  });
}

/**
 * Background Sync: Sync pending data when back online
 */
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-sos") {
    event.waitUntil(syncPendingSOS());
  } else if (event.tag === "sync-location") {
    event.waitUntil(syncPendingLocations());
  } else if (event.tag === "sync-canonical-emergency") {
    event.waitUntil(syncPendingCanonicalEmergencies());
  }
});

async function notifyCanonicalClients(message) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ type: "canonical-emergency-status", ...message });
  }
}

function canonicalStoreRequest(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    openOfflineDB().then((db) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      operation(store, resolve, reject);
      transaction.onerror = () => reject(transaction.error);
    }, reject);
  });
}

async function claimCanonicalEmergency(requestId) {
  return canonicalStoreRequest(
    "canonical-emergencies",
    "readwrite",
    (store, resolve, reject) => {
      const request = store.get(requestId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) return resolve(null);
        if (
          record.status === "syncing" &&
          record.lockAt &&
          Date.now() - Date.parse(record.lockAt) < 30000
        ) {
          return resolve(null);
        }
        record.status = "syncing";
        record.lockAt = new Date().toISOString();
        record.retryCount = (record.retryCount || 0) + 1;
        const update = store.put(record);
        update.onerror = () => reject(update.error);
        update.onsuccess = () => resolve(record);
      };
    },
  );
}

async function updateCanonicalEmergency(requestId, updates) {
  return canonicalStoreRequest(
    "canonical-emergencies",
    "readwrite",
    (store, resolve, reject) => {
      const request = store.get(requestId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (!request.result) return resolve(null);
        const update = store.put({ ...request.result, ...updates });
        update.onerror = () => reject(update.error);
        update.onsuccess = () => resolve(update.result);
      };
    },
  );
}

async function removeCanonicalEmergency(requestId) {
  return canonicalStoreRequest(
    "canonical-emergencies",
    "readwrite",
    (store, resolve, reject) => {
      const request = store.delete(requestId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    },
  );
}

async function syncCanonicalRecord(record) {
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
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if ((response.status === 200 || response.status === 201) && data.success) {
      await removeCanonicalEmergency(record.requestId);
      await notifyCanonicalClients({
        status: "synced",
        requestId: record.requestId,
        emergency: data.emergency,
      });
      return;
    }

    if (
      response.status === 409 &&
      (data.idempotent === true ||
        data.emergency?.clientRequestId === record.requestId)
    ) {
      await removeCanonicalEmergency(record.requestId);
      await notifyCanonicalClients({
        status: "synced",
        requestId: record.requestId,
        emergency: data.emergency,
      });
      return;
    }

    if (response.status === 401) {
      await updateCanonicalEmergency(record.requestId, {
        status: "auth-required",
        lockAt: null,
        lastError: "Login required to send queued emergency",
      });
      await notifyCanonicalClients({
        status: "auth-required",
        requestId: record.requestId,
      });
      return;
    }

    if (response.status === 400 || response.status === 409) {
      await updateCanonicalEmergency(record.requestId, {
        status: response.status === 409 ? "conflict" : "failed",
        lockAt: null,
        lastError: data.error || "Emergency could not be sent",
        latitude: null,
        longitude: null,
        accuracy: null,
      });
      await notifyCanonicalClients({
        status: response.status === 409 ? "conflict" : "failed",
        requestId: record.requestId,
        error: data.error,
      });
      return;
    }

    if (response.status < 500) {
      await updateCanonicalEmergency(record.requestId, {
        status: "failed",
        lockAt: null,
        lastError: "Emergency could not be sent",
        latitude: null,
        longitude: null,
        accuracy: null,
      });
      await notifyCanonicalClients({
        status: "failed",
        requestId: record.requestId,
      });
      return;
    }

    throw new Error(`Canonical emergency server error: ${response.status}`);
  } catch (error) {
    const retryCount = record.retryCount || 1;
    if (retryCount >= 5) {
      await updateCanonicalEmergency(record.requestId, {
        status: "failed",
        lockAt: null,
        lastError: "Emergency could not be sent",
        latitude: null,
        longitude: null,
        accuracy: null,
      });
      await notifyCanonicalClients({
        status: "failed",
        requestId: record.requestId,
      });
      return;
    }

    await updateCanonicalEmergency(record.requestId, {
      status: "pending",
      lockAt: null,
      nextRetryAt: new Date(
        Date.now() + Math.min(300000, 1000 * 2 ** retryCount),
      ).toISOString(),
      lastError: "Network unavailable. Retrying later.",
    });
    throw error;
  }
}

async function syncPendingCanonicalEmergencies() {
  const db = await openOfflineDB();
  const records = await new Promise((resolve, reject) => {
    const request = db
      .transaction("canonical-emergencies", "readonly")
      .objectStore("canonical-emergencies")
      .getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || []);
  });

  for (const record of records) {
    if (record.status !== "pending") continue;
    if (record.nextRetryAt && Date.parse(record.nextRetryAt) > Date.now())
      continue;
    const claimed = await claimCanonicalEmergency(record.requestId);
    if (claimed) await syncCanonicalRecord(claimed);
  }
}

/**
 * Sync pending SOS alerts
 */
async function syncPendingSOS() {
  try {
    const db = await openOfflineDB();
    const pendingSOS = await db.getAllFromIndex("sos", "status", "pending");

    for (const sos of pendingSOS) {
      try {
        await fetch("/api/emergency/level" + sos.level, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: sos.lat,
            lng: sos.lng,
            reason: sos.reason,
            message: sos.message,
          }),
        });

        // Mark as synced
        sos.status = "synced";
        await db.put("sos", sos);
      } catch (err) {
        console.error("[Background Sync] Failed to sync SOS:", err);
      }
    }
  } catch (err) {
    console.error("[Background Sync] SOS sync failed:", err);
  }
}

/**
 * Sync pending locations
 */
async function syncPendingLocations() {
  try {
    const db = await openOfflineDB();
    const pendingLocations = await db.getAllFromIndex(
      "locations",
      "status",
      "pending",
    );

    for (const location of pendingLocations) {
      try {
        await fetch("/update-location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: location.lat,
            lng: location.lng,
          }),
        });

        location.status = "synced";
        await db.put("locations", location);
      } catch (err) {
        console.error("[Background Sync] Failed to sync location:", err);
      }
    }
  } catch (err) {
    console.error("[Background Sync] Location sync failed:", err);
  }
}

/**
 * Open IndexedDB
 */
function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("EmergencyChain", 2);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // SOS alerts store
      if (!db.objectStoreNames.contains("sos")) {
        const sosStore = db.createObjectStore("sos", { keyPath: "id" });
        sosStore.createIndex("status", "status", { unique: false });
      }

      // Locations store
      if (!db.objectStoreNames.contains("locations")) {
        const locStore = db.createObjectStore("locations", {
          keyPath: "id",
        });
        locStore.createIndex("status", "status", { unique: false });
      }

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
    };
  });
}

/**
 * Push Notifications
 */
self.addEventListener("push", (event) => {
  const data = event.data.json();

  const options = {
    body: data.body || "Emergency alert received",
    icon: "/icon-192x192.png",
    badge: "/badge-72x72.png",
    tag: "emergency-alert",
    requireInteraction: true,
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || "Emergency Chain",
      options,
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url === "/" && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow("/dashboard");
      }
    }),
  );
});
