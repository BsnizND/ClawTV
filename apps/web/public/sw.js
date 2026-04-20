const cacheVersion = new URL(self.location.href).searchParams.get("v") || "dev";
const shellCache = `clawtv-shell-${cacheVersion}`;
const shellPaths = [
  "./",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(shellCache).then((cache) => cache.addAll(shellPaths))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== shellCache)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const isNavigationRequest = event.request.mode === "navigate"
    || event.request.headers.get("accept")?.includes("text/html");

  if (requestUrl.pathname.includes("/api/")) {
    return;
  }

  if (isNavigationRequest) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const cloned = response.clone();
          void caches.open(shellCache).then((cache) => cache.put(event.request, cloned));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request).then((response) => {
        const cloned = response.clone();
        void caches.open(shellCache).then((cache) => cache.put(event.request, cloned));
        return response;
      });
    })
  );
});
