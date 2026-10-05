// ==========================================================
// සත්කාර (Physics Daily + Chemistry Daily) — Sithum De Zoysa
// Screens (URL hash):
//   #login  #register  #newpass  #complete  #banned
//   #home (subject picker)  #s/<subj>  #quiz/<subj>/<day>  #review/<subj>/<day>
//   #ranks/<subj>/<period>  #progress/<subj>  #profile
//   #admin…  (admin only, see admin.js)
// <subj> is "phy" or "chem". Old links without a subject (#quiz/<day> …) mean Physics.
// All marking, timing and ranking happen in the database (supabase/daily.sql).
// ==========================================================
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, WHATSAPP_NUMBER, WHATSAPP_DISPLAY, VAPID_PUBLIC_KEY } from "./config.js";
import {
  $, $$, esc, fmt, fmtTime, niceDay, addDays, pctClass, toast, sheet, confirmBox,
  lineChart, barList, LETTERS, DISTRICTS, normalizeNic, normalizePhone, maskNic,
  SUBJECTS, SUBJECT_KEYS, isSubject, subjIcon
} from "./ui.js";

const app = $("#app");
const configured = !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.startsWith("YOUR-");
export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

let me = null;            // profile row
let clockOffset = 0;      // server time − phone time (ms)
let quiz = null;          // active quiz state
let recovering = false;   // password-reset link in progress
let pendingError = "";   // message to show on the next form

const PUBLIC = ["welcome", "login", "register", "newpass"];

// Remember (on this phone only) that someone has logged in here before:
// first-time visitors get the Welcome screen, returning ones go straight to Log in.
const SEEN_KEY = "loggedInBefore";
function markSeen() { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ } }
function seenBefore() { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; } }

// ---------- Subject sections ----------
let subj = "phy";         // subject of the screen being shown
function setSubject(s) {
  subj = isSubject(s) ? s : "phy";
  document.body.dataset.subject = subj;               // light.css switches the colours
  try { localStorage.setItem("subj", subj); } catch { /* ignore */ }
}
function neutralTheme() { document.body.dataset.subject = ""; }
function lastSubject() {
  let s = null;
  try { s = localStorage.getItem("subj"); } catch { /* ignore */ }
  return isSubject(s) ? s : (mySubjects()[0] || "phy");
}
const mySubjects = () => SUBJECT_KEYS.filter((k) => !me?.subjects || me.subjects.includes(k));
const serverNow = () => Date.now() + clockOffset;

// ==========================================================
// Question language (menus stay in English)
// ==========================================================
const LANGS = [["en", "EN"], ["si", "සිං"], ["ta", "தமி"]];
const LANG_NAMES = { en: "English", si: "සිංහල", ta: "தமிழ்" };
let lang = "en";

// A question's text in the chosen language, falling back to English when there's no translation
function tx(q) {
  const t = lang !== "en" ? q.tr?.[lang] : null;
  const ok = !!(t && t.body && t.options);
  return {
    body: ok ? t.body : q.body,
    options: ok ? t.options : q.options,
    explain: ok && t.explain ? t.explain : q.explain,
    fallback: lang !== "en" && !ok
  };
}
const fallbackNote = () => `<p class="hint lang-note">Not available in ${LANG_NAMES[lang]} yet. Showing English.</p>`;

function langSwitch(full = false) {
  return `<div class="lang-seg ${full ? "full" : ""}" role="group" aria-label="Question language">${LANGS.map(([k, short]) =>
    `<button class="${k === lang ? "on" : ""}" data-lang="${k}" lang="${k}">${full ? LANG_NAMES[k] : short}</button>`).join("")}</div>`;
}
function bindLangSwitch(redraw) {
  $$("[data-lang]").forEach((b) => b.onclick = () => {
    if (lang === b.dataset.lang) return;
    lang = b.dataset.lang;
    if (me) { me.lang = lang; sb.from("profiles").update({ lang }).eq("id", me.id).then(() => {}); } // remember it
    redraw();
  });
}

// ==========================================================
// Push reminders
// iPhone: only works once the app is added to the Home Screen (iOS 16.4+).
// ==========================================================
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isInstalled = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, r) => setTimeout(() => r(new Error("Service worker not ready")), 8000))]);
let pushSynced = false;

async function pushState() {
  if (!pushSupported()) return isIOS && !isInstalled() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const sub = await (await swReady()).pushManager.getSubscription();
    if (sub && !pushSynced) { pushSynced = true; sb.rpc("dq_push_subscribe", { p_sub: sub.toJSON() }); } // re-link to this account
    return sub ? "on" : "off";
  } catch { return "unsupported"; }
}

function vapidKey() {
  const s = VAPID_PUBLIC_KEY.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Notifications are blocked. Allow them in your phone's settings."); return false; }
  try {
    const reg = await swReady();
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey() }));
    const { error } = await sb.rpc("dq_push_subscribe", { p_sub: sub.toJSON() });
    if (error) throw error;
    toast("Reminders on 🔔");
    return true;
  } catch (e) {
    toast("Couldn't turn on reminders: " + e.message);
    return false;
  }
}

async function disablePush() {
  const sub = await (await swReady()).pushManager.getSubscription();
  if (sub) { await sb.rpc("dq_push_unsubscribe", { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
  toast("Reminders off.");
}

const PUSH_TEXT = {
  on: "On. You'll get a reminder at 6:00 am when each subject's quiz opens, and at 8:00 pm if you haven't done it yet.",
  off: "Get a reminder at 6:00 am when each subject's quiz opens, and at 8:00 pm if you haven't done it yet.",
  install: "On iPhone, first add the app to your Home Screen: tap Share, then “Add to Home Screen”. Open it from there and turn reminders on.",
  denied: "Notifications are blocked for this app. Allow them in your phone's Settings, then come back here.",
  unsupported: "This browser can't show notifications. On Android use Chrome; on iPhone add the app to your Home Screen."
};

// One-time prompt on the home screen
async function pushPromptCard() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("pushAsk") === "no"; } catch { /* ignore */ }
  if (dismissed) return "";
  const st = await pushState();
  if (st !== "off" && st !== "install") return "";
  return `<div class="tip" id="pushTip"><span>🔔</span><span><b>Never miss a day.</b> ${st === "install"
    ? PUSH_TEXT.install
    : `Get a reminder when each quiz opens.<br><br><button class="btn btn-primary btn-sm" id="pushOn">Turn on reminders</button>`}</span>
    <button class="close" id="pushNo" aria-label="Close">×</button></div>`;
}
function bindPushPrompt() {
  $("#pushOn")?.addEventListener("click", async () => { if (await enablePush()) $("#pushTip")?.remove(); });
  $("#pushNo")?.addEventListener("click", () => { try { localStorage.setItem("pushAsk", "no"); } catch { /* ignore */ } $("#pushTip")?.remove(); });
}

// ==========================================================
// Boot + router
// ==========================================================
// Opening screen (සත්කාර · by Sithum De Zoysa): stays at least SPLASH_MIN ms from page start, then fades
const SPLASH_MIN = 1500;
let splashGone = false;
function hideSplash() {
  if (splashGone) return;
  splashGone = true;
  const el = document.getElementById("splash");
  if (!el) return;
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 500); }, Math.max(0, SPLASH_MIN - performance.now()));
}

if (!configured) {
  hideSplash();
  app.innerHTML = `<div class="wrap center"><img src="icons/icon-192.png" class="logo-lg" alt="">
    <h2>Almost ready</h2><p class="muted">The app isn't connected to its database yet.</p></div>`;
} else {
  sb.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") { recovering = true; location.hash = "newpass"; }
    if (event === "SIGNED_OUT") { me = null; location.hash = "login"; }
  });
  window.addEventListener("hashchange", route);
  route().finally(hideSplash);
}

async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { me = null; return null; }
  const { data } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  me = data ? { ...data, user: session.user } : null;
  markSeen();
  if (me?.lang) lang = me.lang;
  return me;
}

async function route() {
  const [view = "", a, b] = location.hash.slice(1).split("/");
  if (quiz && view !== "quiz") stopQuiz();
  window.scrollTo(0, 0);

  if (PUBLIC.includes(view)) {
    if (view === "newpass") return renderNewPass();
    if (!me) await loadMe();
    if (me) return go("home");
    if (view === "welcome") return renderWelcome();
    return view === "register" ? renderRegister() : renderLogin();
  }

  if (!me) await loadMe();
  if (!me) return go(seenBefore() ? "login" : "welcome");
  if (me.is_banned) return renderBanned();
  if (!me.nic || !me.full_name || !me.school) { if (view !== "complete") return go("complete"); return renderComplete(); }

  try {
    // Old links (#quiz/<day>, #ranks/<period>, #progress) are Physics
    const isDay = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || "");
    switch (view) {
      case "s": return await renderHome(isSubject(a) ? a : lastSubject());
      case "quiz": return isSubject(a) ? await renderQuiz(a, b) : await renderQuiz("phy", a);
      case "review": return isSubject(a) ? await renderReview(a, b) : await renderReview("phy", a);
      case "ranks": return isSubject(a) ? await renderRanks(a, b || "today") : await renderRanks(lastSubject(), a || "today");
      case "progress": return await renderProgress(isSubject(a) ? a : lastSubject());
      case "profile": return await renderProfile();
      case "admin": {
        if (!me.is_admin) return go("home");
        const mod = await import("./admin.js");
        return await mod.renderAdmin({ sb, me, app, a, b, c: location.hash.slice(1).split("/")[3], shell, go, adminBanner, setSubject, neutralTheme });
      }
      default: return isDay(a) ? await renderHome("phy") : await renderHub();
    }
  } catch (e) {
    console.error(e);
    shell("home", `<div class="empty">${esc(e.message || "Something went wrong.")}<br><br>
      <button class="btn btn-ghost btn-sm" onclick="location.reload()">Try again</button></div>`);
  }
}
function go(h) { if (location.hash.slice(1) === h) route(); else location.hash = h; }

// Page frame with bottom tab bar
function shell(active, inner) {
  const tabs = [
    ["home", "Home", `<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>`],
    ["ranks", "Ranks", `<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>`],
    ["progress", "Progress", `<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>`],
    ["profile", "Profile", `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`]
  ];
  if (me?.is_admin) tabs.push(["admin", "Admin", `<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>`]);
  app.innerHTML = `
    <div class="wrap has-nav">${inner}${inner.includes("class=\"footer") ? "" : signature()}</div>
    <nav class="tabbar">${tabs.map(([k, label, icon]) => `
      <a href="#${k}" class="${k === active ? "on" : ""}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
        <span>${label}</span></a>`).join("")}</nav>`;
}

function signature() { return `<p class="footer sig"><span lang="si">සත්කාර</span> · by <b>Sithum De Zoysa</b></p>`; }

// Header inside a subject section: subject icon + name, and a button back to the subject picker
function subjectHeader(s, right = "") {
  const S = SUBJECTS[s];
  return `<header class="top"><div class="brand">${subjIcon(S.key)}
    <div><b>${S.app}</b><small>by Sithum De Zoysa</small></div></div>${right}</header>`;
}
const subjectsChip = () => `<a class="subj-chip" href="#home" aria-label="All subjects"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/>
  <rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>Subjects</a>`;
// Physics | Chemistry switch at the top of Ranks / Progress
const subjectSwitch = (on, href) => `<div class="subj-seg">${SUBJECT_KEYS.map((k) => `<a class="${k} ${k === on ? "on" : ""}" href="${href(k)}">
  ${subjIcon(k)}${SUBJECTS[k].name}</a>`).join("")}</div>`;

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

// ==========================================================
// Auth screens
// ==========================================================
function authFrame(inner) {
  neutralTheme();
  app.innerHTML = `<div class="wrap auth">
    <div class="auth-head"><img src="icons/icon-192.png" class="logo-lg" alt="">
      <h1 class="si-title" lang="si">සත්කාර</h1><p class="muted">by <b>Sithum De Zoysa</b></p>
      <p class="muted" style="font-size:13px;margin-top:2px">Daily A/L Physics &amp; Chemistry MCQs</p></div>
    ${inner}</div>`;
}

// First screen on a phone that has never logged in
function renderWelcome() {
  authFrame(`
    <div class="card welcome">
      <h2>Welcome 👋</h2>
      <p class="muted">Practise A/L Physics and Chemistry with 10 new MCQs every day.</p>
      <ul class="pts"><li><i>✓</i><span>Full answers and working for every question</span></li>
        <li><i>✓</i><span>English, සිංහල and தமிழ்</span></li>
        <li><i>✓</i><span>Island-wide leaderboards. Completely free.</span></li></ul>
      <a class="btn btn-primary btn-block btn-big" href="#register">Create a free account</a>
      <p class="small">Takes about a minute.</p>
      <div class="or">already registered?</div>
      <a class="btn btn-outline btn-block btn-big" href="#login">I already have an account</a>
    </div>`);
}

function renderLogin() {
  authFrame(`
    <form class="card form" id="f">
      <h2>Log in</h2>
      <label>Email<input type="email" name="email" required autocomplete="email"></label>
      <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
      <p class="err" id="err"></p>
      <div class="new-cta" id="newCta" hidden><div><b>New to <span lang="si">සත්කාර</span>?</b><span>You need an account first.</span></div>
        <a class="btn btn-primary" href="#register">Create account →</a></div>
      <button class="btn btn-primary btn-block">Log in</button>
      <button type="button" class="link" id="forgot">Forgot password?</button>
    </form>
    <a class="btn btn-outline btn-block btn-big" href="#register" style="margin-top:16px">New here? Create a free account</a>`);
  const f = $("#f");
  f.password.oninput = () => f.password.classList.remove("bad");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    btn.disabled = false;
    if (error) {
      const unconfirmed = /confirm/i.test(error.message);
      $("#err").textContent = unconfirmed ? "Please confirm your email first (check your inbox)." : "Wrong email or password.";
      $("#newCta").hidden = unconfirmed; // a wrong login may mean they never signed up
      f.password.classList.toggle("bad", !unconfirmed);
      return;
    }
    await loadMe();
    go("home");
  };
  $("#forgot").onclick = async () => {
    const email = f.email.value.trim();
    if (!email) { $("#err").textContent = "Type your email above first."; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $("#err").textContent = error ? error.message : "";
    if (!error) toast("Password reset link sent to your email.");
  };
}

function profileFields(p = {}, withNic = true) {
  return `
    <label>Full name<input name="full_name" required value="${esc(p.full_name || "")}" autocomplete="name" placeholder="As on your NIC"></label>
    ${withNic ? `<label>NIC number<input name="nic" required value="${esc(p.nic || "")}" placeholder="200712345678 or 991234567V" autocapitalize="characters">
      <small>Used only to confirm you're a real student. Never shown to others.</small></label>` : ""}
    <label>School<input name="school" required value="${esc(p.school || "")}"></label>
    <div class="row2">
      <label>District<select name="district" required><option value="">Select</option>
        ${DISTRICTS.map((d) => `<option ${p.district === d ? "selected" : ""}>${d}</option>`).join("")}</select></label>
      <label>A/L year<select name="exam_year" required><option value="">Select</option>
        ${[2026, 2027, 2028, 2029].map((y) => `<option ${+p.exam_year === y ? "selected" : ""}>${y}</option>`).join("")}</select></label>
    </div>
    <label>WhatsApp number<input name="phone" type="tel" required value="${esc(p.phone || "")}" placeholder="07X XXX XXXX" autocomplete="tel"></label>`;
}

function readProfile(f, withNic = true) {
  const out = {
    full_name: f.full_name.value.trim().replace(/\s+/g, " "),
    school: f.school.value.trim(),
    district: f.district.value,
    exam_year: +f.exam_year.value || null,
    phone: normalizePhone(f.phone.value)
  };
  if (out.full_name.length < 3) return { error: "Please enter your full name." };
  if (!out.phone) return { error: "Please enter a valid phone number (07X XXX XXXX)." };
  if (withNic) {
    out.nic = normalizeNic(f.nic.value);
    if (!out.nic) return { error: "That NIC number doesn't look right. Check it and try again." };
  }
  return { data: out };
}

function renderRegister() {
  authFrame(`
    <form class="card form" id="f">
      <h2>Create account</h2>
      ${profileFields()}
      <label>Email<input type="email" name="email" required autocomplete="email"></label>
      <label>Password<input type="password" name="password" required minlength="6" autocomplete="new-password"><small>At least 6 characters.</small></label>
      <label>Question language<select name="lang">
        <option value="en">English</option><option value="si">සිංහල (Sinhala)</option><option value="ta">தமிழ் (Tamil)</option></select>
        <small>You can change this any time.</small></label>
      <label class="check"><input type="checkbox" name="agree" required>
        <span>I agree that my details are stored to run the quiz and leaderboards. Only my name and school are shown publicly.</span></label>
      <p class="err" id="err"></p>
      <button class="btn btn-primary btn-block">Create account</button>
    </form>
    <p class="center muted" style="margin-top:18px">Have an account? <a class="link" href="#login">Log in</a></p>`);
  const f = $("#f");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const { data: p, error: vErr } = readProfile(f);
    if (vErr) { $("#err").textContent = vErr; return; }
    const btn = e.submitter; btn.disabled = true; btn.textContent = "Creating…";
    const { data, error } = await sb.auth.signUp({
      email: f.email.value.trim(), password: f.password.value,
      options: { data: { ...p, exam_year: String(p.exam_year || "") }, emailRedirectTo: location.origin + location.pathname }
    });
    btn.disabled = false; btn.textContent = "Create account";
    if (error) { $("#err").textContent = error.message; return; }
    if (!data.session) {
      authFrame(`<div class="card center"><h2>Check your email ✉️</h2>
        <p class="muted">We sent a confirmation link to <b>${esc(f.email.value)}</b>. Tap it, then log in.</p>
        <a class="btn btn-primary" href="#login" style="margin-top:16px">Go to login</a></div>`);
      return;
    }
    const { error: nicErr } = await sb.rpc("set_my_nic", { p_nic: p.nic });
    const chosen = f.elements.lang.value; // (f.lang would be the form's own lang attribute)
    if (chosen !== "en") await sb.from("profiles").update({ lang: chosen }).eq("id", data.user.id);
    await loadMe();
    if (nicErr) { pendingError = nicErr.message; return go("complete"); }
    toast("Welcome! 🎉");
    go("home");
  };
}

function renderComplete() {
  const meta = me.user?.user_metadata || {};
  const pre = { ...meta, ...Object.fromEntries(Object.entries(me).filter(([, v]) => v)) };
  authFrame(`
    <form class="card form" id="f">
      <h2>Complete your profile</h2>
      <p class="muted" style="margin-bottom:14px">We need a few details before you start.</p>
      ${profileFields(pre, !me.nic)}
      <p class="err" id="err"></p>
      <button class="btn btn-primary btn-block">Save & continue</button>
      <button type="button" class="link" id="out">Log out</button>
    </form>`);
  const f = $("#f");
  if (pendingError) { $("#err").textContent = pendingError; pendingError = ""; }
  $("#out").onclick = () => sb.auth.signOut();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const { data: p, error: vErr } = readProfile(f, !me.nic);
    if (vErr) { $("#err").textContent = vErr; return; }
    const { nic, ...rest } = p;
    const { error } = await sb.from("profiles").update(rest).eq("id", me.id);
    if (error) { $("#err").textContent = error.message; return; }
    if (nic) {
      const { error: nErr } = await sb.rpc("set_my_nic", { p_nic: nic });
      if (nErr) { $("#err").textContent = nErr.message; return; }
    }
    await loadMe();
    go("home");
  };
}

function renderNewPass() {
  authFrame(`
    <form class="card form" id="f">
      <h2>Set a new password</h2>
      <label>New password<input type="password" name="pw" required minlength="6" autocomplete="new-password"></label>
      <p class="err" id="err"></p>
      <button class="btn btn-primary btn-block">Save password</button>
    </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: e.target.pw.value });
    if (error) { $("#err").textContent = recovering ? error.message : "Open the reset link from your email again."; return; }
    toast("Password updated.");
    recovering = false;
    await loadMe();
    go("home");
  };
}

function renderBanned() {
  authFrame(`<div class="card center">
    <h2>Account suspended</h2>
    <p class="muted">${me.ban_reason ? esc(me.ban_reason) + "<br><br>" : ""}If you think this is a mistake, contact us on WhatsApp.</p>
    <a class="btn btn-wa btn-block" href="https://wa.me/${WHATSAPP_NUMBER}" target="_blank" rel="noopener" style="margin:16px 0 10px">WhatsApp ${WHATSAPP_DISPLAY}</a>
    <button class="btn btn-ghost btn-block" id="out">Log out</button></div>`);
  $("#out").onclick = () => sb.auth.signOut();
}

// ==========================================================
// Home
// ==========================================================
// The rotating atom from the opening screen, shown small next to සත්කාර on the subject picker
const HUB_ATOM = `<svg class="hub-atom" viewBox="0 0 512 512" aria-hidden="true"><g fill="none" stroke-width="22">
  <g class="o"><ellipse cx="256" cy="256" rx="190" ry="70" stroke="#2563eb"/><circle cx="446" cy="256" r="22" fill="#2563eb" stroke="none"/></g>
  <g class="o o2"><ellipse cx="256" cy="256" rx="190" ry="70" stroke="#f59e0b" transform="rotate(60 256 256)"/></g>
  <g class="o o3"><ellipse cx="256" cy="256" rx="190" ry="70" stroke="#0f172a" transform="rotate(-60 256 256)"/></g></g>
  <circle class="n" cx="256" cy="256" r="40" fill="#ffc53d"/></svg>`;

// Subject picker (main screen after login)
async function renderHub() {
  neutralTheme();
  shell("home", `<div class="spinner"></div>`);
  const subs = mySubjects();
  const [hub, ...statuses] = await Promise.all([rpc("dq_hub"),
    ...(me.is_admin ? SUBJECT_KEYS.map((k) => rpc("dq_admin_status", { p_subject: k }).catch(() => null)) : [])]);
  clockOffset = Date.parse(hub.now) - Date.now();
  const today = hub.today;
  const closes = Date.parse(`${addDays(today, 1)}T00:00:00+05:30`);
  const pushCard = await pushPromptCard();

  const card = (x) => {
    const S = SUBJECTS[x.subject];
    const quizNo = (x.title || "").split(" - ")[0] || "Today's quiz";
    let status;
    if (!x.count) {
      status = `<div><b>No quiz today</b><small>New questions are on the way</small></div>`;
    } else if (x.submitted_at) {
      status = `<div><b>${esc(quizNo)} · Done ✓ ${x.score}/${x.total}</b><small>Rank #${x.rank} of ${x.participants} · answers open</small></div>
        <a class="btn btn-ghost" href="#review/${x.subject}/${today}">Review</a>`;
    } else if (x.started_at && Date.parse(x.deadline) > serverNow()) {
      status = `<div><b><span class="live-dot"></span>${esc(quizNo)} in progress</b><small>Timer: <b data-count="${Date.parse(x.deadline)}"></b> left</small></div>
        <a class="btn btn-${x.subject}" href="#quiz/${x.subject}/${today}">Continue</a>`;
    } else {
      status = `<div><b>${esc(quizNo)} is open</b><small>⏳ Closes at midnight · <b data-count="${closes}"></b> left</small></div>
        <button class="btn btn-${x.subject}" data-start="${x.subject}" data-n="${x.count}">Start →</button>`;
    }
    return `<div class="subj ${x.subject}">
      <a class="subj-top" href="#s/${x.subject}">${subjIcon(S.key)}
        <div><b>${S.name}</b><small>${S.app} · open →</small></div>
        <div class="subj-streak">🔥 ${x.streak}<small>day streak</small></div></a>
      <div class="subj-status">${status}</div></div>`;
  };

  const shown = hub.subjects.filter((x) => subs.includes(x.subject));

  shell("home", `
    <div class="hub-brand"><div class="hub-logo">${HUB_ATOM}<div><div class="si" lang="si">සත්කාර</div><small>by <b>Sithum De Zoysa</b></small></div></div>
      <span class="hello">Hi, ${esc(me.full_name.split(" ")[0])} 👋</span></div>
    ${statuses.map((st) => adminBanner(st)).join("")}
    ${pushCard}
    <h2 class="hub-q">Which subject today?</h2>
    ${shown.map(card).join("")}
    ${subs.length < SUBJECT_KEYS.length ? `<p class="hint center">More subjects can be turned on in <a class="link" href="#profile">Profile</a>.</p>` : ""}
    <p class="more-soon">More A/L subjects will be added soon. <b>Stay tuned!</b></p>
    <p class="footer"><span lang="si">සත්කාර</span> · by <b>Sithum De Zoysa</b> · <a href="https://wa.me/${WHATSAPP_NUMBER}" target="_blank" rel="noopener">WhatsApp</a></p>`);
  startCountdowns();
  bindPushPrompt();
  $$("[data-start]").forEach((btn) => btn.onclick = () => startQuiz(btn.dataset.start, today, +btn.dataset.n));
}

async function startQuiz(s, day, n) {
  const ok = await confirmBox(`Start today's ${SUBJECTS[s].name} quiz?`,
    `You'll have <b>${n * 2} minutes</b> for ${n} questions. The timer keeps running even if you close the app, and you get <b>one attempt</b>.
     <span class="anon-tip">${me.anon
       ? `🙈 You're hidden: your score shows as "Anonymous" on the leaderboard. You can show your real name any time from the Profile tab.`
       : `🏆 Your score will appear on the leaderboard with your name. You can choose to show your real name or "Anonymous" from the Profile tab.`}</span>`, "Start now");
  if (ok) go(`quiz/${s}/${day}`);
}

// One subject's home
async function renderHome(s) {
  setSubject(s);
  shell("home", `${subjectHeader(s, subjectsChip())}<div class="spinner"></div>`);
  const [home, stats, board, adminStatus] = await Promise.all([rpc("dq_home", { p_subject: s }), rpc("dq_stats", { p_subject: s }),
    rpc("dq_leaderboard", { p_period: "today", p_subject: s }),
    me.is_admin ? rpc("dq_admin_status", { p_subject: s }).catch(() => null) : null]);
  clockOffset = Date.parse(home.now) - Date.now();
  const today = home.today;
  const t = home.days.find((d) => d.day === today);
  const past = home.days.filter((d) => d.day !== today);
  const acc = stats.answered ? Math.round((stats.correct / stats.answered) * 100) : null;

  let card;
  if (!t) {
    card = `<div class="hero"><span class="label">Today · ${esc(niceDay(today))}</span>
      <h1>No quiz yet today</h1><p>Check back soon. New questions are on the way!</p></div>`;
  } else if (t.submitted_at) {
    const p = Math.round((t.score / t.total) * 100);
    card = `<div class="hero"><span class="label">Today · ${esc(niceDay(today))} · Done ✓</span>
      <h1>${esc(t.title || "Daily MCQs")}</h1>
      <div class="hero-score"><b>${t.score}<small>/${t.total}</small></b><span class="pill ${pctClass(p)}">${p}%</span>
        <span class="muted">in ${fmtTime(t.time_taken)}</span></div>
      <div class="row"><span class="muted">New questions tomorrow</span><a class="btn btn-primary" href="#review/${s}/${today}">Answers & rank</a></div></div>`;
  } else if (t.started_at && Date.parse(t.deadline) > serverNow()) {
    card = `<div class="hero"><span class="label">Today · In progress</span>
      <h1>${esc(t.title || "Daily MCQs")}</h1><p><span class="live-dot"></span> Your timer is running: <b data-count="${Date.parse(t.deadline)}"></b> left</p>
      <div class="row"><span></span><a class="btn btn-primary" href="#quiz/${s}/${today}">Continue →</a></div></div>`;
  } else {
    const closes = Date.parse(`${addDays(today, 1)}T00:00:00+05:30`);
    card = `<div class="hero"><span class="label">Today's quiz · ${esc(niceDay(today))}</span>
      <h1>${esc(t.title || "Daily MCQs")}</h1>
      <p>${t.count} questions · ${t.count * 2} minutes${t.topics?.length ? " · " + esc(t.topics.slice(0, 3).join(", ")) : ""}</p>
      <p class="closes">⏳ Closes at midnight · <b data-count="${closes}"></b> left</p>
      <div class="row"><span class="muted">One attempt only</span><button class="btn btn-primary" id="startBtn">Start quiz →</button></div></div>`;
  }

  const top = board.rows.slice(0, 3);
  shell("home", `
    ${subjectHeader(s, subjectsChip())}
    ${card}
    ${adminBanner(adminStatus)}
    <div class="stats">
      <div class="stat fire"><b>🔥 ${stats.streak}</b><small>Day streak</small></div>
      <div class="stat"><b>${stats.correct}<small class="muted">/${stats.answered}</small></b><small>Correct / answered</small></div>
      <div class="stat"><b>${acc == null ? "—" : acc + "%"}</b><small>Accuracy</small></div>
    </div>
    ${top.length ? `<h2 class="section-title">Today's top ${top.length} <a href="#ranks/${s}/today">Full ranking →</a></h2>
      <div class="card list-card">${top.map(rankRow).join("")}</div>` : ""}
    ${past.length ? `<h2 class="section-title">Previous days</h2>
      <div class="days">${past.map((d) => {
        const done = !!d.submitted_at;
        const p = done ? Math.round((d.score / d.total) * 100) : 0;
        const dt = new Date(d.day + "T00:00:00");
        return `<a class="day" href="#review/${s}/${d.day}">
          <span class="date"><b>${dt.getDate()}</b><small>${dt.toLocaleDateString("en-GB", { month: "short" })}</small></span>
          <span class="info"><b>${esc(d.title || "Daily MCQs")}</b><small>${d.count} questions${done ? ` · ${fmtTime(d.time_taken)}` : " · view answers"}</small></span>
          ${done ? `<span class="pill ${pctClass(p)}">${d.score}/${d.total}</span>` : `<span class="pill">Missed</span>`}</a>`;
      }).join("")}</div>` : ""}
    <p class="footer"><span lang="si">සත්කාර</span> · by <b>Sithum De Zoysa</b> · <a href="https://wa.me/${WHATSAPP_NUMBER}" target="_blank" rel="noopener">WhatsApp</a></p>`);

  startCountdowns();
  $("#startBtn")?.addEventListener("click", () => startQuiz(s, today, t.count));
}

function startCountdowns() {
  const tick = () => {
    const els = $$("[data-count]");
    if (!els.length) return clearInterval(timer);
    els.forEach((el) => {
      const left = (+el.dataset.count - serverNow()) / 1000;
      el.textContent = left > 3600 ? `${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m` : fmtTime(left);
      if (left <= 0) { clearInterval(timer); setTimeout(route, 1500); }
    });
  };
  const timer = setInterval(tick, 1000);
  tick();
}

// ==========================================================
// Quiz
// ==========================================================
function stopQuiz() {
  if (!quiz) return;
  clearInterval(quiz.timer);
  clearTimeout(quiz.saveTimer);
  quiz = null;
}

async function renderQuiz(s, day) {
  setSubject(s);
  app.innerHTML = `<div class="wrap"><div class="spinner"></div></div>`;
  const st = await rpc("dq_start", { p_day: day, p_subject: s });
  if (st.submitted) return go(`review/${s}/${day}`);

  let local = {};
  try { local = JSON.parse(localStorage.getItem(`dq:${s}:${day}`)) || {}; } catch { /* ignore */ }
  quiz = {
    subject: s, day, title: st.title, qs: st.questions,
    answers: { ...st.answers, ...local },
    i: 0, reviewing: false, submitting: false,
    deadline: Date.now() + st.seconds_left * 1000
  };
  const firstOpen = quiz.qs.findIndex((q) => quiz.answers[q.id] == null);
  quiz.i = firstOpen < 0 ? 0 : firstOpen;
  if (st.seconds_left <= 0) return submitQuiz(true);

  drawQuiz();
  quiz.timer = setInterval(() => {
    const left = (quiz.deadline - Date.now()) / 1000;
    const el = $("#timeLeft");
    if (el) { el.textContent = fmtTime(left); el.parentElement.classList.toggle("low", left <= 60); }
    if (left <= 0) submitQuiz(true);
  }, 500);
}

function drawQuiz() {
  const z = quiz;
  const answered = z.qs.filter((q) => z.answers[q.id] != null).length;
  const head = `
    <div class="qtop">
      <div class="qtop-row">
        <button class="back" id="leave" aria-label="Leave">✕</button>
        <div class="qtop-title"><b>${esc(z.title || "Daily MCQs")}</b><small>${answered}/${z.qs.length} answered</small></div>
        <div class="timer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg>
          <span id="timeLeft">${fmtTime((z.deadline - Date.now()) / 1000)}</span></div>
      </div>
      <div class="lang-row">${langSwitch()}</div>
      <div class="qnums">${z.qs.map((q, k) => `<button class="qn ${z.answers[q.id] != null ? "done" : ""} ${!z.reviewing && k === z.i ? "cur" : ""}" data-go="${k}">${k + 1}</button>`).join("")}</div>
    </div>`;

  if (z.reviewing) {
    const left = z.qs.length - answered;
    app.innerHTML = `<div class="wrap">${head}
      <div class="card center">
        <h2>Ready to submit?</h2>
        <p class="muted" style="margin:8px 0 18px">You've answered <b>${answered}</b> of ${z.qs.length}.
          ${left ? `<br><span class="warn-text">${left} unanswered. Tap a number above to go back.</span>` : ""}</p>
        <button class="btn btn-primary btn-block" id="submitBtn">Submit answers</button>
        <button class="btn btn-ghost btn-block" id="backBtn" style="margin-top:10px">← Back to questions</button>
      </div></div>`;
    $("#backBtn").onclick = () => { z.reviewing = false; drawQuiz(); };
    $("#submitBtn").onclick = async () => {
      const ok = await confirmBox("Submit your answers?",
        `${left ? `<b>${left} question${left > 1 ? "s are" : " is"} unanswered.</b> ` : ""}You can't change anything after submitting.`, "Submit");
      if (ok) submitQuiz(false);
    };
  } else {
    const q = z.qs[z.i];
    const t = tx(q);
    const mine = z.answers[q.id];
    const last = z.i === z.qs.length - 1;
    app.innerHTML = `<div class="wrap quiz-wrap">${head}
      <div class="qcard" lang="${t.fallback ? "en" : lang}">
        <div class="qmeta"><span class="n">Question ${z.i + 1}</span>${q.topic ? `<span class="topic">${esc(q.topic)}</span>` : ""}</div>
        ${t.fallback ? fallbackNote() : ""}
        ${q.image_url ? `<img class="qimg" src="${esc(q.image_url)}" alt="Diagram">` : ""}
        <div class="qtext">${fmt(t.body)}</div>
        <div class="opts">${t.options.map((o, k) => `
          <button class="opt ${mine === k ? "picked" : ""}" data-k="${k}"><span class="l">${LETTERS[k]}</span><span>${fmt(o)}</span></button>`).join("")}</div>
        ${mine != null ? `<button class="link clear" id="clear">Clear my answer</button>` : `<p class="hint">Tap an answer. You can change it any time before submitting.</p>`}
      </div>
      <div class="qbar">
        <button class="btn btn-ghost" id="prev" ${z.i === 0 ? "disabled" : ""}>←</button>
        <button class="btn btn-primary" id="next">${last ? "Finish & review" : "Next →"}</button>
      </div></div>`;
    $$(".opt").forEach((b) => b.onclick = () => pick(+b.dataset.k));
    $("#clear")?.addEventListener("click", () => pick(null));
    $("#prev").onclick = () => { z.i--; drawQuiz(); };
    $("#next").onclick = () => { if (last) z.reviewing = true; else z.i++; drawQuiz(); window.scrollTo(0, 0); };
  }
  $$("[data-go]").forEach((b) => b.onclick = () => { z.reviewing = false; z.i = +b.dataset.go; drawQuiz(); });
  bindLangSwitch(drawQuiz);
  $("#leave").onclick = async () => {
    const ok = await confirmBox("Leave the quiz?", "Your answers are saved, but <b>the timer keeps running</b>. Come back before it ends.", "Leave");
    if (ok) go(`s/${z.subject}`);
  };
}

function pick(k) {
  const z = quiz;
  const id = z.qs[z.i].id;
  if (k == null || z.answers[id] === k) delete z.answers[id]; else z.answers[id] = k;
  try { localStorage.setItem(`dq:${z.subject}:${z.day}`, JSON.stringify(z.answers)); } catch { /* ignore */ }
  try { navigator.vibrate?.(10); } catch { /* ignore */ }
  clearTimeout(z.saveTimer);
  z.saveTimer = setTimeout(() => sb.rpc("dq_save", { p_day: z.day, p_answers: z.answers, p_subject: z.subject }), 700);
  drawQuiz();
}

async function submitQuiz(auto) {
  const z = quiz;
  if (!z || z.submitting) return;
  z.submitting = true;
  clearInterval(z.timer);
  clearTimeout(z.saveTimer);
  app.innerHTML = `<div class="wrap center"><div class="spinner"></div><p class="muted">${auto ? "Time's up! Submitting…" : "Submitting…"}</p></div>`;
  for (let tries = 0; tries < 5; tries++) {
    const { error } = await sb.rpc("dq_submit", { p_day: z.day, p_answers: z.answers, p_subject: z.subject });
    if (!error) {
      try { localStorage.removeItem(`dq:${z.subject}:${z.day}`); } catch { /* ignore */ }
      quiz = null;
      if (auto) toast("Time's up. Your answers were submitted.");
      return go(`review/${z.subject}/${z.day}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
  }
  z.submitting = false;
  app.innerHTML = `<div class="wrap center"><h2>Couldn't submit</h2>
    <p class="muted">Check your internet connection. Your answers are saved on this phone.</p>
    <button class="btn btn-primary" id="retry" style="margin-top:16px">Try again</button></div>`;
  $("#retry").onclick = () => submitQuiz(auto);
}

// ==========================================================
// Review / results
// ==========================================================
async function renderReview(s, day) {
  setSubject(s);
  const S = SUBJECTS[s];
  shell("home", `<div class="spinner"></div>`);
  const r = await rpc("dq_review", { p_day: day, p_subject: s });
  const qs = r.questions || [];
  const status = (q) => (!r.attempted ? "none" : q.yours == null ? "skip" : q.yours === q.correct ? "right" : "wrong");
  const counts = { right: 0, wrong: 0, skip: 0 };
  qs.forEach((q) => counts[status(q)] != null && counts[status(q)]++);
  const pct = r.attempted && r.total ? Math.round((r.score / r.total) * 100) : 0;
  const color = pct >= 75 ? "#16a34a" : pct >= 50 ? "#f59e0b" : "#dc2626";
  const url = location.origin + location.pathname;
  const shareText = `I scored ${r.score}/${r.total} on ${S.app} by Sithum De Zoysa ${S.emoji}${r.rank ? ` (rank #${r.rank})` : ""}! Try today's A/L ${S.name} MCQs on සත්කාර: ${url}`;

  const header = r.attempted ? `
    <div class="result card">
      <div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" style="stroke:var(--line)" stroke-width="10" fill="none"/>
        <circle id="arc" cx="60" cy="60" r="52" stroke="${color}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="326.7" stroke-dashoffset="326.7" style="transition:stroke-dashoffset 1s ease"/></svg>
        <div class="v"><b>${r.score}/${r.total}</b><small>${pct}%</small></div></div>
      <h2>${pct === 100 ? "Perfect score! 🏆" : pct >= 75 ? "Excellent work!" : pct >= 50 ? "Good effort!" : "Keep practising!"}</h2>
      <div class="result-stats">
        <div><b class="g">${counts.right}</b><small>Correct</small></div>
        <div><b class="r">${counts.wrong}</b><small>Wrong</small></div>
        <div><b>${counts.skip}</b><small>Skipped</small></div>
        <div><b>${fmtTime(r.time_taken)}</b><small>Time</small></div>
      </div>
      <p class="rank-line">🏅 Rank <b>#${r.rank}</b> of ${r.participants}${day === todayGuess() ? " so far" : ""} · Class average <b>${Math.round(r.avg_pct ?? 0)}%</b></p>
      <p class="sig-line">Questions &amp; methods by <b>Sithum De Zoysa</b></p>
      <div class="sheet-btns"><button class="btn btn-wa" id="share">Share score</button><a class="btn btn-ghost" href="#ranks/${s}/today">Leaderboard</a></div>
    </div>` : `
    <div class="card"><h2>${esc(r.title || "Daily MCQs")}</h2>
      <p class="muted">You missed this day. Here are the questions with answers and methods.
      ${r.participants ? `<br>${r.participants} student${r.participants === 1 ? "" : "s"} took it · average ${Math.round(r.avg_pct ?? 0)}%.` : ""}</p></div>`;

  let filter = "all";
  let animated = false;
  const applyFilter = () => {
    $$("#filter button").forEach((x) => x.classList.toggle("on", x.dataset.f === filter));
    $$(".review-list .qcard").forEach((c) => c.classList.toggle("hidden", filter !== "all" && c.dataset.s !== filter));
  };

  // Drawn as a function so switching language redraws in place (same scroll position, same filter)
  const draw = () => {
    const y = window.scrollY;
    shell("home", `
      <div class="qtop plain"><div class="qtop-row"><a class="back" href="#s/${s}" aria-label="Back">←</a>
        <div class="qtop-title"><b>${esc(r.title || "Daily MCQs")}</b><small>${esc(niceDay(day))}</small></div></div></div>
      ${header}
      <h2 class="section-title">Answers & methods ${langSwitch()}</h2>
      ${r.attempted ? `<div class="seg" id="filter">
        <button data-f="all">All</button><button data-f="wrong">Wrong (${counts.wrong})</button>
        <button data-f="skip">Skipped (${counts.skip})</button><button data-f="right">Correct</button></div>` : ""}
      <div class="review-list">${qs.map((q, i) => {
        const s = status(q);
        const t = tx(q);
        return `<div class="qcard r-${s}" data-s="${s}" lang="${t.fallback ? "en" : lang}">
          <div class="qmeta"><span class="n">Q${i + 1}</span>
            ${s === "right" ? `<span class="tag ok">✓ Correct</span>` : s === "wrong" ? `<span class="tag no">✗ Wrong</span>` : s === "skip" ? `<span class="tag">Skipped</span>` : q.topic ? `<span class="topic">${esc(q.topic)}</span>` : ""}</div>
          ${t.fallback ? fallbackNote() : ""}
          ${q.image_url ? `<img class="qimg" src="${esc(q.image_url)}" alt="">` : ""}
          <div class="qtext sm">${fmt(t.body)}</div>
          <div class="opts">${t.options.map((o, k) => `
            <div class="opt ${k === q.correct ? "right" : k === q.yours ? "wrong" : "dim"}"><span class="l">${LETTERS[k]}</span><span>${fmt(o)}</span></div>`).join("")}</div>
          ${t.explain ? `<div class="method"><b>Method:</b> ${fmt(t.explain)}</div>` : ""}
          <button class="link report-link" data-report="${q.id}" data-n="${i + 1}">${reported.has(q.id) ? "✓ Reported. Thanks!" : "⚑ Report a mistake"}</button>
        </div>`;
      }).join("")}</div>`);

    const arc = $("#arc");
    if (arc && animated) arc.style.transition = "none";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (arc) arc.style.strokeDashoffset = 326.7 * (1 - pct / 100);
      animated = true;
    }));
    $("#share")?.addEventListener("click", async () => {
      if (navigator.share) { try { await navigator.share({ text: shareText }); } catch { /* cancelled */ } }
      else window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank", "noopener");
    });
    $$("#filter button").forEach((b) => b.onclick = () => { filter = b.dataset.f; applyFilter(); });
    applyFilter();
    bindLangSwitch(draw);
    $$("[data-report]").forEach((b) => b.onclick = () => openReport(b.dataset.report, b.dataset.n, () => draw()));
    window.scrollTo(0, y);
  };
  draw();
}
const todayGuess = () => new Date(Date.now() + clockOffset + 5.5 * 3600e3).toISOString().slice(0, 10);

// ==========================================================
// Leaderboards
// ==========================================================
const PERIODS = [["today", "Today"], ["week", "7 days"], ["month", "30 days"], ["all", "All time"]];

function rankRow(r) {
  const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`;
  // Hidden students: others get "Anonymous" from the server; show yourself the same way.
  // The admin still receives real names, marked as hidden.
  const name = r.anon && r.me ? "Anonymous" : r.name;
  const school = r.anon && r.me ? "Anonymous" : `${r.school || ""}${r.anon && name !== "Anonymous" ? " · hidden" : ""}`;
  return `<div class="rank-row ${r.me ? "me" : ""} ${r.anon ? "anon" : ""}">
    <span class="rk">${medal}</span>
    <span class="who"><b>${r.anon ? "🙈 " : ""}${esc(name)}${r.me ? " (you)" : ""}</b><small>${esc(school)}</small></span>
    <span class="sc"><b>${r.correct}</b><small>${r.pct != null ? Math.round(r.pct) + "%" : ""}</small></span>
    <span class="tm"><b>${fmtTime(r.avg_time)}</b><small>avg</small></span>
  </div>`;
}

async function renderRanks(s, period) {
  setSubject(s);
  if (!PERIODS.some(([k]) => k === period)) period = "today";
  const seg = `<div class="seg">${PERIODS.map(([k, l]) => `<a href="#ranks/${s}/${k}" class="${k === period ? "on" : ""}">${l}</a>`).join("")}</div>`;
  shell("ranks", `<h1 class="page-title">Leaderboard</h1>${subjectSwitch(s, (k) => `#ranks/${k}/${period}`)}${seg}<div class="spinner"></div>`);
  const b = await rpc("dq_leaderboard", { p_period: period, p_subject: s });
  const mine = b.rows.find((r) => r.me);
  const top = b.rows.filter((r) => r.rank <= 100);
  const outside = mine && mine.rank > 100;

  shell("ranks", `
    <h1 class="page-title">Leaderboard</h1>${subjectSwitch(s, (k) => `#ranks/${k}/${period}`)}${seg}
    <p class="board-note">Ranked by correct answers out of <b>${b.total_questions}</b> questions
      ${period === "today" ? "today" : `over ${b.days} day${b.days === 1 ? "" : "s"}`}. A missed day counts as zero.
      Ties go to the <b>lower average time per quiz</b>.</p>
    ${mine ? `<div class="my-rank"><span>Your rank</span><b>#${mine.rank}</b><span>${mine.correct}/${b.total_questions} · ${Math.round(mine.pct)}% · avg ${fmtTime(mine.avg_time)}${mine.anon ? `<br><small class="muted">🙈 Shown as Anonymous</small>` : ""}</span></div>` : ""}
    ${top.length ? `<div class="card list-card">
      <div class="rank-row head"><span class="rk">#</span><span class="who">Student</span><span class="sc">Correct</span><span class="tm">Time</span></div>
      ${top.map(rankRow).join("")}
      ${outside ? `<div class="rank-gap">⋯</div>${rankRow(mine)}` : ""}</div>`
    : `<div class="empty">No one on the board yet. Be the first! 🚀</div>`}`);
}

// ==========================================================
// Progress
// ==========================================================
async function renderProgress(subject) {
  setSubject(subject);
  shell("progress", `<h1 class="page-title">My progress</h1>${subjectSwitch(subject, (k) => `#progress/${k}`)}<div class="spinner"></div>`);
  const s = await rpc("dq_stats", { p_subject: subject });
  const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : null;
  const overall = s.questions ? Math.round((s.correct / s.questions) * 100) : null;
  const h = s.history;

  shell("progress", `
    <h1 class="page-title">My progress</h1>${subjectSwitch(subject, (k) => `#progress/${k}`)}
    <div class="tiles">
      <div class="tile big"><small>Correct answers</small><b>${s.correct}<span>/${s.answered}</span></b><em>${acc == null ? "No answers yet" : `${acc}% accuracy on answered questions`}</em></div>
      <div class="tile"><small>Quizzes done</small><b>${s.quizzes}<span>/${s.days_released}</span></b></div>
      <div class="tile"><small>Overall score</small><b>${overall == null ? "—" : overall + "%"}</b></div>
      <div class="tile"><small>Current streak</small><b>🔥 ${s.streak}</b></div>
      <div class="tile"><small>Best streak</small><b>${s.best_streak}</b></div>
      <div class="tile"><small>Avg time / quiz</small><b>${fmtTime(s.avg_time)}</b></div>
      <div class="tile"><small>Best rank</small><b>${h.length ? "#" + Math.min(...h.map((x) => x.rank)) : "—"}</b></div>
    </div>
    <div class="card"><h3 class="card-title">Marks by day</h3><div id="chart"></div></div>
    <div class="card"><h3 class="card-title">Accuracy by topic</h3>
      ${barList(s.topics.map((t) => ({ label: t.topic, correct: t.correct, total: t.total })))}
      ${s.topics.length > 1 ? `<p class="hint">Work on the lowest bars first. That's where the easiest marks are.</p>` : ""}</div>
    <h2 class="section-title">History</h2>
    ${h.length ? `<div class="days">${[...h].reverse().map((d) => {
      const p = Math.round((d.score / d.total) * 100);
      const dt = new Date(d.day + "T00:00:00");
      return `<a class="day" href="#review/${subject}/${d.day}">
        <span class="date"><b>${dt.getDate()}</b><small>${dt.toLocaleDateString("en-GB", { month: "short" })}</small></span>
        <span class="info"><b>${esc(d.title || "Daily MCQs")}</b><small>Rank #${d.rank} of ${d.participants} · ${fmtTime(d.time_taken)}</small></span>
        <span class="pill ${pctClass(p)}">${d.score}/${d.total}</span></a>`;
    }).join("")}</div>` : `<div class="empty">Do your first daily quiz to start tracking progress.</div>`}`);

  lineChart($("#chart"), h.map((d) => niceDay(d.day, { day: "numeric", month: "short" })), [
    { name: "You", color: SUBJECTS[subject].series.you, values: h.map((d) => (d.total ? (d.score / d.total) * 100 : null)) },
    { name: "Class average", color: SUBJECTS[subject].series.avg, values: h.map((d) => (d.avg_pct == null ? null : +d.avg_pct)) }
  ]);
}

// ==========================================================
// Profile
// ==========================================================
async function renderProfile() {
  neutralTheme();
  const push = await pushState();
  const subs = mySubjects();
  shell("profile", `
    <h1 class="page-title">Profile</h1>
    <div class="card profile-card">
      <div class="avatar">${esc(me.full_name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase())}</div>
      <h2>${esc(me.full_name)}</h2><p class="muted">${esc(me.school)}</p>
    </div>
    <div class="card">
      <h3 class="card-title">My subjects</h3>
      <div class="subj-rows">${SUBJECT_KEYS.map((k) => `
        <label class="subj-row">${subjIcon(k)}<span class="t"><b>${SUBJECTS[k].name}</b><small>Daily quiz + reminders</small></span>
          <input type="checkbox" class="switch" data-subj="${k}" ${subs.includes(k) ? "checked" : ""}></label>`).join("")}</div>
      <p class="hint">One account for every subject. Turn one off to hide it from your home screen and stop its reminders.</p>
    </div>
    <div class="card">
      <h3 class="card-title">Leaderboard privacy</h3>
      <label class="subj-row"><span class="anon-ic">🙈</span><span class="t"><b>Hide my name on leaderboards</b><small>Show me as "Anonymous"</small></span>
        <input type="checkbox" class="switch" id="anonSw" ${me.anon ? "checked" : ""}></label>
      <p class="hint">Your name and school will show as "Anonymous" to other students. Your teacher can still see your marks.</p>
    </div>
    <div class="card">
      <dl class="kv">
        <dt>Email</dt><dd>${esc(me.email)}</dd>
        <dt>NIC</dt><dd>${esc(maskNic(me.nic))}</dd>
        <dt>District</dt><dd>${esc(me.district || "—")}</dd>
        <dt>A/L year</dt><dd>${esc(me.exam_year || "—")}</dd>
        <dt>WhatsApp</dt><dd>${esc(me.phone || "—")}</dd>
      </dl>
      <button class="btn btn-ghost btn-block" id="edit" style="margin-top:14px">Edit details</button>
    </div>
    <div class="card">
      <h3 class="card-title">🌐 Question language</h3>
      <p class="muted" style="font-size:14px;margin-bottom:12px">Questions, answers and methods appear in this language. You can also switch any time during a quiz.</p>
      ${langSwitch(true)}
    </div>
    <div class="card">
      <h3 class="card-title">🔔 Daily reminders ${push === "on" ? '<span class="pill good">On</span>' : ""}</h3>
      <p class="muted" style="font-size:14px">${PUSH_TEXT[push]}</p>
      ${push === "on" ? `<button class="btn btn-ghost btn-block" id="pushToggle" style="margin-top:12px">Turn off</button>`
        : push === "off" ? `<button class="btn btn-primary btn-block" id="pushToggle" style="margin-top:12px">Turn on reminders</button>` : ""}
    </div>
    <a class="btn btn-wa btn-block" href="https://wa.me/${WHATSAPP_NUMBER}" target="_blank" rel="noopener">Contact Sithum on WhatsApp</a>
    <button class="btn btn-ghost btn-block" id="out" style="margin-top:10px">Log out</button>
    <p class="footer">Your NIC and phone are private. Only your name and school appear on leaderboards.</p>`);
  $("#out").onclick = () => sb.auth.signOut();
  $$("[data-subj]").forEach((cb) => cb.onchange = async () => {
    const next = $$("[data-subj]").filter((x) => x.checked).map((x) => x.dataset.subj);
    if (!next.length) { cb.checked = true; toast("Keep at least one subject on."); return; }
    const { error } = await sb.from("profiles").update({ subjects: next }).eq("id", me.id);
    if (error) { cb.checked = !cb.checked; toast("Couldn't save: " + error.message); return; }
    me.subjects = next;
    toast(`${SUBJECTS[cb.dataset.subj].name} ${cb.checked ? "on" : "off"}.`);
  });
  $("#anonSw").onchange = async (e) => {
    const on = e.target.checked;
    const { error } = await sb.from("profiles").update({ anon: on }).eq("id", me.id);
    if (error) { e.target.checked = !on; toast("Couldn't save: " + error.message); return; }
    me.anon = on;
    toast(on ? "🙈 You'll show as \"Anonymous\" on leaderboards." : "Your name will show on leaderboards.");
  };
  bindLangSwitch(() => { toast(`Questions will be shown in ${LANG_NAMES[lang]}.`); renderProfile(); });
  $("#pushToggle")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    if (push === "on") await disablePush(); else await enablePush();
    renderProfile();
  });
  $("#edit").onclick = () => {
    const { el, close } = sheet(`<form class="form" id="pf"><h3>Edit details</h3>${profileFields(me, false)}
      <p class="hint">To change your NIC, contact the admin.</p><p class="err" id="perr"></p>
      <div class="sheet-btns"><button type="button" class="btn btn-ghost" id="cancel">Cancel</button><button class="btn btn-primary">Save</button></div></form>`);
    $("#cancel", el).onclick = close;
    $("#pf", el).onsubmit = async (e) => {
      e.preventDefault();
      const { data, error: vErr } = readProfile(e.target, false);
      if (vErr) { $("#perr", el).textContent = vErr; return; }
      const { error } = await sb.from("profiles").update(data).eq("id", me.id);
      if (error) { $("#perr", el).textContent = error.message; return; }
      await loadMe();
      close();
      toast("Saved.");
      renderProfile();
    };
  };
}

// ==========================================================
// Service worker (offline app shell)
// ==========================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {}));
  // When a new version of the app takes over, reload once so the new code runs straight away
  // (only for updates — not the very first install — and never mid-quiz or while typing)
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
    if (reloaded || !hadController || quiz || typing) return;
    reloaded = true;
    location.reload();
  });
}

// ==========================================================
// Report a mistake (students) + admin schedule banner
// ==========================================================
const reported = new Set();
const REPORT_REASONS = ["Wrong answer", "Typo / wording", "Unclear question", "Translation issue", "Other"];

function openReport(qid, n, done) {
  const { el, close } = sheet(`<form class="form" id="rf"><h3>Report Q${esc(n)}</h3>
    <p class="muted" style="margin-bottom:12px">Found a mistake? Sithum De Zoysa will check it. If an answer is corrected, everyone is re-marked automatically.</p>
    <div class="chips-pick">${REPORT_REASONS.map((r, i) => `<label><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? "checked" : ""}><span>${esc(r)}</span></label>`).join("")}</div>
    <label style="margin-top:12px">Details (optional)<textarea name="msg" rows="3" maxlength="500" placeholder="e.g. I think the answer should be 3 because…"></textarea></label>
    <p class="err" id="re"></p>
    <div class="sheet-btns"><button type="button" class="btn btn-ghost" id="rc">Cancel</button><button class="btn btn-primary">Send report</button></div></form>`);
  $("#rc", el).onclick = close;
  $("#rf", el).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const { error } = await sb.rpc("dq_report", { p_question: qid, p_reason: f.reason.value, p_message: f.msg.value.trim() });
    if (error) { $("#re", el).textContent = error.message; return; }
    reported.add(qid);
    close();
    toast("Thanks! Sithum will check it.");
    done?.();
  };
}

function adminBanner(st) {
  if (!st) return "";
  const parts = [];
  const name = SUBJECTS[st.subject || "phy"].name;
  if (!st.tomorrow_count) {
    parts.push(`⚠️ <b>No ${name} quiz scheduled for tomorrow.</b> Ask Claude to add it.`);
  } else if (st.days_ahead < 3) {
    parts.push(`📅 ${name}: only <b>${st.days_ahead} day${st.days_ahead === 1 ? "" : "s"}</b> scheduled ahead. Next empty day: <b>${esc(niceDay(st.next_empty_day))}</b>.`);
  }
  if (st.open_reports) parts.push(`⚑ <b>${st.open_reports}</b> ${name} question report${st.open_reports === 1 ? "" : "s"} to check. <a class="link" href="#admin/reports">Open</a>`);
  return parts.length ? `<div class="banner admin-banner">${parts.join("<br>")}</div>` : "";
}
export { adminBanner };
