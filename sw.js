// Offline support for the app's own files (so it opens instantly).
// Database requests (Supabase) are never cached — marks and questions are always live.
// Bump VERSION whenever app code (js/, *.css, index.html) changes so phones pick it up.
const VERSION = "v3";
const SHELL = `shell-${VERSION}`;
const SHELL_FILES = [
  "./", "index.html", "styles.css", "app.css", "js/app.js", "js/ui.js", "js/admin.js", "js/config.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];
const CACHEABLE_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const ours = url.origin === location.origin;
  if (!ours && !CACHEABLE_HOSTS.includes(url.host)) return; // Supabase etc. → straight to network

  // Serve from cache, refresh the cache in the background
  e.respondWith(
    caches.match(e.request, { ignoreSearch: ours }).then((hit) => {
      const net = fetch(e.request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});

// ---------- Push reminders ----------
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "Physics Daily", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Physics Daily", {
    body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    tag: "physics-daily", data: { url: d.url || "./" }
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow(target);
  }));
});
