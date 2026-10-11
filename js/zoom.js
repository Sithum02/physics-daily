// ==========================================================
// Zoom: the app itself never zooms (it feels like a native app), but any question diagram
// (img.qimg) opens full screen on tap, where it can be pinched, dragged and double-tapped.
// iOS Safari ignores user-scalable=no, so its pinch is blocked through the gesture events as well.
// ==========================================================
let viewer = null;   // the open viewer: { el, img, s, tx, ty, w, h }

export function lockZoom() {
  const stop = (e) => e.preventDefault();
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, stop, { passive: false });
  // Two-finger moves anywhere else (Android, older iOS); the viewer handles its own
  document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener("click", (e) => {
    const img = e.target.closest?.("img.qimg");
    if (img?.complete && img.naturalWidth) openViewer(img);
  });
  addEventListener("popstate", () => { if (viewer) closeViewer(false); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && viewer) closeViewer(); });
}

function openViewer(src) {
  if (viewer) return;
  const el = document.createElement("div");
  el.className = "zv";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Diagram");
  el.innerHTML = `<img draggable="false"><button class="zv-x" aria-label="Close">✕</button>
    <div class="zv-hint">Pinch or double-tap to zoom</div>`;
  const img = el.querySelector("img");
  img.src = src.currentSrc || src.src;
  img.alt = src.alt || "Diagram";
  // Fit the diagram to the screen (keeping its shape); zoom works on top of that size
  const W = innerWidth - 24, H = innerHeight - 120, fit = Math.min(W / src.naturalWidth, H / src.naturalHeight);
  const w = src.naturalWidth * fit, h = src.naturalHeight * fit;
  img.style.width = `${w}px`; img.style.height = `${h}px`;
  document.body.appendChild(el);
  document.body.classList.add("zv-open");
  viewer = { el, img, s: 1, tx: 0, ty: 0, w, h };
  history.pushState({ zv: 1 }, "");   // the phone's back button closes the viewer
  el.querySelector(".zv-x").addEventListener("click", () => closeViewer());
  gestures(el);
  requestAnimationFrame(() => el.classList.add("on"));
}

function closeViewer(back = true) {
  if (!viewer) return;
  viewer.el.remove();
  viewer = null;
  document.body.classList.remove("zv-open");
  if (back && history.state?.zv) history.back();
}

// ---------- pinch, drag and double-tap (pointer events, so it works for touch and mouse) ----------
function gestures(el) {
  const pts = new Map();
  let start = null;      // pinch/drag start: { s, tx, ty, mx, my, d }
  let tap = null;        // the current touch, to tell a tap from a drag
  let lastTap = 0;

  const centre = () => ({ x: innerWidth / 2, y: innerHeight / 2 });
  const apply = (anim) => {
    const v = viewer; if (!v) return;
    const mx = Math.max(0, (v.w * v.s - innerWidth) / 2 + 12), my = Math.max(0, (v.h * v.s - innerHeight) / 2 + 12);
    v.tx = Math.min(mx, Math.max(-mx, v.tx)); v.ty = Math.min(my, Math.max(-my, v.ty));
    v.img.classList.toggle("anim", !!anim);
    v.img.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
    el.classList.toggle("zoomed", v.s > 1.01);
  };
  // Zoom to scale s keeping the screen point (x, y) still
  const zoomAt = (s, x, y) => {
    const v = viewer, c = centre();
    const px = (x - c.x - v.tx) / v.s, py = (y - c.y - v.ty) / v.s;
    v.s = s; v.tx = x - c.x - s * px; v.ty = y - c.y - s * py;
  };
  const snapshot = () => {
    const [a, b] = [...pts.values()];
    const m = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
    start = { s: viewer.s, tx: viewer.tx, ty: viewer.ty, mx: m.x, my: m.y, d: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 };
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".zv-x")) return;
    el.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tap = pts.size === 1 ? { x: e.clientX, y: e.clientY, t: Date.now(), onImg: e.target === viewer.img } : null;
    snapshot();
  });
  el.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !viewer) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pts.values()];
    if (tap && Math.hypot(a.x - tap.x, a.y - tap.y) > 8) tap = null;
    const v = viewer;
    if (b && start.d) {
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.min(5, Math.max(1, start.s * Math.hypot(a.x - b.x, a.y - b.y) / start.d));
      // keep the point that was under the fingers under them
      const c = centre(), px = (start.mx - c.x - start.tx) / start.s, py = (start.my - c.y - start.ty) / start.s;
      v.s = s; v.tx = m.x - c.x - s * px; v.ty = m.y - c.y - s * py;
      apply(false);
    } else if (!b && v.s > 1) {
      v.tx = start.tx + a.x - start.mx; v.ty = start.ty + a.y - start.my;
      apply(false);
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size) { snapshot(); return; }
    if (!viewer) return;
    if (tap && Date.now() - tap.t < 300) {
      const now = Date.now();
      if (now - lastTap < 320) {                       // double-tap: zoom in there, or back out
        if (viewer.s > 1.01) { viewer.s = 1; viewer.tx = 0; viewer.ty = 0; } else zoomAt(2.5, tap.x, tap.y);
        apply(true); lastTap = 0;
      } else {
        lastTap = now;
        if (!tap.onImg && viewer.s <= 1.01) { const t = tap; setTimeout(() => { if (lastTap === now && viewer && !t.onImg) closeViewer(); }, 330); }
      }
    }
    if (viewer.s < 1.02) { viewer.s = 1; viewer.tx = 0; viewer.ty = 0; }
    apply(true);
    tap = null;
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("wheel", (e) => {                // mouse / trackpad (computers)
    e.preventDefault();
    zoomAt(Math.min(5, Math.max(1, viewer.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))), e.clientX, e.clientY);
    if (viewer.s <= 1.01) { viewer.s = 1; viewer.tx = 0; viewer.ty = 0; }
    apply(false);
  }, { passive: false });
}
