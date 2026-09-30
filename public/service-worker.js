/**
 * Service Worker for Emergency Chain PWA
 * Enables offline support, background sync, and caching strategies
 *
 * Cache Strategy:
 * - Network first for API calls (with fallback to cache)
 * - Cache first for static assets
 * - OSM tiles bypass the service worker and remain online-only
 */

const CACHE_NAME = "emergency-chain-v3";
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
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request));
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
  }
});

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
    const request = indexedDB.open("EmergencyChain", 1);

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
