// ==========================================================
// Physics Daily — Sithum De Zoysa
// Questions live in data/days/<date>.json, listed in data/index.json.
// A day only appears once its date has arrived (so days can be scheduled ahead).
// Progress is saved on the student's phone (localStorage) — no login.
// ==========================================================

const LETTERS = ["A", "B", "C", "D", "E"];
const STORE_KEY = "physics-daily-v1";
const app = document.getElementById("app");

// ---------- Storage ----------
const state = loadState();
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.answers) return { active: [], tipClosed: false, ...s };
  } catch { /* storage unavailable */ }
  return { answers: {}, active: [], tipClosed: false };
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

// ---------- Helpers ----------
const pad = (n) => String(n).padStart(2, "0");
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function niceDate(s) { return parseDate(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// x^{2} → superscript, v_{0} → subscript, **bold**, *italic*, new lines
function fmt(s) {
  return esc(s)
    .replace(/\^\{([^}]*)\}/g, "<sup>$1</sup>")
    .replace(/_\{([^}]*)\}/g, "<sub>$1</sub>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/\n/g, "<br>");
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------- Data ----------
let index = null;
const dayCache = {};

async function loadIndex() {
  try {
    const r = await fetch("data/index.json", { cache: "no-cache" });
    index = await r.json();
  } catch {
    index = index || { days: [] };
    toast("You're offline. Showing saved questions.");
  }
  const t = todayStr();
  index.released = index.days.filter((d) => d.date <= t).sort((a, b) => b.date.localeCompare(a.date));
}

async function loadDay(date) {
  if (dayCache[date]) return dayCache[date];
  const r = await fetch(`data/days/${date}.json`, { cache: "no-cache" });
  if (!r.ok) throw new Error("not found");
  return (dayCache[date] = await r.json());
}

// ---------- Progress ----------
function dayProgress(date, total) {
  let done = 0, right = 0;
  for (const id in state.answers) {
    if (id.startsWith(date + "-")) { done++; if (state.answers[id].ok) right++; }
  }
  return { done: Math.min(done, total), right, total };
}

function stats() {
  const all = Object.values(state.answers);
  const right = all.filter((a) => a.ok).length;
  return {
    answered: all.length,
    accuracy: all.length ? Math.round((right / all.length) * 100) : null,
    streak: streak(),
    wrong: all.length - right
  };
}

function streak() {
  const days = new Set(state.active);
  const d = new Date();
  if (!days.has(todayStr())) d.setDate(d.getDate() - 1); // today not done yet → count up to yesterday
  let n = 0;
  while (days.has(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function topicList(t) {
  if (!t?.length) return "";
  return " · " + esc(t.length > 3 ? t.slice(0, 3).join(", ") + " +" + (t.length - 3) : t.join(", "));
}

function scorePill(p) {
  if (!p.done) return `<span class="pill new">New</span>`;
  if (p.done < p.total) return `<span class="pill">${p.done}/${p.total}</span>`;
  const pct = p.right / p.total;
  return `<span class="pill ${pct >= .75 ? "good" : pct >= .5 ? "mid" : "low"}">${p.right}/${p.total}</span>`;
}

// ---------- Router ----------
window.addEventListener("hashchange", route);
async function route() {
  const [view, a, b] = location.hash.slice(1).split("/");
  window.scrollTo(0, 0);
  try {
    if (view === "day") await renderQuestion(a, b == null ? null : +b);
    else if (view === "done") await renderFinish(a);
    else if (view === "mistakes") await renderMistakes();
    else renderHome();
  } catch {
    app.innerHTML = `<div class="wrap"><div class="empty">Couldn't load these questions. Check your internet and try again.<br><br>
      <a class="btn btn-ghost btn-sm" href="#">← Home</a></div></div>`;
  }
}

// ---------- Home ----------
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; if (!location.hash) renderHome(); });

function installTip() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone || state.tipClosed) return "";
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (installEvent) {
    return `<div class="tip"><span>📲</span><span><b>Install the app</b> for one-tap access from your home screen.<br><br>
      <button class="btn btn-primary btn-sm" id="installBtn">Install</button></span><button class="close" data-close-tip aria-label="Close">×</button></div>`;
  }
  if (ios) {
    return `<div class="tip"><span>📲</span><span><b>Add to Home Screen:</b> tap the <b>Share</b> button in Safari, then <b>"Add to Home Screen"</b>.</span>
      <button class="close" data-close-tip aria-label="Close">×</button></div>`;
  }
  return "";
}

function renderHome() {
  const days = index.released;
  const s = stats();
  const latest = days[0];

  let hero = `<div class="hero"><span class="label">Daily questions</span><h1>No questions yet</h1><p>New questions are coming soon. Check back later!</p></div>`;
  if (latest) {
    const p = dayProgress(latest.date, latest.count);
    const isToday = latest.date === todayStr();
    const btn = p.done === 0 ? "Start →" : p.done < p.total ? "Continue →" : "See results";
    const href = p.done >= p.total ? `#done/${latest.date}` : `#day/${latest.date}`;
    hero = `
      <div class="hero">
        <span class="label">${isToday ? "Today's questions" : "Latest questions"} · ${esc(niceDate(latest.date))}</span>
        <h1>${esc(latest.title || "Daily MCQs")}</h1>
        <p>${latest.count} questions${topicList(latest.topics)}</p>
        <div class="bar"><div style="width:${(p.done / p.total) * 100}%"></div></div>
        <div class="row"><span class="count">${p.done >= p.total ? `Score ${p.right}/${p.total}` : `${p.done}/${p.total} done`}</span>
          <a class="btn btn-primary" href="${href}">${btn}</a></div>
      </div>`;
  }

  const older = days.slice(1);
  app.innerHTML = `
    <div class="wrap">
      <header class="top">
        <div class="brand"><img src="icons/icon-192.png" alt=""><div><b>Physics Daily</b><small>Sithum De Zoysa · A/L</small></div></div>
      </header>
      ${installTip()}
      ${hero}
      <div class="stats">
        <div class="stat fire"><b>🔥 ${s.streak}</b><small>Day streak</small></div>
        <div class="stat"><b>${s.answered}</b><small>Answered</small></div>
        <div class="stat"><b>${s.accuracy == null ? "—" : s.accuracy + "%"}</b><small>Accuracy</small></div>
      </div>
      ${older.length ? `<h2 class="section-title">Previous days ${s.wrong ? `<a href="#mistakes">Review mistakes (${s.wrong})</a>` : ""}</h2>
        <div class="days">${older.map((d) => {
          const p = dayProgress(d.date, d.count);
          const dt = parseDate(d.date);
          return `<a class="day" href="${p.done >= p.total ? `#done/${d.date}` : `#day/${d.date}`}">
            <span class="date"><b>${dt.getDate()}</b><small>${dt.toLocaleDateString("en-GB", { month: "short" })}</small></span>
            <span class="info"><b>${esc(d.title || "Daily MCQs")}</b><small>${d.count} questions${topicList(d.topics)}</small></span>
            ${scorePill(p)}</a>`;
        }).join("")}</div>`
      : s.wrong ? `<h2 class="section-title">Keep improving <a href="#mistakes">Review mistakes (${s.wrong})</a></h2>` : ""}
      <p class="footer">New questions every day · by Sithum De Zoysa</p>
    </div>`;

  document.getElementById("installBtn")?.addEventListener("click", async () => {
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    renderHome();
  });
  app.querySelector("[data-close-tip]")?.addEventListener("click", () => { state.tipClosed = true; saveState(); renderHome(); });
}

// ---------- Question ----------
function header(title, sub, dotsHtml = "") {
  return `<div class="qtop"><div class="qtop-row"><a class="back" href="#" aria-label="Home">←</a>
    <div class="qtop-title"><b>${esc(title)}</b><small>${sub}</small></div></div>${dotsHtml}</div>`;
}

async function renderQuestion(date, i) {
  const day = await loadDay(date);
  const qs = day.questions;
  if (i == null || isNaN(i)) {
    i = qs.findIndex((q) => !state.answers[q.id]);
    if (i < 0) { location.replace(`#done/${date}`); return; }
  }
  i = Math.max(0, Math.min(qs.length - 1, i));
  const q = qs[i];
  const ans = state.answers[q.id];

  const dots = `<div class="dots">${qs.map((x, k) => {
    const a = state.answers[x.id];
    return `<i class="${k === i ? "cur" : a ? (a.ok ? "ok" : "no") : ""}"></i>`;
  }).join("")}</div>`;

  const opts = q.options.map((o, k) => {
    let cls = "";
    if (ans) cls = k === q.answer ? "right" : k === ans.c ? "wrong" : "dim";
    return `<button class="opt ${cls}" data-k="${k}" ${ans ? "disabled" : ""}><span class="l">${LETTERS[k]}</span><span>${fmt(o)}</span></button>`;
  }).join("");

  const last = i === qs.length - 1;
  const after = ans ? `
    <div class="verdict ${ans.ok ? "ok" : "no"}">${ans.ok ? "✓ Correct!" : `✗ Not quite. The answer is (${LETTERS[q.answer]})`}</div>
    ${q.explain ? `<div class="method"><b>Method:</b> ${fmt(q.explain)}</div>` : ""}
    <div class="qnav">
      ${i > 0 ? `<a class="btn btn-ghost" href="#day/${date}/${i - 1}">←</a>` : ""}
      <a class="btn btn-primary" href="${last ? `#done/${date}` : `#day/${date}/${i + 1}`}">${last ? "See results" : "Next question →"}</a>
    </div>` : "";

  app.innerHTML = `
    <div class="wrap">
      ${header(day.title || "Daily MCQs", `${esc(niceDate(date))} · Question ${i + 1} of ${qs.length}`, dots)}
      <div class="qcard">
        <div class="qmeta"><span class="n">Q${i + 1}</span>${q.topic ? `<span class="topic">${esc(q.topic)}</span>` : ""}</div>
        ${q.image ? `<img class="qimg" src="${esc(q.image)}" alt="Diagram for this question">` : ""}
        <div class="qtext">${fmt(q.q)}</div>
        <div class="opts">${opts}</div>
        ${after}
      </div>
    </div>`;

  if (!ans) {
    app.querySelectorAll(".opt").forEach((b) => b.addEventListener("click", () => {
      const k = +b.dataset.k;
      const ok = k === q.answer;
      state.answers[q.id] = { c: k, ok };
      const t = todayStr();
      if (!state.active.includes(t)) state.active.push(t);
      saveState();
      try { navigator.vibrate?.(ok ? 25 : [40, 60, 40]); } catch { /* ignore */ }
      renderQuestion(date, i);
    }));
  }
}

// ---------- Finish ----------
async function renderFinish(date) {
  const day = await loadDay(date);
  const p = dayProgress(date, day.questions.length);
  const pct = p.total ? Math.round((p.right / p.total) * 100) : 0;
  const color = pct >= 75 ? "#3ddc97" : pct >= 50 ? "#ffc53d" : "#ff6b6b";
  const msg = pct === 100 ? "Perfect score! 🏆" : pct >= 75 ? "Excellent work!" : pct >= 50 ? "Good effort!" : "Keep practising!";
  const url = location.origin + location.pathname;
  const shareText = `I scored ${p.right}/${p.total} on Physics Daily by Sithum De Zoysa! 🔬 Try today's A/L Physics MCQs: ${url}`;

  app.innerHTML = `
    <div class="wrap">
      ${header(day.title || "Daily MCQs", esc(niceDate(date)))}
      <div class="finish">
        <div class="ring"><svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="52" stroke="#26304f" stroke-width="10" fill="none"/>
          <circle id="arc" cx="60" cy="60" r="52" stroke="${color}" stroke-width="10" fill="none" stroke-linecap="round"
            stroke-dasharray="326.7" stroke-dashoffset="326.7" style="transition:stroke-dashoffset 1s ease"/></svg>
          <div class="v"><b>${p.right}/${p.total}</b><small>${pct}%</small></div></div>
        <h2>${msg}</h2>
        <p>${p.done < p.total ? `You've answered ${p.done} of ${p.total}.` : "Come back tomorrow for new questions."}</p>
        <div class="btns">
          ${p.done < p.total ? `<a class="btn btn-primary" href="#day/${date}">Continue →</a>` : ""}
          <button class="btn btn-wa" id="shareBtn">Share my score</button>
          <a class="btn btn-ghost" href="#day/${date}/0">Review answers</a>
          <button class="btn btn-ghost" id="retryBtn">Try this set again</button>
          <a class="btn btn-ghost" href="#">Home</a>
        </div>
      </div>
    </div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.getElementById("arc").style.strokeDashoffset = 326.7 * (1 - pct / 100);
  }));

  document.getElementById("shareBtn").addEventListener("click", async () => {
    if (navigator.share) {
      try { await navigator.share({ text: shareText }); } catch { /* cancelled */ }
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank", "noopener");
    }
  });
  document.getElementById("retryBtn").addEventListener("click", () => {
    if (!confirm("Clear your answers for this set and try again?")) return;
    day.questions.forEach((q) => delete state.answers[q.id]);
    saveState();
    location.hash = `day/${date}/0`;
  });
}

// ---------- Mistakes ----------
async function renderMistakes() {
  const wrongIds = Object.keys(state.answers).filter((id) => !state.answers[id].ok);
  const dates = [...new Set(wrongIds.map((id) => id.slice(0, 10)))].sort().reverse();
  const days = await Promise.all(dates.map((d) => loadDay(d).catch(() => null)));
  const items = [];
  days.forEach((day) => day?.questions.forEach((q, i) => {
    const a = state.answers[q.id];
    if (a && !a.ok) items.push({ day, q, i, a });
  }));

  app.innerHTML = `
    <div class="wrap">
      ${header("Review mistakes", `${items.length} question${items.length === 1 ? "" : "s"} to learn from`)}
      ${items.length ? `<div class="days" style="gap:14px">${items.map(({ day, q, i, a }) => `
        <div class="qcard">
          <div class="qmeta"><span class="n">${esc(niceDate(day.date))} · Q${i + 1}</span>${q.topic ? `<span class="topic">${esc(q.topic)}</span>` : ""}</div>
          ${q.image ? `<img class="qimg" src="${esc(q.image)}" alt="">` : ""}
          <div class="qtext" style="font-size:16px">${fmt(q.q)}</div>
          <div class="opts">
            <div class="opt wrong"><span class="l">${LETTERS[a.c]}</span><span>${fmt(q.options[a.c])}</span></div>
            <div class="opt right"><span class="l">${LETTERS[q.answer]}</span><span>${fmt(q.options[q.answer])}</span></div>
          </div>
          ${q.explain ? `<div class="method" style="margin-top:12px"><b>Method:</b> ${fmt(q.explain)}</div>` : ""}
        </div>`).join("")}</div>`
      : `<div class="empty">No mistakes to review. Nice! 🎉</div>`}
    </div>`;
}

// ---------- Start ----------
(async function start() {
  await loadIndex();
  route();
  // Refresh the question list when the app comes back to the foreground (e.g. the next morning)
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const before = index.released[0]?.date;
    await loadIndex();
    if (index.released[0]?.date !== before) { toast("New questions are here! 🎉"); if (!location.hash) renderHome(); }
  });
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
