// ==========================================================
// Admin screens (only loaded for admins; the database also enforces this)
//   #admin / #admin/students    student list
//   #admin/days                 all days
//   #admin/s/<id>               one student
//   #admin/d/<day>              rank sheet + question analysis
// ==========================================================
import { $, $$, esc, fmt, fmtTime, niceDay, pctClass, toast, sheet, confirmBox, lineChart, barList, LETTERS, SERIES } from "./ui.js";

let ctx;
const rpc = async (name, args) => {
  const { data, error } = await ctx.sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
};

export async function renderAdmin(c) {
  ctx = c;
  const { a, b } = c;
  if (a === "s" && b) return student(b);
  if (a === "d" && b) return daySheet(b);
  if (a === "days") return days();
  if (a === "notify") return notify();
  if (a === "reports") return reports(b || "open");
  return students();
}

const seg = (on) => `<div class="seg"><a href="#admin/students" class="${on === "students" ? "on" : ""}">Students</a>
  <a href="#admin/days" class="${on === "days" ? "on" : ""}">Sheets</a>
  <a href="#admin/reports" class="${on === "reports" ? "on" : ""}">Reports</a>
  <a href="#admin/notify" class="${on === "notify" ? "on" : ""}">Notify</a></div>`;

// ---------- Question reports from students ----------
async function reports(status) {
  ctx.shell("admin", `<h1 class="page-title">Admin</h1>${seg("reports")}<div class="spinner"></div>`);
  const list = await rpc("dq_admin_reports", { p_status: status });
  const tabs = [["open", "Open"], ["fixed", "Fixed"], ["dismissed", "Dismissed"]];
  ctx.shell("admin", `
    <h1 class="page-title">Admin</h1>${seg("reports")}
    <div class="seg">${tabs.map(([k, l]) => `<a href="#admin/reports/${k}" class="${k === status ? "on" : ""}">${l}</a>`).join("")}</div>
    ${status === "open" ? `<p class="hint" style="margin:-4px 0 12px">To correct a question, tell Claude, e.g. <i>"Q3 on 4 Oct: the answer should be 2"</i>. Everyone is re-marked automatically. Then mark the report <b>Fixed</b>.</p>` : ""}
    ${list.length ? list.map((r) => `
      <div class="qcard" style="margin-bottom:12px">
        <div class="qmeta"><span class="n">${esc(niceDay(r.day))} · Q${r.position}</span><span class="pill low">${esc(r.reason || "Report")}</span></div>
        <div class="qtext sm" style="margin-bottom:8px">${fmt(r.body)}</div>
        <p class="hint" style="margin:0 0 8px">Correct answer now: <b>${r.correct_index == null ? "—" : `${LETTERS[r.correct_index]}. ${fmt(r.options[r.correct_index])}`}</b></p>
        ${r.message ? `<div class="method">“${esc(r.message)}”</div>` : ""}
        <p class="hint">From <b>${esc(r.full_name)}</b> · ${esc(r.school || "")} · ${esc(new Date(r.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</p>
        ${status === "open" ? `<div class="sheet-btns" style="margin-top:10px">
          <button class="btn btn-ghost btn-sm" data-set="dismissed" data-id="${r.id}">Dismiss</button>
          <button class="btn btn-primary btn-sm" data-set="fixed" data-id="${r.id}">Mark fixed</button></div>`
        : `<div class="sheet-btns" style="margin-top:10px"><button class="btn btn-ghost btn-sm" data-set="open" data-id="${r.id}">Re-open</button></div>`}
      </div>`).join("") : `<div class="empty">${status === "open" ? "No open reports. 🎉" : "Nothing here."}</div>`}`);
  $$("[data-set]").forEach((btn) => btn.onclick = async () => {
    await rpc("dq_admin_set_report", { p_id: btn.dataset.id, p_status: btn.dataset.set });
    toast(btn.dataset.set === "fixed" ? "Marked fixed." : btn.dataset.set === "dismissed" ? "Dismissed." : "Re-opened.");
    reports(status);
  });
}

// ---------- Send a notification ----------
async function notify() {
  ctx.shell("admin", `<h1 class="page-title">Admin</h1>${seg("notify")}<div class="spinner"></div>`);
  let count = "—";
  try { count = await rpc("dq_admin_push_count"); } catch { /* push not set up yet */ }
  ctx.shell("admin", `
    <h1 class="page-title">Admin</h1>${seg("notify")}
    <div class="tiles"><div class="tile big"><small>Students with reminders on</small><b>${count}</b>
      <em>Automatic: 6:00 am when the quiz opens · 8:00 pm to anyone who hasn't done it</em></div></div>
    <form class="card form" id="nf">
      <h3>Send a message now</h3>
      <label>Title<input name="t" maxlength="80" required placeholder="e.g. New paper class this Saturday!"></label>
      <label>Message<input name="b" maxlength="200" required placeholder="e.g. 2027 Paper Class starts 5 Oct. WhatsApp 072 918 4999"></label>
      <p class="err" id="ne"></p>
      <button class="btn btn-primary btn-block">Send to everyone</button>
    </form>`);
  $("#nf").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!(await confirmBox("Send this notification?", `It goes to every student with reminders on (${count}).`, "Send"))) return;
    const btn = f.querySelector("button"); btn.disabled = true;
    const { data, error } = await ctx.sb.functions.invoke("daily-push", {
      body: { kind: "custom", title: f.t.value.trim(), body: f.b.value.trim() }
    });
    btn.disabled = false;
    if (error) { $("#ne").textContent = "Couldn't send: " + error.message; return; }
    toast(`Sent to ${data.sent} phone${data.sent === 1 ? "" : "s"}.`);
    f.reset();
  };
}

function csv(name, head, rows) {
  const text = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv" }));
  a.download = name;
  a.click();
}

// ---------- Students ----------
async function students() {
  ctx.shell("admin", `<h1 class="page-title">Admin</h1>${seg("students")}<div class="spinner"></div>`);
  const [list, st] = await Promise.all([rpc("dq_admin_students"), rpc("dq_admin_status").catch(() => null)]);
  const active7 = list.filter((s) => s.last_day && Date.parse(s.last_day) > Date.now() - 7 * 864e5).length;

  ctx.shell("admin", `
    <h1 class="page-title">Admin</h1>${seg("students")}
    ${ctx.adminBanner ? ctx.adminBanner(st) : ""}
    <div class="tiles">
      <div class="tile"><small>Students</small><b>${list.length}</b></div>
      <div class="tile"><small>Active (7 days)</small><b>${active7}</b></div>
      <div class="tile"><small>Banned</small><b>${list.filter((s) => s.is_banned).length}</b></div>
      <div class="tile"><small>No NIC yet</small><b>${list.filter((s) => !s.nic).length}</b></div>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search name, NIC, school, phone…">
      <select id="f"><option value="">All</option><option value="banned">Banned</option><option value="nonic">No NIC</option></select>
      <button class="btn btn-ghost btn-sm" id="csv">CSV</button>
    </div>
    <p class="hint" id="count"></p>
    <div class="card list-card" id="rows"></div>`);

  let shown = list;
  const draw = () => {
    const q = $("#q").value.trim().toLowerCase();
    const f = $("#f").value;
    shown = list.filter((s) =>
      (!q || [s.full_name, s.nic, s.school, s.phone, s.email, s.district].join(" ").toLowerCase().includes(q)) &&
      (f !== "banned" || s.is_banned) && (f !== "nonic" || !s.nic));
    $("#count").textContent = `${shown.length} student${shown.length === 1 ? "" : "s"}`;
    $("#rows").innerHTML = shown.map((s) => {
      const p = s.questions ? Math.round((s.correct / s.questions) * 100) : null;
      return `<a class="stu-row" href="#admin/s/${s.id}">
        <span class="who"><b>${esc(s.full_name || "(no name)")} ${s.is_banned ? '<span class="pill low">Banned</span>' : ""}</b>
          <small>${esc(s.nic || "No NIC")} · ${esc(s.school || "—")}</small></span>
        <span class="sc"><b>${s.quizzes}</b><small>quizzes</small></span>
        <span class="sc"><b>${p == null ? "—" : p + "%"}</b><small>score</small></span></a>`;
    }).join("") || `<p class="muted" style="padding:16px">No students found.</p>`;
  };
  $("#q").oninput = draw;
  $("#f").onchange = draw;
  draw();
  $("#csv").onclick = () => csv("students.csv",
    ["Name", "NIC", "Email", "Phone", "School", "District", "A/L year", "Quizzes", "Correct", "Questions", "Banned", "Joined"],
    shown.map((s) => [s.full_name, s.nic, s.email, s.phone, s.school, s.district, s.exam_year, s.quizzes, s.correct, s.questions,
      s.is_banned ? "yes" : "", s.created_at?.slice(0, 10)]));
}

// ---------- One student ----------
async function student(id) {
  ctx.shell("admin", `<div class="spinner"></div>`);
  const [list, stats] = await Promise.all([rpc("dq_admin_students"), rpc("dq_stats", { p_user: id })]);
  const s = list.find((x) => x.id === id);
  if (!s) { ctx.shell("admin", `<div class="empty">Student not found.</div>`); return; }
  const wa = String(s.phone || "").replace(/\D/g, "").replace(/^0/, "94");
  const acc = stats.answered ? Math.round((stats.correct / stats.answered) * 100) : null;
  const h = stats.history;

  ctx.shell("admin", `
    <div class="qtop plain"><div class="qtop-row"><a class="back" href="#admin/students">←</a>
      <div class="qtop-title"><b>${esc(s.full_name)}</b><small>${esc(s.school || "")}</small></div></div></div>
    ${s.is_banned ? `<div class="banner bad">🚫 Banned${s.ban_reason ? ": " + esc(s.ban_reason) : ""}</div>` : ""}
    <div class="card">
      <dl class="kv">
        <dt>NIC</dt><dd><b>${esc(s.nic || "Not set")}</b> ${s.nic ? `<small class="muted">(born ${s.nic.slice(0, 4)})</small>` : ""}</dd>
        <dt>Email</dt><dd>${esc(s.email)}</dd>
        <dt>Phone</dt><dd>${esc(s.phone || "—")}</dd>
        <dt>District</dt><dd>${esc(s.district || "—")}</dd>
        <dt>A/L year</dt><dd>${esc(s.exam_year || "—")}</dd>
        <dt>Joined</dt><dd>${esc(s.created_at?.slice(0, 10))}</dd>
      </dl>
      <div class="sheet-btns" style="margin-top:14px">
        ${wa ? `<a class="btn btn-wa btn-sm" href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
        <button class="btn btn-ghost btn-sm" id="nic">Edit NIC</button>
        <button class="btn ${s.is_banned ? "btn-ghost" : "btn-danger-solid"} btn-sm" id="ban">${s.is_banned ? "Unban" : "Ban"}</button>
      </div>
    </div>
    <div class="tiles">
      <div class="tile big"><small>Correct / answered</small><b>${stats.correct}<span>/${stats.answered}</span></b><em>${acc == null ? "—" : acc + "% accuracy"}</em></div>
      <div class="tile"><small>Quizzes</small><b>${stats.quizzes}<span>/${stats.days_released}</span></b></div>
      <div class="tile"><small>Streak</small><b>🔥 ${stats.streak}</b></div>
      <div class="tile"><small>Avg time</small><b>${fmtTime(stats.avg_time)}</b></div>
    </div>
    <div class="card"><h3 class="card-title">Marks by day</h3><div id="chart"></div></div>
    <div class="card"><h3 class="card-title">Topics</h3>${barList(stats.topics.map((t) => ({ label: t.topic, correct: t.correct, total: t.total })))}</div>
    <h2 class="section-title">History</h2>
    ${h.length ? `<div class="days">${[...h].reverse().map((d) => {
      const p = Math.round((d.score / d.total) * 100);
      return `<a class="day" href="#admin/d/${d.day}">
        <span class="info"><b>${esc(niceDay(d.day))} · ${esc(d.title || "")}</b><small>Rank #${d.rank} of ${d.participants} · ${fmtTime(d.time_taken)}</small></span>
        <span class="pill ${pctClass(p)}">${d.score}/${d.total}</span></a>`;
    }).join("")}</div>` : `<div class="empty">No quizzes yet.</div>`}`);

  lineChart($("#chart"), h.map((d) => niceDay(d.day, { day: "numeric", month: "short" })), [
    { name: s.full_name, color: SERIES.you, values: h.map((d) => (d.total ? (d.score / d.total) * 100 : null)) },
    { name: "Class average", color: SERIES.avg, values: h.map((d) => (d.avg_pct == null ? null : +d.avg_pct)) }
  ]);

  $("#ban").onclick = async () => {
    if (s.is_banned) {
      if (!(await confirmBox("Unban this student?", `${esc(s.full_name)} will be able to use the app again.`, "Unban"))) return;
      await rpc("dq_admin_set_ban", { p_user: id, p_banned: false, p_reason: "" });
    } else {
      const { el, close } = sheet(`<form class="form" id="bf"><h3>Ban ${esc(s.full_name)}?</h3>
        <p class="muted">They won't be able to take quizzes, and they disappear from leaderboards.</p>
        <label>Reason (shown to them)<input name="reason" value="Invalid NIC / false details"></label>
        <div class="sheet-btns"><button type="button" class="btn btn-ghost" id="c">Cancel</button><button class="btn btn-danger-solid">Ban</button></div></form>`);
      $("#c", el).onclick = close;
      await new Promise((res) => { $("#bf", el).onsubmit = async (e) => {
        e.preventDefault();
        await rpc("dq_admin_set_ban", { p_user: id, p_banned: true, p_reason: e.target.reason.value.trim() });
        close(); res();
      }; });
    }
    toast("Saved.");
    student(id);
  };
  $("#nic").onclick = () => {
    const { el, close } = sheet(`<form class="form" id="nf"><h3>Edit NIC</h3>
      <label>NIC<input name="nic" value="${esc(s.nic || "")}" autocapitalize="characters"></label>
      <p class="hint">Leave empty to clear it. The student will be asked for it again.</p><p class="err" id="ne"></p>
      <div class="sheet-btns"><button type="button" class="btn btn-ghost" id="c">Cancel</button><button class="btn btn-primary">Save</button></div></form>`);
    $("#c", el).onclick = close;
    $("#nf", el).onsubmit = async (e) => {
      e.preventDefault();
      try { await rpc("dq_admin_set_nic", { p_user: id, p_nic: e.target.nic.value }); }
      catch (err) { $("#ne", el).textContent = err.message; return; }
      close(); toast("NIC saved."); student(id);
    };
  };
}

// ---------- Days ----------
async function days() {
  ctx.shell("admin", `<h1 class="page-title">Admin</h1>${seg("days")}<div class="spinner"></div>`);
  const list = await rpc("dq_admin_days");
  const t = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  ctx.shell("admin", `
    <h1 class="page-title">Admin</h1>${seg("days")}
    ${list.length ? `<div class="days">${list.map((d) => `
      <a class="day" href="#admin/d/${d.day}">
        <span class="info"><b>${esc(niceDay(d.day))} · ${esc(d.title || "")}</b>
          <small>${d.count} questions · ${d.participants} took it${d.avg_pct != null ? ` · avg ${Math.round(d.avg_pct)}%` : ""}</small></span>
        ${d.day > t ? `<span class="pill new">Scheduled</span>` : d.day === t ? `<span class="pill mid">Today</span>` : `<span class="pill">${d.participants}</span>`}
      </a>`).join("")}</div>` : `<div class="empty">No days published yet.</div>`}`);
}

async function daySheet(day) {
  ctx.shell("admin", `<div class="spinner"></div>`);
  const d = await rpc("dq_admin_day", { p_day: day });
  const n = d.rows.length;
  const avg = n ? d.rows.reduce((s, r) => s + r.score / r.total, 0) / n * 100 : null;

  ctx.shell("admin", `
    <div class="qtop plain"><div class="qtop-row"><a class="back" href="#admin/days">←</a>
      <div class="qtop-title"><b>${esc(d.title || "Daily MCQs")}</b><small>${esc(niceDay(day))}</small></div>
      <button class="btn btn-ghost btn-sm" id="csv">CSV</button></div></div>
    <div class="tiles">
      <div class="tile"><small>Took it</small><b>${n}</b>${d.in_progress ? `<em>${d.in_progress} writing now</em>` : ""}</div>
      <div class="tile"><small>Average</small><b>${avg == null ? "—" : Math.round(avg) + "%"}</b></div>
    </div>
    <div class="seg" id="tabs"><button class="on" data-t="sheet">Rank sheet</button><button data-t="qa">Questions</button></div>
    <div id="sheet">${n ? `<div class="card list-card">${d.rows.map((r) => `
      <div class="rank-row">
        <span class="rk">${r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : "#" + r.rank}</span>
        <a class="who" href="#admin/s/${r.student_id}"><b>${esc(r.name)} ${r.is_banned ? '<span class="pill low">Banned</span>' : ""}</b>
          <small>${esc(r.nic || "No NIC")} · ${esc(r.school || "")}</small></a>
        <span class="sc"><b>${r.score}/${r.total}</b><small>${Math.round((r.score / r.total) * 100)}%</small></span>
        <span class="tm"><b>${fmtTime(r.time_taken)}</b><small><button class="link tiny" data-reset="${r.attempt_id}" data-name="${esc(r.name)}">reset</button></small></span>
      </div>`).join("")}</div>` : `<div class="empty">Nobody has taken this quiz yet.</div>`}</div>
    <div id="qa" class="hidden">${d.questions.map((q, i) => {
      const total = q.counts.reduce((s, c) => s + c, 0) + q.skipped || 1;
      const right = q.correct == null ? 0 : q.counts[q.correct];
      const p = Math.round((right / total) * 100);
      return `<div class="qcard">
        <div class="qmeta"><span class="n">Q${i + 1}${q.topic ? " · " + esc(q.topic) : ""}</span><span class="pill ${pctClass(p)}">${p}% correct</span></div>
        <div class="qtext sm">${fmt(q.body)}</div>
        <div class="bars">${q.counts.map((c, k) => `
          <div class="bar-row"><div class="bar-top"><span>${k === q.correct ? "✓ " : ""}${LETTERS[k]}. ${fmt(q.options[k])}</span><b>${c}</b></div>
            <div class="bar-track"><div class="bar-fill ${k === q.correct ? "good" : "neutral"}" style="width:${(c / total) * 100}%"></div></div></div>`).join("")}
          <div class="bar-row"><div class="bar-top"><span class="muted">Skipped</span><b>${q.skipped}</b></div>
            <div class="bar-track"><div class="bar-fill neutral" style="width:${(q.skipped / total) * 100}%"></div></div></div>
        </div></div>`;
    }).join("")}</div>`);

  $$("#tabs button").forEach((btn) => btn.onclick = () => {
    $$("#tabs button").forEach((x) => x.classList.toggle("on", x === btn));
    $("#sheet").classList.toggle("hidden", btn.dataset.t !== "sheet");
    $("#qa").classList.toggle("hidden", btn.dataset.t !== "qa");
  });
  $("#csv").onclick = () => csv(`rank-sheet-${day}.csv`, ["Rank", "Name", "NIC", "School", "Phone", "Score", "Total", "Time (s)", "Submitted"],
    d.rows.map((r) => [r.rank, r.name, r.nic, r.school, r.phone, r.score, r.total, r.time_taken, r.submitted_at]));
  $$("[data-reset]").forEach((btn) => btn.onclick = async () => {
    if (!(await confirmBox("Reset attempt?", `${esc(btn.dataset.name)}'s mark for this day is deleted. They can only retake it if it's still today.`, "Reset", true))) return;
    await rpc("dq_admin_reset", { p_attempt: btn.dataset.reset });
    toast("Attempt reset.");
    daySheet(day);
  });
}
