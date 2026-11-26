self.addEventListener("install", (e) =>
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys())
        if (k.startsWith("bonfire-") && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (
    e.request.method !== "GET" ||
    u.origin !== location.origin ||
    u.pathname.startsWith("/api/")
  )
    return;
  const path =
    e.request.mode === "navigate" && u.pathname === "/index.html"
      ? "/"
      : u.pathname;
  if (FILES.includes(path))
    e.respondWith(
      caches
        .open(CACHE)
        .then((c) => c.match(path))
        .then((v) => v || fetch(e.request)),
    );
});
