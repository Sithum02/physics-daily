// Offline support for the app's own files (so it opens instantly).
// Database requests (Supabase) are never cached — marks and questions are always live.
// Bump VERSION whenever app code (js/, *.css, index.html) changes so phones pick it up.
const VERSION = "v16";
const SHELL = `shell-${VERSION}`;
const SHELL_FILES = [
  "./", "index.html", "styles.css", "app.css", "light.css", "js/app.js", "js/ui.js", "js/admin.js", "js/config.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/phy.svg", "icons/chem.svg", "icons/phy-192.png", "icons/chem-192.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"
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

  // App files: always try the network first so a new version shows up immediately;
  // the cached copy is only used when offline. Fonts / libraries: cache first.
  const save = (res) => { if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); } return res; };
  e.respondWith(ours
    ? fetch(e.request, { cache: "no-cache" }).then(save).catch(() => caches.match(e.request, { ignoreSearch: true }))
    : caches.match(e.request).then((hit) => hit || fetch(e.request).then(save)));
});

// ---------- Push reminders ----------
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "සත්කාර", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "සත්කාර", {
    body: d.body || "", icon: d.icon || "icons/icon-192.png", badge: "icons/icon-192.png",
    tag: d.tag || "satkara", data: { url: d.url || "./" }   // one tag per subject, so Physics and Chemistry don't replace each other
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ("focus" in c) { if ("navigate" in c) c.navigate(target).catch(() => {}); return c.focus(); }
    }
    return clients.openWindow(target);
  }));
});
