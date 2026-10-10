// ==========================================================
// Practicals: learning quizzes for the A/L Physics practicals.
//   #prac          list of practicals (grouped by unit)
//   #prac/<id>     one practical, e.g. #prac/phy-p01
// Learning mode: any time, unlimited attempts, the answer and method appear right after each question.
// Options are shuffled on every attempt. The score is shown only to the student and is NOT sent anywhere:
// progress is kept on this phone only (localStorage). Questions come from the pr_quizzes table.
// ==========================================================
import { $, $$, esc, fmt, LETTERS } from "./ui.js";

const UNITS = [
  [1, 4, "Measurement"], [5, 9, "Mechanics"], [10, 16, "Oscillations and waves"], [17, 22, "Light"],
  [23, 31, "Thermal physics"], [32, 36, "Electricity"], [37, 39, "Electronics"], [40, 44, "Mechanical properties of matter"]
];
export const TOTAL_PRACTICALS = 44;

let list = null;              // pr_list() result (cached for the session)
const quizzes = {};           // id → full practical (cached)
let run = null;               // the attempt on screen

// ---------- progress on this phone only ----------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};
const bestKey = (id) => `prac:best:${id}`;   // {score, total} of the best full run
const runKey = (id) => `prac:run:${id}`;     // a full run in progress: {i, right, wrong}

export const shortTitle = (t) => { const s = t.en.replace(/^Usage of the /i, ""); return s[0].toUpperCase() + s.slice(1); };
const num = (n) => String(n).padStart(2, "0");

export async function practicalsList(sb, force = false) {
  if (list && !force) return list;
  const { data, error } = await sb.rpc("pr_list", { p_subject: "phy" });
  if (error) throw new Error(error.message);
  list = data || [];
  return list;
}

// For the strip on the subject picker and the card on Physics home
export function practicalsSummary(rows) {
  if (!rows?.length) return null;
  const going = rows.find((r) => store.get(runKey(r.id))?.i > 0);
  const preview = !rows.some((r) => r.live);
  return {
    count: rows.length,
    preview,
    line: going ? `Continue: ${shortTitle(going.title)}` : `${rows.length} practical${rows.length > 1 ? "s" : ""} · learn any time`
  };
}

export async function renderPractical(ctx) {
  const { a } = ctx;
  ctx.setSubject("phy");
  if (a) return renderRun(ctx, a);
  return renderList(ctx);
}

// ==========================================================
// List
// ==========================================================
async function renderList(ctx) {
  const { shell, sb, me } = ctx;
  shell("home", `<div class="spinner"></div>`);
  const rows = await practicalsList(sb, true);
  const byUnit = UNITS.map(([lo, hi, name]) => [name, rows.filter((r) => r.no >= lo && r.no <= hi)]).filter(([, r]) => r.length);
  const hiddenCount = rows.filter((r) => !r.live).length;

  const row = (r) => {
    const best = store.get(bestKey(r.id));
    const going = store.get(runKey(r.id));
    const st = going?.i > 0 ? `<span class="st part">${going.i} / ${r.count}</span>`
      : best ? `<span class="st done">✓ ${best.score}/${best.total}</span>` : "";
    return `<a class="prow ${best && !(going?.i > 0) ? "done" : ""}" href="#prac/${r.id}">
      <span class="no">${num(r.no)}</span>
      <span class="t"><b>${esc(shortTitle(r.title))}</b><small>${r.count} questions${me.is_admin && !r.live ? " · <i>hidden from students</i>" : ""}</small></span>
      ${st}<span class="chev">›</span></a>`;
  };

  shell("home", `
    <div class="qtop plain"><div class="qtop-row"><a class="back" href="#s/phy" aria-label="Back">←</a>
      <div class="qtop-title"><b>Practicals</b><small>A/L Physics</small></div></div></div>
    ${me.is_admin && hiddenCount ? `<div class="prac-preview">👁 <b>Preview.</b> ${hiddenCount} practical${hiddenCount > 1 ? "s are" : " is"} hidden from students. Release with <code>node tools/practicals.mjs --live all</code></div>` : ""}
    <p class="learn-note">📘 Learn at your own pace. No timer and no marks saved. The answer and full method appear as soon as you check each question.</p>
    ${rows.length ? byUnit.map(([u, rs]) => `<h3 class="unit-h">${u}</h3><div class="card list-card">${rs.map(row).join("")}</div>`).join("")
      : `<div class="empty">Practicals are coming soon.</div>`}
    ${rows.length && rows.length < TOTAL_PRACTICALS ? `<p class="more-soon">More practicals are being added. <b>Stay tuned!</b></p>` : ""}`);
}

// ==========================================================
// One practical
// ==========================================================
const shuffle = (n) => { const p = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; };

async function renderRun(ctx, id) {
  const { app, sb } = ctx;
  app.innerHTML = `<div class="wrap"><div class="spinner"></div></div>`;
  if (!quizzes[id]) {
    const { data, error } = await sb.from("pr_quizzes").select("id,no,title,questions").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { ctx.go("prac"); return; }
    quizzes[id] = data;
  }
  const P = quizzes[id];
  const saved = store.get(runKey(id));
  const all = P.questions.map((_, k) => k);
  if (saved && saved.i > 0 && saved.i < all.length) startRun(P, all, true, saved);
  else startRun(P, all, true);
  draw(ctx);
}

// order: indices of the questions to ask; full: a whole run (saved for "continue"), not a retry of wrong ones
function startRun(P, order, full, saved = null) {
  run = {
    P, order, full,
    i: saved?.i || 0,
    right: saved?.right || 0,
    wrong: saved?.wrong || [],               // question indices answered wrongly in this run
    perm: order.map(() => shuffle(5)),       // new option order on every attempt
    pick: null, checked: false
  };
}

function saveRun() {
  if (!run.full) return;
  store.set(runKey(run.P.id), { i: run.i, right: run.right, wrong: run.wrong });
}

function draw(ctx) {
  if (run.i >= run.order.length) return drawFinish(ctx);
  const { app } = ctx;
  const lang = ctx.getLang();
  const P = run.P, qi = run.order[run.i], q = P.questions[qi], perm = run.perm[run.i];
  const t = lang !== "en" && q[lang] ? q[lang] : q;
  const opts = perm.map((k) => t.options[k]);
  const correct = perm.indexOf(q.answer);
  const n = run.order.length;
  const ref = /^Extra/.test(q.ref) ? "Handbook" : `Worksheet ${q.ref}`;

  const optHtml = opts.map((o, k) => {
    let cls = "opt";
    if (!run.checked && run.pick === k) cls += " picked";
    if (run.checked) cls += k === correct ? " right" : k === run.pick ? " wrong" : " dim";
    const mark = run.checked && k === correct ? `<span class="mk">✓</span>` : run.checked && k === run.pick ? `<span class="mk">✗</span>` : "";
    return `<button class="${cls}" data-k="${k}" ${run.checked ? "disabled" : ""}><span class="l">${LETTERS[k]}</span><span>${fmt(o)}</span>${mark}</button>`;
  }).join("");
  const ok = run.checked && run.pick === correct;

  app.innerHTML = `<div class="wrap quiz-wrap prac-run">
    <div class="qtop">
      <div class="qtop-row">
        <a class="back" href="#prac" aria-label="Back to practicals">✕</a>
        <div class="qtop-title"><b>${num(P.no)} · ${esc(shortTitle(P.title))}</b><small>${run.full ? "" : "Retry · "}Question ${run.i + 1} of ${n}</small></div>
        ${ctx.langSwitch()}
      </div>
      <div class="lq-bar"><i style="width:${Math.round(((run.i + (run.checked ? 1 : 0)) / n) * 100)}%"></i></div>
    </div>
    <div class="qcard" lang="${lang}">
      <div class="qmeta"><span class="n">Question ${run.i + 1}</span><span class="tag-ref">${esc(ref)}</span></div>
      ${q.image ? `<img class="qimg prac-img" src="${esc(q.image)}" alt="Diagram">` : ""}
      <div class="qtext">${fmt(t.q)}</div>
      ${run.checked ? `<div class="verdict ${ok ? "ok" : "no"}"><span>${ok ? "✓" : "✗"}</span>${ok ? "Correct! Well done." : "Not quite. The correct answer is shown in green."}</div>` : ""}
      <div class="opts">${optHtml}</div>
      ${run.checked ? `<div class="method"><b>Method:</b> ${fmt(t.explain)}</div>` : ""}
    </div>
    <div class="qbar">${run.checked
      ? `<button class="btn btn-primary btn-block" id="next">${run.i + 1 < n ? "Next question →" : "See my score"}</button>`
      : `<button class="btn btn-primary btn-block" id="check" ${run.pick == null ? "disabled" : ""}>Check answer</button>`}</div>
  </div>`;

  $$(".opt").forEach((b) => b.onclick = () => { if (run.checked) return; run.pick = +b.dataset.k; try { navigator.vibrate?.(10); } catch { /* ignore */ } draw(ctx); });
  $("#check")?.addEventListener("click", () => {
    run.checked = true;
    if (run.pick === correct) run.right++; else run.wrong.push(qi);
    draw(ctx);
    $(".verdict")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("#next")?.addEventListener("click", () => {
    run.i++; run.pick = null; run.checked = false;
    saveRun();
    draw(ctx);
    window.scrollTo(0, 0);
  });
  ctx.bindLangSwitch(() => draw(ctx));
}

function drawFinish(ctx) {
  const { app } = ctx;
  const P = run.P, n = run.order.length, score = run.right;
  const pct = Math.round((score / n) * 100);
  if (run.full) {
    store.del(runKey(P.id));
    const best = store.get(bestKey(P.id));
    if (!best || score / n > best.score / best.total) store.set(bestKey(P.id), { score, total: n });
  }
  const color = pct >= 75 ? "#16a34a" : pct >= 50 ? "#f59e0b" : "#dc2626";
  const C = 326.7;
  const next = (list || []).find((r) => r.no > P.no);
  const wrong = run.wrong.slice();
  app.innerHTML = `<div class="wrap prac-finish">
    <div class="qtop plain"><div class="qtop-row"><a class="back" href="#prac" aria-label="Back">←</a>
      <div class="qtop-title"><b>${num(P.no)} · ${esc(shortTitle(P.title))}</b><small>${run.full ? "Finished" : "Retry finished"}</small></div></div></div>
    <div class="card result">
      <div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" style="stroke:var(--line)" stroke-width="10" fill="none"/>
        <circle id="arc" cx="60" cy="60" r="52" stroke="${color}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" style="transition:stroke-dashoffset 1s ease"/></svg>
        <div class="v"><b>${score}/${n}</b><small>${pct}%</small></div></div>
      <h2>${pct === 100 ? "Perfect! 🏆" : pct >= 75 ? "Great work! 👏" : pct >= 50 ? "Good effort!" : "Keep learning!"}</h2>
      <p class="private">🔒 Only you can see this. Nothing is saved or ranked.</p>
      <div class="fin-btns">
        ${wrong.length ? `<button class="btn btn-primary btn-block" id="retryWrong">Retry the ${wrong.length} I got wrong</button>` : ""}
        <button class="btn ${wrong.length ? "btn-ghost" : "btn-primary"} btn-block" id="again">Start this practical again</button>
        ${next ? `<a class="btn btn-ghost btn-block" href="#prac/${next.id}" title="${esc(shortTitle(next.title))}">Next practical →</a>` : ""}
        <a class="btn btn-ghost btn-block" href="#prac">All practicals</a>
      </div>
    </div></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => { const arc = $("#arc"); if (arc) arc.style.strokeDashoffset = C * (1 - pct / 100); }));
  $("#retryWrong")?.addEventListener("click", () => { startRun(P, wrong, false); draw(ctx); window.scrollTo(0, 0); });
  $("#again").onclick = () => { startRun(P, P.questions.map((_, k) => k), true); draw(ctx); window.scrollTo(0, 0); };
}
