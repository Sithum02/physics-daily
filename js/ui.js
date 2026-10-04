// ==========================================================
// Shared UI helpers
// ==========================================================
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// Answer options are numbered 1–5 like the A/L paper (statements inside questions use A, B, C)
export const LETTERS = ["1", "2", "3", "4", "5"];
// Chart colours, validated for colour-blind separation on the dark surface
export const SERIES = { you: "#d97706", avg: "#2563eb" };

// Subjects (keys match the database). Each section has its own icon and colours (light.css: body[data-subject]).
export const SUBJECTS = {
  phy: { key: "phy", name: "Physics", app: "Physics Daily", icon: "icons/phy.svg", emoji: "🔬", series: { you: "#d97706", avg: "#2563eb" } },
  chem: { key: "chem", name: "Chemistry", app: "Chemistry Daily", icon: "icons/chem.svg", emoji: "🧪", series: { you: "#047857", avg: "#7c3aed" } }
};
export const SUBJECT_KEYS = ["phy", "chem"];
export const isSubject = (s) => SUBJECT_KEYS.includes(s);

export const DISTRICTS = [
  "Ampara", "Anuradhapura", "Badulla", "Batticaloa", "Colombo", "Galle", "Gampaha", "Hambantota",
  "Jaffna", "Kalutara", "Kandy", "Kegalle", "Kilinochchi", "Kurunegala", "Mannar", "Matale",
  "Matara", "Monaragala", "Mullaitivu", "Nuwara Eliya", "Polonnaruwa", "Puttalam", "Ratnapura",
  "Trincomalee", "Vavuniya"
];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// x^{2} → superscript, v_{0} → subscript, **bold**, *italic*, new lines
export function fmt(s) {
  return esc(s)
    .replace(/\^\{([^}]*)\}/g, "<sup>$1</sup>")
    .replace(/_\{([^}]*)\}/g, "<sub>$1</sub>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/\n/g, "<br>");
}

export function fmtTime(sec) {
  if (sec == null) return "—";
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
export function parseDay(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
export function niceDay(s, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return parseDay(s).toLocaleDateString("en-GB", opts);
}
export function addDays(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const pctClass = (p) => (p >= 75 ? "good" : p >= 50 ? "mid" : "low");

// Sri Lankan NIC → 12-digit form or null (same rules as the database)
export function normalizeNic(p) {
  let s = String(p || "").toUpperCase().replace(/[\s-]/g, "");
  if (/^\d{9}[VX]$/.test(s)) s = "19" + s.slice(0, 5) + "0" + s.slice(5, 9);
  else if (!/^\d{12}$/.test(s)) return null;
  const y = +s.slice(0, 4);
  let d = +s.slice(4, 7);
  if (d > 500) d -= 500;
  if (d < 1 || d > 366) return null;
  if (y < 1960 || y > new Date().getFullYear() - 13) return null;
  return s;
}
export function normalizePhone(p) {
  let s = String(p || "").replace(/[\s-]/g, "");
  if (/^\+94\d{9}$/.test(s)) s = "0" + s.slice(3);
  if (/^94\d{9}$/.test(s)) s = "0" + s.slice(2);
  return /^0\d{9}$/.test(s) ? s : null;
}
export const maskNic = (n) => (n ? n.slice(0, 4) + "••••" + n.slice(-4) : "—");

// ---------- Toast ----------
let toastTimer;
export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

// ---------- Bottom sheet / dialog ----------
export function sheet(html) {
  const wrap = document.createElement("div");
  wrap.className = "sheet-backdrop";
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  document.body.appendChild(wrap);
  return { el: $(".sheet", wrap), close };
}
export function confirmBox(title, body, okText = "Yes", danger = false) {
  return new Promise((resolve) => {
    const { el, close } = sheet(`
      <h3>${esc(title)}</h3><p class="muted">${body}</p>
      <div class="sheet-btns">
        <button class="btn btn-ghost" data-no>Cancel</button>
        <button class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" data-yes>${esc(okText)}</button>
      </div>`);
    $("[data-no]", el).onclick = () => { close(); resolve(false); };
    $("[data-yes]", el).onclick = () => { close(); resolve(true); };
  });
}

// ---------- Charts ----------
// Line chart of percentages (0–100). series: [{ name, color, values: [number|null] }]
export function lineChart(el, labels, series) {
  el.innerHTML = "";
  el.classList.add("chart");
  if (!labels.length) { el.innerHTML = `<p class="muted">Nothing to show yet.</p>`; return; }

  if (series.length > 1) {
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    series.forEach((s) => {
      const item = document.createElement("span");
      const key = document.createElement("i");
      key.style.background = s.color;
      item.append(key, document.createTextNode(s.name));
      legend.appendChild(item);
    });
    el.appendChild(legend);
  }

  const W = 360, H = 200, L = 34, R = 40, T = 10, B = 28;
  const pw = W - L - R, ph = H - T - B, n = labels.length;
  const x = (i) => L + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
  const y = (v) => T + ph - (ph * v) / 100;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Marks in percent over time");
  const mk = (tag, a) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); svg.appendChild(e); return e; };

  [0, 50, 100].forEach((v) => {
    mk("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" });
    mk("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }).textContent = v + "%";
  });
  const step = Math.ceil(n / 5);
  labels.forEach((lab, i) => {
    if (i % step && i !== n - 1) return;
    mk("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "axis" }).textContent = lab;
  });

  series.forEach((s) => {
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i)},${y(v)}`;
      pen = true;
    });
    if (d) mk("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
    if (n <= 40) s.values.forEach((v, i) => { if (v != null) mk("circle", { cx: x(i), cy: y(v), r: 4, fill: s.color, class: "dot" }); });
    const last = s.values.map((v, i) => [v, i]).filter(([v]) => v != null).pop();
    if (last) mk("text", { x: x(last[1]) + 7, y: y(last[0]) + 4, class: "end-label" }).textContent = Math.round(last[0]) + "%";
  });

  const cross = mk("line", { y1: T, y2: T + ph, class: "crosshair", visibility: "hidden" });
  const hit = mk("rect", { x: L - 8, y: T, width: pw + 16, height: ph, fill: "transparent" });
  el.appendChild(svg);
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  el.appendChild(tip);

  const show = (i) => {
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    tip.innerHTML = "";
    const h = document.createElement("div"); h.className = "tip-title"; h.textContent = labels[i]; tip.appendChild(h);
    series.forEach((s) => {
      const row = document.createElement("div"); row.className = "tip-row";
      const key = document.createElement("i"); key.style.background = s.color;
      const val = document.createElement("b"); val.textContent = s.values[i] == null ? "—" : Math.round(s.values[i]) + "%";
      const nm = document.createElement("span"); nm.textContent = s.name;
      row.append(key, val, nm); tip.appendChild(row);
    });
    const box = svg.getBoundingClientRect();
    tip.style.left = Math.min(Math.max((x(i) / W) * box.width, 70), box.width - 70) + "px";
    tip.classList.add("show");
  };
  const pick = (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    show(Math.max(0, Math.min(n - 1, n === 1 ? 0 : Math.round(((sx - L) / pw) * (n - 1)))));
  };
  hit.addEventListener("pointermove", pick);
  hit.addEventListener("pointerdown", pick);
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.classList.remove("show"); });
}

// Horizontal accuracy bars: rows = [{ label, correct, total }]
export function barList(rows) {
  if (!rows.length) return `<p class="muted">Answer some questions to see this.</p>`;
  return `<div class="bars">${rows.map((r) => {
    const p = r.total ? Math.round((r.correct / r.total) * 100) : 0;
    return `<div class="bar-row">
      <div class="bar-top"><span>${esc(r.label)}</span><b>${p}% <small class="muted">(${r.correct}/${r.total})</small></b></div>
      <div class="bar-track"><div class="bar-fill ${pctClass(p)}" style="width:${p}%"></div></div>
    </div>`;
  }).join("")}</div>`;
}
