"use strict";
/* Vyra AI web app. No inline handlers anywhere (the page's security policy forbids them). */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ico = (n, cls = "") => `<svg class="ico ${cls}"><use href="#i-${n}"/></svg>`;
const money = (n) => "₦" + Number(n).toLocaleString("en-NG");
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return ""; } };

const S = {
  user: null, usage: null, images: null, plans: {}, paystack: document.body.dataset.paystack === "1",
  conv: null, projectId: null, msgs: [], busy: false, abort: null, mode: store.get("vyra-mode") || "deep",
  fileText: "", fileName: "", editFromId: null, chats: [], personas: [], lbMode: "weekly",
  pendingEmail: "", page: "chat", adminTab: "overview", imgStyle: "", historyView: "active",
  length: store.get("vyra-length") || "normal", tone: store.get("vyra-tone") || "friendly", eli5: store.get("vyra-eli5") === "1",
};

/* ---------------------------------------------------------------- adaptive device experience */
(function adaptiveDeviceProfile(){
  const root=document.documentElement, body=document.body;
  const ua=navigator.userAgent||"";
  const width=()=>window.innerWidth||root.clientWidth||0;
  function profile(){
    const w=width();
    const kind=w<600?"phone":w<1024?"tablet":"desktop";
    const uaType=/iphone|ipod/i.test(ua)?"iphone":/ipad/i.test(ua)?"ipad":/android/i.test(ua)?"android":/windows/i.test(ua)?"windows":/macintosh|mac os/i.test(ua)?"mac":/linux/i.test(ua)?"linux":"other";
    body.dataset.device=kind; body.dataset.platform=uaType;
    body.dataset.touch=(navigator.maxTouchPoints>0||matchMedia("(pointer: coarse)").matches)?"yes":"no";
    root.style.setProperty("--vyra-vh",`${window.innerHeight*0.01}px`);
    root.style.setProperty("--vyra-width",`${w}px`);
  }
  profile(); window.addEventListener("resize",profile,{passive:true}); window.addEventListener("orientationchange",profile,{passive:true});
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) body.dataset.reduceMotion="yes";
  // Network status is surfaced unobtrusively and never blocks the chat.
  let net=document.getElementById("vyra-network-status");
  if(!net){net=document.createElement("div");net.id="vyra-network-status";net.setAttribute("role","status");net.setAttribute("aria-live","polite");net.className="network-status";document.body.appendChild(net);}
  function network(){const offline=!navigator.onLine; net.textContent=offline?"You're offline. Chat and online tools will resume when connection returns.":"Back online.";net.classList.toggle("show",offline); if(!offline){net.classList.add("online-flash");setTimeout(()=>net.classList.remove("online-flash"),1800);}}
  window.addEventListener("offline",network); window.addEventListener("online",network); network();
})();

/* ---------------------------------------------------------------- helpers */
async function api(url, opts = {}) {
  const headers = { "X-Requested-With": "vyra", ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  let res;
  const ctrl = (!opts.signal && typeof AbortController !== "undefined") ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 45000) : null; // never hang forever on a sleeping server
  try { res = await fetch(url, { credentials: "same-origin", ...(ctrl ? { signal: ctrl.signal } : {}), ...opts, headers }); if (timer) clearTimeout(timer); }
  catch (e) { if (timer) clearTimeout(timer); throw new Error("You're offline or the server is unreachable. Check your connection and try again."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || "Something went wrong. Please try again."); err.status = res.status; err.data = data; throw err; }
  return data;
}
const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body || {}) });
function toast(msg, type = "") {
  const el = document.createElement("div"); el.className = "toast " + type; el.textContent = msg; $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (_) {} t.remove(); return ok; }
}
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModals() { document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden")); }
function setBtn(btn, busy, label) { btn.disabled = busy; if (label !== undefined) btn.innerHTML = label; }

/* ---------------------------------------------------------------- safe markdown */
function inline(s) {
  return s.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return `<code class="inline">${part.slice(1, -1)}</code>`;
    return part
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, "$1<em>$2</em>");
  }).join("");
}
function codeHtml(b) {
  return `<div class="code-block"><div class="code-head"><span>${esc(b.lang || "code")}</span><button type="button" class="btn sm ghost" data-copy-code>${ico("copy", "sm")}Copy</button></div><pre><code>${esc(b.code)}</code></pre></div>`;
}
function md(src) {
  const blocks = [];
  src = String(src).replace(/```([\w+#-]*)[ \t]*\n?([\s\S]*?)(```|$)/g, (m, lang, code) => { blocks.push({ lang, code: code.replace(/\n$/, "") }); return `\u0000B${blocks.length - 1}\u0000`; });
  const out = []; let list = null, para = [];
  const flush = () => { if (para.length) { out.push("<p>" + inline(para.join("<br>")) + "</p>"); para = []; } };
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const lines = esc(src).split("\n");
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?[\s:-]+\|[\s:|-]*\|?\s*$/.test(l) && l.includes("-");
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]; let m;
    if (isRow(line) && isSep(lines[li + 1] || "")) {
      flush(); close();
      const head = cells(line); const body = [];
      li += 2; while (li < lines.length && isRow(lines[li])) { body.push(cells(lines[li])); li++; } li--;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if ((m = line.match(/^\u0000B(\d+)\u0000$/))) { flush(); close(); out.push(codeHtml(blocks[m[1]])); continue; }
    if (!line.trim()) { flush(); close(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flush(); close(); const lv = m[1].length + 2; out.push(`<h${lv}>${inline(m[2])}</h${lv}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flush(); close(); out.push("<hr>"); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flush(); close(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flush(); if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flush(); if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    close(); para.push(line);
  }
  flush(); close();
  return out.join("").replace(/\u0000B(\d+)\u0000/g, (m, i) => codeHtml(blocks[i]));
}

/* ---------------------------------------------------------------- auth */
const FORMS = ["login", "register", "otp", "forgot", "reset"];
function showForm(name, note = "", kind = "") {
  FORMS.forEach((f) => $(f + "-form").classList.toggle("hidden", f !== name));
  $("auth-tabs").classList.toggle("hidden", !(name === "login" || name === "register"));
  $("login-tab").classList.toggle("active", name === "login");
  $("register-tab").classList.toggle("active", name === "register");
  setNote(note, kind);
}
function setNote(text, kind = "") { const n = $("auth-message"); n.textContent = text || ""; n.className = "notice " + kind; }
$("login-tab").onclick = () => showForm("login");
$("register-tab").onclick = () => showForm("register");
$("to-register").onclick = () => showForm("register");
$("to-forgot").onclick = () => showForm("forgot");
document.querySelectorAll(".back-login").forEach((b) => (b.onclick = () => showForm("login")));
document.querySelectorAll(".toggle-pw").forEach((b) => (b.onclick = () => {
  const input = b.parentElement.querySelector("input"); const show = input.type === "password"; input.type = show ? "text" : "password";
  b.innerHTML = ico(show ? "eye-off" : "eye"); b.setAttribute("aria-label", show ? "Hide password" : "Show password");
}));
function needsEmailField() {
  if ($("otp-email")) return;
  $("otp-code").closest("label").insertAdjacentHTML("beforebegin", `<label class="field">Email you signed up with<input class="input" id="otp-email" type="email" autocomplete="email" required></label>`);
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const btn = e.submitter || e.target.querySelector("button[type=submit]"); setBtn(btn, true); setNote("");
  try { const d = await post("/login", { username: $("login-username").value.trim(), password: $("login-password").value }); if (d.needs2fa) askAdminCode(); else await enterApp(); }
  catch (err) {
    if (err.data && err.data.needsVerification) { needsEmailField(); showForm("otp", "Verify your email to finish setting up.", ""); $("otp-help").textContent = "Enter your email and the 6-digit code we sent you."; }
    else setNote(err.message, "error");
  } finally { setBtn(btn, false); }
});
$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const btn = e.submitter || e.target.querySelector("button[type=submit]"); setBtn(btn, true); setNote("");
  try {
    const email = $("reg-email").value.trim().toLowerCase();
    const d = await post("/register", { username: $("reg-username").value.trim(), email, password: $("reg-password").value, ref: $("reg-ref").value.trim() });
    S.pendingEmail = email; $("otp-email")?.closest("label").remove();
    showForm("otp", "", ""); $("otp-help").textContent = d.message; setNote("");
  } catch (err) { setNote(err.message, "error"); } finally { setBtn(btn, false); }
});
$("otp-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const btn = e.submitter || e.target.querySelector("button[type=submit]"); setBtn(btn, true);
  try {
    const email = $("otp-email") ? $("otp-email").value.trim().toLowerCase() : S.pendingEmail;
    const d = await post("/api/auth/verify-otp", { email, code: $("otp-code").value.trim() });
    showForm("login", d.message, "success");
  } catch (err) { setNote(err.message, "error"); } finally { setBtn(btn, false); }
});
$("resend-otp").onclick = async () => {
  try { const email = $("otp-email") ? $("otp-email").value.trim().toLowerCase() : S.pendingEmail; if (!email) return setNote("Enter your email first.", "error");
    const d = await post("/api/auth/resend-otp", { email }); setNote(d.message, "success"); } catch (err) { setNote(err.message, "error"); }
};
$("forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const btn = e.submitter || e.target.querySelector("button[type=submit]"); setBtn(btn, true);
  try { S.pendingEmail = $("forgot-email").value.trim().toLowerCase(); const d = await post("/api/auth/forgot", { email: S.pendingEmail }); showForm("reset", d.message, "success"); }
  catch (err) { setNote(err.message, "error"); } finally { setBtn(btn, false); }
});
$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const btn = e.submitter || e.target.querySelector("button[type=submit]"); setBtn(btn, true);
  try { const d = await post("/api/auth/reset", { email: S.pendingEmail, code: $("reset-code").value.trim(), password: $("reset-password").value }); showForm("login", d.message, "success"); }
  catch (err) { setNote(err.message, "error"); } finally { setBtn(btn, false); }
});

/* ---------------------------------------------------------------- app boot */
async function enterApp() {
  $("auth-view").classList.add("hidden"); $("app-view").classList.remove("hidden");
  await refreshMe(); paintHistoryEarly();
  const tasks = [loadPersonas(), loadHistory(), loadNotifs(), loadDailyPrompt(), loadStyles()];
  await Promise.all(tasks.map((t) => t.catch(() => {})));
  offerPendingGift(); setGreeting(); const rememberedPage = store.get("vyra-page"); newChat(); maybeTour(); if (["chat","toolbox","images","plans","workspace"].includes(rememberedPage)) showPage(rememberedPage);
  const paid = new URLSearchParams(location.search).get("paid");
  if (paid) {
    history.replaceState(null, "", "/?login=1"); showPage("plans");
    try { const d = await api("/api/paystack/verify?reference=" + encodeURIComponent(paid));
      if (d.status === "approved") { toast("Payment received. Your plan is active!"); await refreshMe(); renderPlans(); } else toast("We're still confirming your payment. Check back in a minute.");
    } catch (e) { toast(e.message, "error"); }
  }
}
function setGreeting() {
  const h = new Date().getHours(); const g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  $("greeting").textContent = `${g}, ${S.user.username}`;
  $("welcome").querySelector(".sub").textContent = "What are we creating today?";
}
const TOP = ["business", "enterprise", "infinity"];
function planLabel() { const u = S.user; if (u.isAdmin) return "Infinity"; return u.trial ? "Free trial" : (S.plans[u.plan]?.name || "Free"); }
async function refreshMe() {
  const d = await api("/api/me"); S.user = d.user; S.usage = d.usage; S.images = d.images; S.plans = d.plans; S.paystack = d.paystack; S.badges = d.badges;
  if (d.billing && d.billing.multipliers) Object.assign(BILLING_FACTORS, d.billing.multipliers); // one source of truth: the server
  const u = S.user, us = S.usage;
  $("news-dot").classList.toggle("hidden", !u.hasNewsUpdate);
  $("side-username").textContent = u.username; $("avatar").textContent = u.username[0].toUpperCase();
  $("side-plan").textContent = planLabel() + (u.trial ? " · full access" : " plan");
  const crown = TOP.includes(u.plan) && !u.trial ? ico("crown", "sm") : "";
  $("top-plan").innerHTML = crown + esc(planLabel()); $("top-plan").className = "pill " + (crown || u.trial ? "gold" : "brand");
  $("admin-nav").classList.toggle("hidden", !u.isAdmin);
  const frac = us.trial ? 1 : Math.max(0, Math.min(1, us.remaining / Math.max(1, us.limit)));
  const low = !us.trial && us.remaining <= Math.max(3, Math.round(us.limit * 0.2));
  $("side-meter").classList.toggle("warn", low); $("side-meter").firstElementChild.style.width = (us.trial ? 100 : Math.min(100, (us.used / us.limit) * 100)) + "%";
  $("side-usage").textContent = us.trial ? "Unlimited in your trial" : `${us.remaining.toLocaleString()} messages left`;
  $("side-plan-note").textContent = u.trial && us.trialEndsAt ? "ends " + new Date(us.trialEndsAt).toLocaleDateString("en-NG", { day: "numeric", month: "short" }) : "";
  $("usage-label").textContent = us.trial ? "Unlimited messages during your trial" : `${us.remaining.toLocaleString()} of ${us.limit.toLocaleString()} messages left this month`;
  const ring = $("usage-ring"); ring.classList.toggle("warn", low); ring.querySelector(".fg").style.strokeDashoffset = String(150.8 * (1 - frac));
  $("streak-label").textContent = u.streak; const ci = $("checkin-btn"); ci.classList.toggle("done", u.checkedInToday);
  $("checkin-text").textContent = u.checkedInToday ? "Checked in today" : "Daily check-in";
  const n = $("nudge");
  if (low && !us.trial) { $("nudge-text").textContent = us.remaining <= 0 ? "You've used all your messages this month." : `Only ${us.remaining} messages left this month.`; n.classList.remove("hidden"); $("nudge-checkin").classList.toggle("hidden", u.checkedInToday); } else n.classList.add("hidden");
  $("image-limit-label").textContent = `${S.images.used} of ${S.images.limit} images used today. Resets at midnight.`;
  $("usage-number").textContent = us.trial ? "Unlimited (trial)" : `${us.used.toLocaleString()} / ${us.limit.toLocaleString()}`;
  $("usage-meter").classList.toggle("warn", low); $("usage-meter").firstElementChild.style.width = (us.trial ? 100 : Math.min(100, (us.used / us.limit) * 100)) + "%";
  $("usage-sub").textContent = u.planExpiresAt ? `Your ${S.plans[u.paidPlan]?.name || ""} plan runs until ${fmtDate(u.planExpiresAt)}.` : (u.trial ? "Your trial gives you full access. After it ends you move to the Free plan." : "Check in every day for bonus messages.");
  updateBillingBits(d); updateRelaunch(d);
}
async function loadPersonas() {
  const d = await api("/api/personas"); S.personas = d.personas;
  const sel = $("persona-select"); sel.innerHTML = d.personas.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join("");
  sel.value = store.get("vyra-persona") || "assistant"; if (!sel.value) sel.value = "assistant";
  $("suggest").innerHTML = d.suggestions.map((s) => `<button type="button" data-prompt="${esc(s.prompt)}">${ico(s.icon)}<span><strong>${esc(s.title)}</strong></span></button>`).join("");
}
$("persona-select").onchange = (e) => store.set("vyra-persona", e.target.value);
$("lang-select").value = store.get("vyra-lang") || "English"; if (!$("lang-select").value) $("lang-select").value = "English";
$("lang-select").onchange = (e) => store.set("vyra-lang", e.target.value);
async function loadDailyPrompt() {
  const d = await api("/api/daily-prompt"); const b = $("daily-prompt"); b.classList.remove("hidden"); $("daily-prompt-text").textContent = "Today's idea: " + d.prompt; b.dataset.prompt = d.prompt;
}

/* ---------------------------------------------------------------- navigation */
const TITLES = { chat: "", toolbox: "AI Toolbox", workspace: "Projects & Memory", images: "Image Studio", plans: "Plans", admin: "Admin" };
function updateHeading(name) {
  const proj = name === "chat" && S.projectId ? (S.projectCache || []).find((x) => x.id === S.projectId) : null;
  $("page-heading").textContent = proj ? "Project: " + proj.name : (TITLES[name] || document.querySelector(".brand").textContent.trim());
}
function showPage(name) {
  S.page = name; store.set("vyra-page", name);
  ["chat", "toolbox", "workspace", "images", "plans", "admin"].forEach((p) => $(p + "-page").classList.toggle("hidden", p !== name));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  updateHeading(name);
  closeSidebar(); $("notif-panel").classList.add("hidden");
  if (name === "plans") { renderPlans(); loadLeaderboard(); renderReferral(); loadBillingExtras(); }
  if (name === "images") loadGallery();
  if (name === "workspace") loadWorkspace();
  if (name === "admin") renderAdmin(S.adminTab);
}
document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
const TOOL_PROMPTS = {
  study: "Act as my patient study tutor. Ask what subject and topic I am learning, then teach step by step with a short practice question.",
  research: "Help me create a research brief. Clarify the topic if needed, organize key questions, distinguish facts from assumptions, and suggest reliable source types to verify.",
  writing: "Open Writing Studio. Ask what I need to write and help me draft, revise, or polish it with the requested tone.",
  coding: "Act as my coding assistant. Ask for my code or error if needed, explain the issue clearly, and propose a careful fix with reasoning.",
  planner: "Help me plan my tasks and goals. Ask for the goal and timeframe, then create a realistic checklist and schedule.",
  data: "Act as a data analyst. Ask me to paste or attach data, then help summarize it, identify patterns, and explain limitations.",
  creative: "Start Creative Lab. Help me brainstorm original ideas, concepts, characters, story outlines, or creative projects.",
  decision: "Help me compare choices fairly. Ask for the options and priorities, then create a clear pros/cons comparison and explain trade-offs without choosing for me."
};
document.querySelectorAll("[data-tool]").forEach((card) => card.addEventListener("click", () => {
  const prompt = TOOL_PROMPTS[card.dataset.tool]; if (!prompt) return;
  showPage("chat"); newChat(); $("message-input").value = prompt; autosize(); $("message-input").focus();
}));

function closeSidebar() { $("sidebar").classList.remove("open"); $("scrim").classList.add("hidden"); }
$("mobile-menu").onclick = () => { $("sidebar").classList.add("open"); $("scrim").classList.remove("hidden"); };
$("scrim").onclick = closeSidebar;
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]"); if (go) { showPage(go.dataset.go); return; }
  const cc = e.target.closest("[data-copy-code]");
  if (cc) { const code = cc.closest(".code-block").querySelector("code").textContent; copyText(code).then((ok) => { cc.innerHTML = ico("check", "sm") + (ok ? "Copied" : "Press Ctrl+C"); setTimeout(() => (cc.innerHTML = ico("copy", "sm") + "Copy"), 1600); }); return; }
  if (!e.target.closest(".menu") && !e.target.closest(".h-more")) closeMenus();
  if (!e.target.closest("#notif-panel") && !e.target.closest("#notif-btn")) $("notif-panel").classList.add("hidden");
  if (e.target.classList.contains("modal")) closeModals();
  if (e.target.closest("[data-close]")) closeModals();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModals(); closeMenus(); } });

/* theme */
function applyThemeIcon() { const t = document.documentElement.dataset.theme; $("theme-btn").innerHTML = ico(t === "light" ? "moon" : "sun"); }
$("theme-btn").onclick = () => { const order = ["auto", "light", "dark"], cur = (window.vyraTheme && window.vyraTheme.mode()) || "auto", next = order[(order.indexOf(cur) + 1) % 3]; window.vyraTheme.set(next); applyThemeIcon(); toast(next === "auto" ? "Theme: follows your phone" : "Theme: " + next); };
document.addEventListener("vyra-theme", () => applyThemeIcon());
applyThemeIcon();

/* ---------------------------------------------------------------- notifications */
async function loadNotifs() {
  const d = await api("/api/notifications"); const list = $("notif-list");
  const dm = await api("/api/user/direct-messages").catch(()=>({messages:[]}));
  const direct = (dm.messages||[]).map(m=>`<div class="notif-item"><b>Private message from VYRA Admin</b><p>${esc(m.message)}</p><small>${fmtDate(m.created_at)}</small></div>`).join("");
  const claimCard = S.relaunchOffer ? `<div class="notif-item claim-card"><b>Free ${S.trialDays || 7}-day trial</b><p>Welcome back! Claim a fresh trial with full access.</p><button type="button" class="btn sm primary" data-claim-trial>Claim</button></div>` : "";
  list.innerHTML = claimCard + (d.notifications.length ? d.notifications.map((n) => `<div class="notif-item ${n.is_read ? "read" : ""}">${esc(n.message)}</div>`).join("") : `<div class="empty">Nothing new yet.</div>`) + (direct ? `<h4 style="margin-top:14px">Private messages</h4>${direct}` : "");
  $("notif-dot").classList.toggle("hidden", !d.notifications.some((n) => !n.is_read));
}
$("notif-btn").onclick = () => { $("notif-panel").classList.toggle("hidden"); loadNotifs().catch(() => {}); };
$("notif-read").onclick = async () => { await post("/api/notifications/read"); loadNotifs(); };
$("top-plan").onclick = () => showPage("plans");

/* ---------------------------------------------------------------- check-in */
async function doCheckin() {
  try { const d = await post("/api/checkin"); toast(d.milestone ? `Day ${d.streak} streak! +${d.bonus} bonus messages` : `Checked in. +${d.bonus} bonus messages. Streak: ${d.streak}`); await refreshMe(); if (S.page === "plans") loadLeaderboard(); }
  catch (e) { toast(e.message); }
}
$("checkin-btn").onclick = doCheckin; $("nudge-checkin").onclick = doCheckin;
$("changelog-link").addEventListener("click", () => { $("news-dot").classList.add("hidden"); post("/api/user/seen-changelog").catch(() => {}); });

/* ---------------------------------------------------------------- chat */
const scroller = () => $("chat-scroll");
const nearBottom = () => { const s = scroller(); return s.scrollHeight - s.scrollTop - s.clientHeight < 140; };
const toBottom = () => { const s = scroller(); s.scrollTop = s.scrollHeight; };
scroller().addEventListener("scroll", () => $("jump-latest").classList.toggle("hidden", nearBottom() || !S.msgs.length));
$("jump-latest").onclick = () => { toBottom(); $("jump-latest").classList.add("hidden"); };
$("copy-chat-btn").onclick = async () => {
  if (!S.msgs.length) return;
  const txt = S.msgs.map((m) => (m.role === "user" ? "You" : document.title) + ":\n" + m.content).join("\n\n---\n\n");
  toast((await copyText(txt)) ? "Whole chat copied" : "Couldn't copy");
};
$("shortcuts-btn").onclick = () => {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Keyboard shortcuts</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <div class="kv"><div><span>Search chats</span><b>Ctrl/Cmd + K</b></div><div><span>Send message</span><b>Enter</b></div><div><span>New line</span><b>Shift + Enter</b></div><div><span>Close a dialog</span><b>Esc</b></div><div><span>Shortcuts</span><b>?</b></div></div>`;
  openModal("generic-modal");
};
document.addEventListener("keydown", (e) => {
  const typing = /input|textarea/i.test(document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); showPage("chat"); $("search-chats").focus(); }
  else if (e.key === "?" && !typing) $("shortcuts-btn").click();
});
const MODES = ["fast", "balanced", "deep"];
function setMode(m) {
  S.mode = m; store.set("vyra-mode", m);
  MODES.forEach((k) => { const b = $("mode-" + k); b.classList.toggle("on", m === k); b.setAttribute("aria-pressed", m === k); });
}
MODES.forEach((k) => ($("mode-" + k).onclick = () => setMode(k))); setMode(MODES.includes(S.mode) ? S.mode : "deep");

/* tune reply: length / tone / ELI5, persisted locally */
$("tune-btn").onclick = () => {
  const LEN = [["concise", "Concise"], ["normal", "Normal"], ["detailed", "Detailed"]];
  const TONE = [["friendly", "Friendly"], ["formal", "Formal"], ["casual", "Casual"]];
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Tune this reply</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <p class="muted tiny" style="margin:0 0 6px">Answer length</p><div class="chips" id="tune-len">${LEN.map(([k, l]) => `<button type="button" class="chip ${S.length === k ? "on" : ""}" data-len="${k}">${l}</button>`).join("")}</div>
    <p class="muted tiny" style="margin:14px 0 6px">Tone</p><div class="chips" id="tune-tone">${TONE.map(([k, l]) => `<button type="button" class="chip ${S.tone === k ? "on" : ""}" data-tone="${k}">${l}</button>`).join("")}</div>
    <label class="field-row" style="margin-top:14px"><input type="checkbox" id="tune-eli5" ${S.eli5 ? "checked" : ""}><span>Explain like I'm 5 (simplest words)</span></label>
    <button class="btn primary block" data-close style="margin-top:16px">Done</button>`;
  openModal("generic-modal");
  $("tune-len").onclick = (e) => { const b = e.target.closest("[data-len]"); if (!b) return; S.length = b.dataset.len; store.set("vyra-length", S.length); $("tune-len").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b)); };
  $("tune-tone").onclick = (e) => { const b = e.target.closest("[data-tone]"); if (!b) return; S.tone = b.dataset.tone; store.set("vyra-tone", S.tone); $("tune-tone").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b)); };
  $("tune-eli5").onchange = (e) => { S.eli5 = e.target.checked; store.set("vyra-eli5", S.eli5 ? "1" : "0"); };
};

function msgActions(m) {
  if (m.role === "user") return `<div class="msg-actions"><button type="button" data-act="edit" aria-label="Edit and resend" title="Edit and resend">${ico("edit", "sm")}</button><button type="button" data-act="copy" aria-label="Copy" title="Copy">${ico("copy", "sm")}</button></div>`;
  const last = S.msgs.filter((x) => x.role === "assistant").slice(-1)[0] === m;
  return `<div class="msg-actions">${last && m.truncated ? `<button type="button" data-act="continue" class="chip" aria-label="Continue" title="The reply got cut off">${ico("arrow-up", "sm")}Continue</button>` : ""}<button type="button" data-act="copy" aria-label="Copy" title="Copy">${ico("copy", "sm")}</button><button type="button" data-act="download" aria-label="Download answer as text" title="Download answer">${ico("download", "sm")}</button><button type="button" data-act="zip" aria-label="Download answer as ZIP" title="Download answer as ZIP">${ico("archive", "sm")}</button><button type="button" data-act="speak" aria-label="Read aloud" title="Read aloud">${ico("volume", "sm")}</button><button type="button" data-act="branch" aria-label="Branch chat from here" title="Branch chat from here">${ico("plus", "sm")}</button><button type="button" data-act="pin" class="${m.pinned ? "on" : ""}" aria-label="${m.pinned ? "Unpin message" : "Pin message"}" title="${m.pinned ? "Unpin" : "Pin"}">${ico("pin", "sm")}</button><button type="button" data-act="note" aria-label="Save as note" title="Save as note">${ico("book", "sm")}</button><button type="button" data-act="report" aria-label="Report this answer" title="Report this answer">${ico("shield", "sm")}</button>${last ? `<button type="button" data-act="shorter" class="chip">Shorter</button><button type="button" data-act="longer" class="chip">Longer</button>` : ""}${last ? `<button type="button" data-act="regen" aria-label="Regenerate" title="Regenerate">${ico("refresh", "sm")}</button>` : ""}<button type="button" data-act="up" class="${m.feedback === 1 ? "on" : ""}" aria-label="Good answer" title="Good answer">${ico("thumb-up", "sm")}</button><button type="button" data-act="down" class="${m.feedback === -1 ? "on" : ""}" aria-label="Bad answer" title="Bad answer">${ico("thumb-down", "sm")}</button></div>`;
}
const MODE_LABEL = { fast: "Fast", balanced: "Balanced", deep: "Deep" };
function msgEl(m) {
  const el = document.createElement("article"); el.className = "msg " + m.role; m.el = el;
  const nickname = S.user && S.user.aiNickname;
  const who = m.role === "user" ? "You" : `<span class="mark"><svg class="ico"><use href="#i-v"/></svg></span>${esc(nickname || document.title)}${MODE_LABEL[m.mode] ? `<span class="mode-badge" title="Reply mode">${MODE_LABEL[m.mode]}</span>` : ""}`;
  if (m.pinned) el.classList.add("pinned");
  if (m.createdAt) el.title = fmtTime(m.createdAt);
  el.innerHTML = `<div class="msg-who">${who}</div><div class="msg-body"></div>${m.pending ? "" : msgActions(m)}`;
  fillBody(m); return el;
}
function fmtTime(iso) { try { return new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
function fillBody(m) {
  const body = m.el.querySelector(".msg-body");
  if (m.role === "user") body.textContent = m.content; else body.innerHTML = m.content ? md(m.content) : `<span class="typing"><i></i><i></i><i></i></span>`;
}
function renderMessages() {
  const box = $("chat-messages"); box.replaceChildren(); S.msgs.forEach((m) => box.appendChild(msgEl(m)));
  $("welcome").classList.toggle("hidden", S.msgs.length > 0);
  $("copy-chat-btn").classList.toggle("hidden", S.msgs.length === 0); updatePinsBtn();
}
function refreshActions() { S.msgs.forEach((m) => { if (m.pending || !m.el) return; const old = m.el.querySelector(".msg-actions"); if (old) old.remove(); m.el.insertAdjacentHTML("beforeend", msgActions(m)); }); }
function newChat(keepProject) {
  if (S.busy && S.abort) S.abort.abort();
  if (!keepProject) S.projectId = null; // a normal new chat never inherits a project
  S.conv = null; S.msgs = []; S.editFromId = null; S.memoryOn = true; $("mem-switch").checked = true; clearFile(); renderMessages(); $("message-input").value = store.get(draftKey()) || ""; autosize(); markActive(); showPage("chat"); $("message-input").focus();
}
$("new-chat").onclick = newChat;
async function openConversation(id) {
  showChatSkeleton();
  try {
    const d = await api("/api/conversations/" + id); S.conv = id; S.editFromId = null; S.projectId = d.projectId || null; S.memoryOn = d.useMemory !== false; $("mem-switch").checked = S.memoryOn; updateOptsDot(); // each chat keeps its own project and memory switch
    S.msgs = d.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback, pinned: m.pinned, mode: m.mode, createdAt: m.created_at })); renderMessages(); $("message-input").value = store.get(draftKey()) || ""; autosize(); markActive(); showPage("chat"); toBottom();
  } catch (e) { toast(e.message, "error"); renderMessages(); }
}
function autosize() { const t = $("message-input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; updateChips(); }
$("message-input").addEventListener("input", autosize);
$("message-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("chat-form").requestSubmit(); } });
$("chat-form").addEventListener("submit", (e) => { e.preventDefault(); if (S.busy) { S.abort && S.abort.abort("stop"); return; } const t = $("message-input").value.trim(); if (t) send(t); });
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-prompt]"); if (b && !b.closest(".modal")) { $("message-input").value = b.dataset.prompt; autosize(); $("message-input").focus(); }
});

$("chat-messages").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const idx = S.msgs.findIndex((m) => m.el === btn.closest(".msg")); const m = S.msgs[idx]; if (!m) return; const act = btn.dataset.act;
  if (act === "copy") { toast((await copyText(m.content)) ? "Copied" : "Couldn't copy"); }
  if (act === "download") { const blob=new Blob([m.content||""],{type:"text/markdown;charset=utf-8"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="vyra-answer.md"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
  if (act === "zip") { try { const r=await fetch("/api/export-answer-zip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:m.content||"",filename:"vyra-answer.md"})}); if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||"ZIP export failed");} const blob=await r.blob(); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="vyra-answer.zip"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); } catch(err){toast(err.message,"error");} }
  if (act === "speak") speak(m.content);
  if (act === "edit") { if (!m.id) return toast("Give it a second, this message is still saving."); S.editFromId = m.id; $("message-input").value = m.content; autosize(); $("message-input").focus(); toast("Editing. Send to replace this message and everything after it."); }
  if (act === "regen") { const u = S.msgs[idx - 1]; if (!u || !u.id) return toast("Give it a second, then try again."); send(u.content, { truncateFromId: u.id }); }
  if (act === "continue") send("Continue exactly where you left off. Don't repeat what you already said.");
  if (act === "shorter" || act === "longer") { const u = S.msgs[idx - 1]; if (!u || !u.id) return toast("Give it a second, then try again."); send(u.content, { truncateFromId: u.id, length: act === "shorter" ? "concise" : "detailed" }); }
  if (act === "pin") {
    if (!m.id) return toast("Give it a second, this message is still saving.");
    try { const d = await post(`/api/messages/${m.id}/pin`); m.pinned = d.pinned; m.el.classList.toggle("pinned", !!d.pinned); refreshActions(); updatePinsBtn(); toast(d.pinned ? "Pinned" : "Unpinned"); } catch (err) { toast(err.message, "error"); }
  }
  if (act === "branch") {
    if (!m.id || !S.conv) return toast("Give it a second, this message is still saving.");
    try { const d = await post(`/api/conversations/${S.conv}/branch`, { messageId: m.id }); await loadHistory(); await openConversation(d.id); toast("New branch created. Your original chat is unchanged."); } catch (err) { toast(err.message, "error"); }
  }
  if (act === "report") {
    if (!m.id) return toast("Give it a second, this message is still saving.");
    $("generic-card").innerHTML = `<div class="modal-head"><h2>Report this answer</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
      <select class="select" id="rep-reason" style="max-width:none;width:100%"><option value="harmful">Harmful or unsafe</option><option value="wrong">Wrong or misleading</option><option value="offensive">Offensive</option><option value="other">Something else</option></select>
      <textarea class="input" id="rep-details" rows="3" maxlength="500" placeholder="What was wrong? (optional)" style="margin-top:8px"></textarea><button class="btn primary block" id="rep-send" style="margin-top:10px">Send report</button>`;
    openModal("generic-modal");
    $("rep-send").onclick = async () => { try { await post(`/api/messages/${m.id}/report`, { reason: $("rep-reason").value, details: $("rep-details").value }); closeModals(); toast("Thanks. We'll review it."); } catch (err) { toast(err.message, "error"); } };
  }
  if (act === "note") { try { await post("/api/notes", { content: m.content, conversationId: S.conv }); toast("Saved to Notes"); } catch (err) { toast(err.message, "error"); } }
  if (act === "up" || act === "down") {
    if (!m.id) return; const v = act === "up" ? 1 : -1; const next = m.feedback === v ? 0 : v;
    try { await post(`/api/messages/${m.id}/feedback`, { value: next }); m.feedback = next || null; refreshActions(); if (next) toast("Thanks for the feedback"); } catch (err) { toast(err.message, "error"); }
  }
});

function setBusy(b) {
  S.busy = b; const sb = $("send-btn"); sb.classList.toggle("stop", b);
  $("send-icon").innerHTML = `<use href="#i-${b ? "stop" : "arrow-up"}"/>`; sb.setAttribute("aria-label", b ? "Stop generating" : "Send");
  $("usage-ring").classList.toggle("hidden", b); updateChips();
}
async function send(text, opts = {}) {
  if (S.busy) return;
  const wasNew = !S.conv;
  const truncateFromId = opts.truncateFromId || S.editFromId || null; S.editFromId = null;
  if (truncateFromId) { const i = S.msgs.findIndex((m) => m.id === truncateFromId); if (i >= 0) S.msgs = S.msgs.slice(0, i); }
  try { localStorage.removeItem(draftKey()); } catch (e) {}
  const userMsg = { role: "user", content: text }; const ai = { role: "assistant", content: "", pending: true, mode: S.mode }; let stopped = false;
  S.msgs.push(userMsg, ai); renderMessages(); toBottom();
  $("message-input").value = ""; autosize(); setBusy(true);
  const ctrl = new AbortController(); S.abort = ctrl; let idle = setTimeout(() => ctrl.abort("timeout"), 60000);
  const fileText = S.fileText; clearFile();
  let started = false, failed = null, raf = 0; const body = ai.el.querySelector(".msg-body");
  const paint = () => { raf = 0; const stick = nearBottom(); body.innerHTML = md(ai.content); if (stick) toBottom(); };
  try {
    const res = await fetch("/ask/stream", { method: "POST", credentials: "same-origin", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Requested-With": "vyra" },
      body: JSON.stringify({ question: text, conversationId: S.conv, persona: $("persona-select").value, language: $("lang-select").value, modelType: S.mode, temperature: $("temp-slider").value, truncateFromId, fileText, length: opts.length || S.length, tone: S.tone, eli5: S.eli5, projectId: S.projectId, useMemory: S.memoryOn, styleId: S.styleId || null }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); const err = new Error(d.error || "Something went wrong. Please try again."); err.data = d; throw err; }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      clearTimeout(idle); idle = setTimeout(() => ctrl.abort("timeout"), 60000);
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2); if (!raw.startsWith("data: ")) continue;
        const ev = JSON.parse(raw.slice(6));
        if (ev.start) S.conv = ev.start;
        if (ev.t) { started = true; ai.content += ev.t; if (!raf) raf = requestAnimationFrame(paint); }
        if (ev.notice) { body.insertAdjacentHTML("beforebegin", `<div class="notice-line">${esc(ev.notice)}</div>`); }
        if (ev.error) failed = ev.error;
        if (ev.done) { ai.id = ev.messageId; userMsg.id = ev.userMessageId; ai.truncated = !!ev.truncated; }
      }
    }
  } catch (e) {
    if (ctrl.signal.aborted) { if (ctrl.signal.reason === "timeout") failed = "The AI took too long to answer."; else if (!started) { S.msgs = S.msgs.slice(0, -2); if (wasNew) S.conv = null; } else stopped = true; }
    else { failed = e.message; if (e.data && e.data.limitReached) { toast(e.message); refreshMe(); } }
  }
  clearTimeout(idle); cancelAnimationFrame(raf); delete ai.pending; setBusy(false); S.abort = null;
  if (failed && !started) {
    if (wasNew) S.conv = null; // the server removes an empty chat whose first answer failed
    S.msgs = S.msgs.slice(0, -1); renderMessages();
    const last = S.msgs[S.msgs.length - 1]; if (last) last.el.insertAdjacentHTML("beforeend", `<div class="msg-error">${ico("x", "sm")}<span>${esc(failed)}</span><button type="button" class="btn sm" data-retry>Try again</button></div>`);
    S.lastFailed = text; S.msgs = S.msgs.slice(0, -1); // the failed question isn't saved on the server, so retry re-sends it
    if (last) last.el.dataset.failed = "1";
  } else { if (failed) toast(failed, "error"); if (stopped) ai.truncated = true; renderMessages(); if (!ai.id && S.conv) await syncIds(stopped); }
  await Promise.all([refreshMe().catch(() => {}), loadHistory().catch(() => {})]); showFollowups(); toBottom();
}
$("chat-messages").addEventListener("click", (e) => { if (e.target.closest("[data-retry]")) { const t = S.lastFailed; S.msgs = S.msgs.filter((m) => !(m.el && m.el.dataset.failed)); renderMessages(); if (t) send(t); } });
async function syncIds(stopped) { // after Stop: learn the saved ids so edit/regenerate/feedback/pin work
  for (let i = 0; i < 3; i++) {
    try {
      const d = await api("/api/conversations/" + S.conv);
      if (stopped && i < 2 && !(d.messages.length && d.messages[d.messages.length - 1].role === "assistant")) { await new Promise((r) => setTimeout(r, 700)); continue; } // server is still saving the partial answer
      S.msgs = d.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback, pinned: m.pinned, mode: m.mode, createdAt: m.created_at }));
      const last = S.msgs[S.msgs.length - 1]; if (stopped && last && last.role === "assistant") last.truncated = true;
      renderMessages(); return;
    } catch (e) { return; }
  }
}

/* PDF attach */
$("attach-btn").onclick = () => $("file-input").click();
async function processPDFFile(f){
  if(!f)return;
  if(!/\.(pdf|docx|xlsx)$/i.test(f.name)) return toast("Please choose a PDF, Word (.docx) or Excel (.xlsx) file.","error");
  if(f.size>8*1024*1024) return toast("That file is over 8 MB.","error");
  const fd=new FormData();fd.append("file",f);toast("Reading your file...");
  try{const d=await api("/api/extract-text",{method:"POST",body:fd});S.fileText=d.text;S.fileName=d.filename;
    $("file-chip").innerHTML=`${ico("paperclip","sm")}<span>${esc(d.filename)}${d.truncated?" (first part)":""}</span><button type="button" aria-label="Remove file" id="file-x">${ico("x","sm")}</button>`;
    $("file-chip").classList.remove("hidden");$("file-x").onclick=clearFile;if(!$ ("message-input").value)$ ("message-input").value="Summarise this document for me.";autosize();
  }catch(err){toast(err.message,"error");}
}
$("file-input").onchange=(e)=>{const f=e.target.files[0];e.target.value="";processPDFFile(f);};
// Desktop drag-and-drop PDF support. Mobile users retain the native file picker.
const dropTarget=$("chat-page");let dragDepth=0;
if(dropTarget){dropTarget.addEventListener("dragenter",e=>{if(!Array.from(e.dataTransfer?.types||[]).includes("Files"))return;e.preventDefault();dragDepth++;dropTarget.classList.add("pdf-drop-active");});
dropTarget.addEventListener("dragover",e=>{if(Array.from(e.dataTransfer?.types||[]).includes("Files"))e.preventDefault();});
dropTarget.addEventListener("dragleave",e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;dropTarget.classList.remove("pdf-drop-active");}});
dropTarget.addEventListener("drop",e=>{e.preventDefault();dragDepth=0;dropTarget.classList.remove("pdf-drop-active");const f=e.dataTransfer?.files?.[0];if(f)processPDFFile(f);});}
function clearFile() { S.fileText = ""; S.fileName = ""; $("file-chip").classList.add("hidden"); $("file-chip").innerHTML = ""; }

/* ---------------------------------------------------------------- history sidebar */
let searchTimer = 0;
const CHAT_CACHE_KEY = "vyra-chat-cache";
function userKey() { const u = S.user || {}; return String(u.id || u.email || u.username || ""); }
function cacheChats() {
  if (S.historyView !== "active" || !userKey()) return;
  try { store.set(CHAT_CACHE_KEY, JSON.stringify({ u: userKey(), chats: (S.chats || []).slice(0, 40), folders: S.folders || [] })); } catch (e) {}
}
function readChatCache() {
  try { const c = JSON.parse(store.get(CHAT_CACHE_KEY) || "null"); return c && c.u === userKey() && Array.isArray(c.chats) ? c : null; } catch (e) { return null; }
}
function skeletonRows(n) { let h = ""; for (let i = 0; i < n; i++) h += `<div class="h-row sk-row"><span class="skeleton ${i % 2 ? "w60" : "w40"}"></span></div>`; return h; }
function paintHistoryEarly() {
  const c = readChatCache();
  if (c) { S.chats = c.chats; S.folders = c.folders || []; try { renderHistory(); } catch (e) {} return; }
  if (!$("history-list").children.length) $("history-list").innerHTML = skeletonRows(6);
}
function showChatSkeleton() {
  const box = $("chat-messages"); $("welcome").classList.add("hidden");
  box.innerHTML = `<div class="sk-chat"><span class="skeleton w60"></span><span class="skeleton"></span><span class="skeleton w40"></span><span class="skeleton"></span></div>`;
}
async function loadHistory() {
  const [d, f] = await Promise.all([api("/api/conversations" + (S.historyView === "archived" ? "?archived=1" : "")), S.historyView === "archived" ? Promise.resolve(null) : api("/api/folders").catch(() => null)]);
  S.chats = d.conversations; if (f) S.folders = f.folders; renderHistory(); cacheChats();
}
function markActive() { document.querySelectorAll(".h-row").forEach((r) => r.classList.toggle("active", r.dataset.id === S.conv)); }
function tagChips(c) { return c.tags ? c.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => `<span class="h-tag">${esc(t)}</span>`).join("") : ""; }
function renderHistory(results = null) {
  const box = $("history-list");
  if (results) { box.innerHTML = results.length ? results.map((r) => `<div class="h-row" data-id="${esc(r.id)}"><button class="h-title" data-open="${esc(r.id)}" title="${esc(r.snippet || r.title)}">${esc(r.title)}</button></div>`).join("") : `<div class="empty">No chats match that.</div>`; markActive(); return; }
  const folders = S.historyView === "active" ? (S.folders || []) : [];
  if (!S.chats.length && !folders.length) { box.innerHTML = `<div class="empty tiny">${S.historyView === "archived" ? "No archived chats yet." : "Your chats will show up here."}</div>`; return; }
  const row = (c) => `<div class="h-row" data-id="${esc(c.id)}"><button class="h-title" data-open="${esc(c.id)}">${c.shared ? ico("link", "sm") : ""}${esc(c.title)}${tagChips(c)}</button><button class="h-more" data-more="${esc(c.id)}" aria-label="Chat options">${ico("more", "sm")}</button></div>`;
  const pinned = S.chats.filter((c) => c.pinned), free = S.chats.filter((c) => !c.pinned && !folders.some((f) => f.id === c.folderId));
  const folds = foldedSet();
  let html = pinned.length ? `<div class="history-group">Pinned</div>` + pinned.map(row).join("") : "";
  folders.forEach((f) => {
    const items = S.chats.filter((c) => !c.pinned && c.folderId === f.id), shut = folds.has(f.id);
    html += `<div class="history-group folder-head"><button type="button" class="fold-toggle" data-fold="${f.id}" aria-expanded="${!shut}">${shut ? "&#9656;" : "&#9662;"} ${esc(f.name)} <span>${items.length}</span></button><button type="button" class="h-more" data-fmore="${f.id}" aria-label="Folder options">${ico("more", "sm")}</button></div>` + (shut ? "" : items.map(row).join(""));
  });
  html += free.length ? `<div class="history-group">${pinned.length || folders.length ? "Recent" : "Chats"}</div>` + free.map(row).join("") : "";
  box.innerHTML = html; markActive();
}
function foldedSet() { try { return new Set(JSON.parse(store.get("vyra-folds") || "[]")); } catch (e) { return new Set(); } }
$("hist-active").onclick = () => { S.historyView = "active"; $("hist-active").classList.add("on"); $("hist-archived").classList.remove("on"); loadHistory(); };
$("hist-archived").onclick = () => { S.historyView = "archived"; $("hist-archived").classList.add("on"); $("hist-active").classList.remove("on"); loadHistory(); };
$("search-chats").addEventListener("input", (e) => {
  clearTimeout(searchTimer); const q = e.target.value.trim();
  if (q.length < 2) return renderHistory();
  searchTimer = setTimeout(async () => { try { const d = await api("/api/search?q=" + encodeURIComponent(q)); renderHistory(d.results); } catch (err) {} }, 250);
});
function closeMenus() { document.querySelectorAll(".menu").forEach((m) => m.remove()); document.querySelectorAll(".h-row.open").forEach((r) => r.classList.remove("open")); }
$("history-list").addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]"); if (open) { closeMenus(); openConversation(open.dataset.open); closeSidebar(); return; }
  const more = e.target.closest("[data-more]"); if (!more) return;
  const row = more.closest(".h-row"), had = row.querySelector(".menu"); closeMenus(); if (had) return;
  const c = S.chats.find((x) => x.id === more.dataset.more); row.classList.add("open");
  row.insertAdjacentHTML("beforeend", `<div class="menu" role="menu"><button data-m="rename">${ico("edit", "sm")}Rename</button><button data-m="pin">${ico("pin", "sm")}${c.pinned ? "Unpin" : "Pin"}</button><button data-m="folder">${ico("book", "sm")}Move to folder</button><button data-m="tags">${ico("tag", "sm")}Tags</button><button data-m="archive">${ico("archive", "sm")}${c.archived ? "Unarchive" : "Archive"}</button><button data-m="share">${ico("share", "sm")}${c.shared ? "Stop sharing" : "Share link"}</button><button data-m="export">${ico("download", "sm")}Export</button><button data-m="delete" class="danger">${ico("trash", "sm")}Delete</button></div>`);
  row.querySelector(".menu").onclick = (ev) => { const b = ev.target.closest("[data-m]"); if (b) chatAction(b.dataset.m, c, row); };
});
async function chatAction(act, c, row) {
  closeMenus();
  try {
    if (act === "pin") { await post(`/api/conversations/${c.id}/pin`); await loadHistory(); }
    if (act === "share") {
      if (c.shared) { await post(`/api/conversations/${c.id}/share`, { enabled: false }); toast("Sharing turned off"); }
      else { const d = await post(`/api/conversations/${c.id}/share`); const ok = await copyText(d.url); toast(ok ? "Link copied. Anyone with it can read this chat." : d.url); }
      await loadHistory();
    }
    if (act === "rename") {
      const btn = row.querySelector(".h-title"); const input = document.createElement("input"); input.className = "rename-input"; input.value = c.title; input.maxLength = 120; btn.replaceWith(input); input.focus(); input.select();
      let done = false; const finish = async (save) => { if (done) return; done = true; if (save && input.value.trim() && input.value.trim() !== c.title) { try { await post(`/api/conversations/${c.id}/rename`, { title: input.value }); } catch (e) { toast(e.message, "error"); } } await loadHistory(); };
      input.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); }; input.onblur = () => finish(true);
    }
    if (act === "export") {
      const d = await api("/api/conversations/" + c.id); const txt = c.title + "\n\n" + d.messages.map((m) => (m.role === "user" ? "You" : "Vyra AI") + ":\n" + m.content).join("\n\n---\n\n");
      const url = URL.createObjectURL(new Blob([txt], { type: "text/plain" })); const a = document.createElement("a"); a.href = url; a.download = (c.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 40) || "chat") + ".txt"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    if (act === "delete") confirmBox("Delete this chat?", "This removes the chat and its messages for good.", "Delete", async () => { await post(`/api/conversations/${c.id}/delete`); if (S.conv === c.id) newChat(); await loadHistory(); toast("Chat deleted"); });
    if (act === "archive") { await post(`/api/conversations/${c.id}/archive`); if (S.conv === c.id && S.historyView === "active") newChat(); await loadHistory(); toast(c.archived ? "Chat unarchived" : "Chat archived"); }
    if (act === "folder") openFolderPicker(c);
    if (act === "tags") {
      $("generic-card").innerHTML = `<div class="modal-head"><h2>Tags</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><p class="muted tiny" style="margin:0 0 8px">Comma-separated, e.g. "work, ideas"</p><input class="input" id="tags-input" maxlength="200" value="${esc(c.tags || "")}"><button class="btn primary block" id="tags-save" style="margin-top:12px">Save</button>`;
      openModal("generic-modal");
      $("tags-save").onclick = async () => { try { await post(`/api/conversations/${c.id}/tags`, { tags: $("tags-input").value }); closeModals(); await loadHistory(); } catch (e) { toast(e.message, "error"); } };
    }
  } catch (e) { toast(e.message, "error"); }
}
function confirmBox(title, text, label, fn) {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><p class="muted">${esc(text)}</p><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button class="btn" data-close>Cancel</button><button class="btn danger" id="confirm-go">${esc(label)}</button></div>`;
  openModal("generic-modal"); $("confirm-go").onclick = async () => { closeModals(); try { await fn(); } catch (e) { toast(e.message, "error"); } };
}

/* ---------------------------------------------------------------- Image Studio */
const STYLES = ["Photo", "Anime", "3D render", "Logo", "Watercolor", "Pixel art"];
$("style-chips").innerHTML = STYLES.map((s) => `<button type="button" class="chip" data-style="${esc(s)}">${esc(s)}</button>`).join("");
$("style-chips").onclick = (e) => { const b = e.target.closest("[data-style]"); if (!b) return; const on = b.classList.contains("on"); document.querySelectorAll("#style-chips .chip").forEach((c) => c.classList.remove("on")); S.imgStyle = on ? "" : b.dataset.style; if (!on) b.classList.add("on"); };
$("generate-img-btn").onclick = async () => {
  let prompt = $("image-prompt").value.trim(); if (!prompt) return toast("Describe the image first.");
  if (S.imgStyle) prompt += ", " + S.imgStyle.toLowerCase() + " style";
  const btn = $("generate-img-btn"); setBtn(btn, true, ico("zap") + "Generating...");
  try {
    const d = await post("/api/generate-image", { prompt, size: S.imgSize || "square" }); const box = $("img-result"), img = $("img-result-img");
    box.classList.remove("hidden"); box.querySelector(".skeleton").classList.remove("hidden"); img.style.opacity = "0";
    img.onload = () => { box.querySelector(".skeleton").classList.add("hidden"); img.style.opacity = "1"; box.style.aspectRatio = img.naturalWidth && img.naturalHeight ? img.naturalWidth + " / " + img.naturalHeight : "1"; loadGallery(); };
    img.onerror = () => { box.querySelector(".skeleton").classList.add("hidden"); toast("The image service is busy. Try again in a moment.", "error"); };
    img.src = d.image_url; $("img-download").href = d.image_url; refreshMe();
  } catch (e) { toast(e.message, "error"); } finally { setBtn(btn, false, ico("zap") + "Generate image"); }
};
async function loadGallery() {
  try { const d = await api("/api/images"); $("gallery").innerHTML = d.images.length ? d.images.map((i) => `<div class="g-item"><img loading="lazy" src="${esc(i.display_url)}" alt="${esc(i.prompt)}"><div class="g-actions">${S.images && S.images.edit ? `<button type="button" data-edit-img="${esc(i.display_url)}" aria-label="Edit this picture">${ico("edit", "sm")}</button>` : ""}${String(i.prompt).startsWith("Edit: ") ? "" : `<button type="button" data-var-img="${esc(i.prompt)}" aria-label="Make another version">${ico("refresh", "sm")}</button>`}<a href="${esc(i.display_url)}" download target="_blank" rel="noopener" aria-label="Download">${ico("download", "sm")}</a><button type="button" data-del-img="${i.id}" aria-label="Delete">${ico("trash", "sm")}</button></div></div>`).join("") : `<div class="empty" style="grid-column:1/-1">Images you make will be saved here.</div>`; } catch (e) {}
}
$("gallery").onclick = async (e) => {
  const ed = e.target.closest("[data-edit-img]"), vr = e.target.closest("[data-var-img]");
  if (ed) { try { const r = await fetch(ed.dataset.editImg, { credentials: "same-origin" }); if (!r.ok) throw new Error("Could not open that picture."); setEditFile(new File([await r.blob()], "picture.jpg", { type: "image/jpeg" })); $("edit-card").scrollIntoView({ behavior: "smooth", block: "center" }); } catch (err) { toast(err.message, "error"); } return; }
  if (vr) { S.imgStyle = ""; document.querySelectorAll("#style-chips .chip").forEach((c) => c.classList.remove("on")); $("image-prompt").value = vr.dataset.varImg.replace(/^Edit: /, ""); $("generate-img-btn").click(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  const b = e.target.closest("[data-del-img]"); if (!b) return; try { await post(`/api/images/${b.dataset.delImg}/delete`); loadGallery(); } catch (err) { toast(err.message, "error"); } };

/* ---------------------------------------------------------------- Plans, checkout, referral, leaderboard */
let BILLING_PERIOD = "monthly";
const BILLING_FACTORS = { weekly: 0.35, monthly: 1, annual: 10 };
const BILLING_LABELS = { weekly: "7 days", monthly: "30 days", annual: "365 days" };
function ensureCurrencyPicker() {
  if ($("currency-view")) return; const bp = $("billing-period"); if (!bp) return;
  bp.insertAdjacentHTML("afterend", `<select id="currency-view" class="input" style="max-width:170px" aria-label="Show prices in"><option value="NGN">Prices in ₦ (NGN)</option><option value="USD">Prices in US$ (USD)</option></select>`);
  $("currency-view").onchange = async (e) => { const v = e.target.value; try { await post("/api/preferences", { currency: v }); S.user.currency = v; renderPlans(); } catch (err) { toast(err.message, "error"); } };
}
function renderPlans() {
  const grid=$("plans-grid"), u=S.user||{}, plans=S.plans||{};
  if(u.isAdmin){grid.innerHTML=`<div class="plan current"><h3>${ico("crown","sm")}Infinity (Admin)</h3><p class="muted">The administrator account has its own privileged access: no message or image limits and no plan to buy. Customer plans are managed in Admin > Users.</p></div>`;return;}
  ensureCurrencyPicker(); const usdView=((u.currency||"NGN")!=="NGN"); $("currency-view").value=usdView?"USD":"NGN";
  const entries=Object.entries(plans).filter(([k,p])=>p&&p.name&&["free","starter","plus","pro","business","enterprise"].includes(k));
  const fallback={
    free:{name:"Free",price:0,price_usd:0,monthly_messages:20,daily_images:3},
    starter:{name:"Starter",price:1500,price_usd:5,monthly_messages:120,daily_images:10},
    plus:{name:"Plus",price:5000,price_usd:12.99,monthly_messages:400,daily_images:30},
    pro:{name:"Pro",price:15000,price_usd:29.99,monthly_messages:1200,daily_images:100},
    business:{name:"Business",price:40000,price_usd:59.99,monthly_messages:4000,daily_images:300},
    enterprise:{name:"Enterprise",price:100000,price_usd:99.99,monthly_messages:10000,daily_images:800}
  };
  const catalog=entries.length?entries:Object.entries(fallback), cur=u.trial?"free":(u.plan||"free"), factor=BILLING_FACTORS[BILLING_PERIOD]||1;
  grid.innerHTML=catalog.map(([k,p])=>{
    const messages=Number(p.monthly_messages||0), images=Number(p.daily_images||0), ngn=Math.round(Number(p.price||0)*factor), usd=(Number(p.price_usd||0)*factor).toFixed(2), isCur=k===cur;
    const feats=[`${messages.toLocaleString()} messages a month`,`${images.toLocaleString()} images a day`,"Fast and Deep modes",k==="free"?"Chat history":"Premium feature allowance"];
    const price=k==="free"?"Free":(usdView?`US$${usd} <small>/ ${BILLING_LABELS[BILLING_PERIOD]}</small><div class="tiny muted">Charged as ${money(ngn)} (naira)</div>`:`${money(ngn)} <small>/ ${BILLING_LABELS[BILLING_PERIOD]}</small><div class="tiny muted">About US$${usd}</div>`);
    const btn=k==="free"?`<button class="btn" disabled>${isCur?"Your plan":"Included"}</button>`:isCur?`<button class="btn" data-plan="${esc(k)}">Renew ${esc(BILLING_PERIOD)}</button>`:`<button class="btn primary" data-plan="${esc(k)}">Choose ${esc(p.name)}</button>`;
    return `<div class="plan ${k==="pro"?"popular":""} ${isCur?"current":""}">${k==="pro"?`<span class="pill brand tag">Most popular</span>`:""}<h3>${TOP.includes(k)?ico("crown","sm"):""}${esc(p.name)}</h3><div class="price">${price}</div><ul>${feats.map(f=>`<li>${ico("check")}${esc(f)}</li>`).join("")}</ul>${btn}</div>`;
  }).join("");
}
$("billing-period")?.addEventListener("change",e=>{BILLING_PERIOD=e.target.value;renderPlans();});
$("plans-grid").onclick = (e) => { const b = e.target.closest("[data-plan]"); if (b) openCheckout(b.dataset.plan); };
function openCheckout(plan) {
  const p=S.plans[plan]||{}, factor=BILLING_FACTORS[BILLING_PERIOD]||1, amount=Math.round(Number(p.price||0)*factor);
  const usd=(Number(p.price_usd||0)*factor).toFixed(2), days=BILLING_LABELS[BILLING_PERIOD]||"30 days", usdView=((S.user||{}).currency||"NGN")!=="NGN";
  const priceLine=usdView?`US$${usd} (charged as ${money(amount)})`:`${money(amount)} (about US$${usd})`;
  $("pay-card").innerHTML=`<div class="modal-head"><h2 id="pay-title">${esc(p.name)} plan</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <p class="muted" id="pay-summary" style="margin:0">${priceLine} · ${days}. ${Number(p.monthly_messages||0).toLocaleString()} messages/month and ${Number(p.daily_images||0).toLocaleString()} images/day.</p>
    <div style="display:flex;gap:8px;margin-top:12px"><input class="input" id="pay-coupon" placeholder="Coupon code (optional)" maxlength="32" autocapitalize="characters" style="margin:0;flex:1"><button class="btn" id="pay-coupon-apply" type="button">Apply</button></div><p class="tiny" id="pay-coupon-note" style="margin:6px 0 0"></p>
    ${S.paystack?`<button class="btn primary block" id="pay-card-btn" style="margin-top:12px">${ico("card")}Pay by card (naira)</button><p class="tiny muted center" style="margin:8px 0">NGN checkout secured by Paystack.</p>`:""}
    <button class="btn block" id="pay-bank-btn" style="margin-top:${S.paystack?4:12}px">Pay by bank transfer</button><div id="bank-box"></div>`;
  openModal("pay-modal");
  const couponCode=()=>($("pay-coupon").value||"").trim();
  $("pay-coupon-apply").onclick=async()=>{const code=couponCode(),note=$("pay-coupon-note"); if(!code){note.textContent="";return;}
    try{const d=await post("/api/coupons/validate",{code,plan,billingPeriod:BILLING_PERIOD}); note.textContent=d.message; note.style.color="var(--mint, #4ade80)"; $("pay-summary").textContent=`${money(d.amount)} instead of ${money(d.originalAmount)} · ${days}.`;}
    catch(err){note.textContent=err.message; note.style.color="var(--danger, #f87171)";}};
  if(S.paystack)$("pay-card-btn").onclick=async e=>{const b=e.currentTarget;setBtn(b,true);try{const d=await post("/api/paystack/init",{plan,billingPeriod:BILLING_PERIOD,coupon:couponCode()});location.href=d.url;}catch(err){toast(err.message,"error");setBtn(b,false);}};
  $("pay-bank-btn").onclick=async e=>{
    const b=e.currentTarget;setBtn(b,true);
    try{
      const up=await post("/api/upgrade",{plan,billingPeriod:BILLING_PERIOD,coupon:couponCode()}),info=(await api("/api/payment-info")).payment;
      if(!info){$("bank-box").innerHTML=`<p class="notice error">Bank details aren't set up yet. Please contact support.</p>`;return;}
      $("bank-box").innerHTML=`<div class="kv"><div><span>Bank</span><b>${esc(info.bank_name)}</b></div><div><span>Account number</span><b>${esc(info.account_number)} <button class="btn sm" id="copy-acct" style="margin-left:6px">Copy</button></b></div><div><span>Account name</span><b>${esc(info.account_name)}</b></div><div><span>Amount to send</span><b>${money(up.amount)}</b></div><div><span>Duration</span><b>${esc(days)}</b></div></div>
      <p class="tiny muted" style="margin:0 0 8px">${esc(info.extra_note||"")}</p><label class="field" style="margin-top:0">Payment screenshot<input class="input" type="file" id="proof-file" accept="image/*"></label><button class="btn primary block" id="proof-send" style="margin-top:12px">Send screenshot</button><p class="notice" id="proof-note"></p>`;
      $("copy-acct").onclick=async()=>toast((await copyText(info.account_number))?"Account number copied":"Couldn't copy");
      $("proof-send").onclick=async ev=>{const f=$("proof-file").files[0];if(!f)return toast("Choose your screenshot first.");const sb=ev.currentTarget;setBtn(sb,true);const fd=new FormData();fd.append("screenshot",f);try{const d=await api("/api/payment-proof/"+up.requestId,{method:"POST",body:fd});$("proof-note").textContent=d.message;$("proof-note").className="notice success";sb.classList.add("hidden");}catch(err){$("proof-note").textContent=err.message;$("proof-note").className="notice error";setBtn(sb,false);}}
    }catch(err){toast(err.message,"error");}finally{setBtn(b,false);}
  };
}
function renderReferral() {
  const url = `${location.origin}/?login=1&ref=${S.user.referralCode}`; $("ref-url").value = url;
  $("ref-count").textContent = S.user.referrals ? `${S.user.referrals} friend${S.user.referrals === 1 ? "" : "s"} joined with your link.` : "No friends yet. Share your link to earn free days.";
}
$("copy-ref").onclick = async () => toast((await copyText($("ref-url").value)) ? "Invite link copied" : "Couldn't copy");
async function loadLeaderboard() {
  $("lb-weekly").classList.toggle("on", S.lbMode === "weekly"); $("lb-streak").classList.toggle("on", S.lbMode === "streak"); $("lb-referrals").classList.toggle("on", S.lbMode === "referrals");
  $("leaderboard-list").innerHTML = `<div style="display:grid;gap:12px;padding:8px 0"><span class="skeleton"></span><span class="skeleton w60"></span><span class="skeleton w40"></span></div>`;
  try {
    const d = await api("/api/leaderboard?mode=" + S.lbMode); let html = "";
    if (d.mode === "weekly") { const h = Math.floor(d.resetsInSeconds / 3600), days = Math.floor(h / 24); html += (d.prize ? `<div class="prize">${ico("trophy")}<span>${esc(d.prize)}</span></div>` : "") + `<p class="tiny muted" style="margin:4px 0 0">Most messages this week. Resets in ${days ? days + "d " : ""}${h % 24}h.</p>`; }
    html += d.leaders.length ? d.leaders.map((l, i) => `<div class="board-row"><span class="rank">${i + 1}</span><span>${esc(l.username)}</span><span class="score">${d.mode === "streak" ? ico("flame", "sm") + l.score + " days" : d.mode === "referrals" ? l.score + (l.score === 1 ? " friend" : " friends") : l.score + " messages"}</span></div>`).join("") : `<div class="empty">Nobody yet. Be the first!</div>`;
    $("leaderboard-list").innerHTML = html;
  } catch (e) { $("leaderboard-list").innerHTML = `<div class="empty">Couldn't load the leaderboard.</div>`; }
}
$("lb-weekly").onclick = () => { S.lbMode = "weekly"; loadLeaderboard(); }; $("lb-streak").onclick = () => { S.lbMode = "streak"; loadLeaderboard(); }; $("lb-referrals").onclick = () => { S.lbMode = "referrals"; loadLeaderboard(); };

/* ---------------------------------------------------------------- Settings */
const BADGE_ICONS = { chat: "chat", zap: "zap", flame: "flame", image: "image", share: "share", link: "link" };
$("open-settings").onclick = async () => {
  const u = S.user; $("set-username").textContent = u.username; $("set-email").textContent = u.email.endsWith(".invalid") ? "Admin account" : u.email; $("set-plan").textContent = planLabel(); $("set-vyra-id").textContent = u.publicId || "Not assigned";
  $("persona-text").value = u.customPersona || ""; $("persona-text").disabled = !u.canUsePersona; $("save-persona").disabled = !u.canUsePersona;
  $("persona-lock").textContent = u.canUsePersona ? "" : "Custom personas come with any paid plan. Upgrade to unlock.";
  $("about-me-text").value = u.aboutMe || ""; $("ai-nickname").value = u.aiNickname || "";
  $("install-btn").parentElement.classList.toggle("hidden", !window.vyraInstall && !/iphone|ipad/i.test(navigator.userAgent));
  $("delete-account").classList.toggle("hidden", u.isAdmin); $("admin-2fa-block").classList.toggle("hidden", !u.isAdmin); if (u.isAdmin) load2faBlock(); openModal("settings-modal");
  const badges = S.badges || [];
  $("badges-list").innerHTML = badges.length ? badges.map((b) => `<span class="badge" title="${esc(b.label)}">${ico(BADGE_ICONS[b.icon] || "check", "sm")}${esc(b.label)}</span>`).join("") : `<p class="muted tiny" style="margin:0">Keep chatting, checking in and sharing to earn badges.</p>`;
  $("sessions-list").innerHTML = "Loading...";
  try { const d = await api("/api/user/sessions"); $("sessions-list").innerHTML = d.sessions.length ? d.sessions.map((s) => `<div>${esc(s.ip || "Unknown")} · ${esc(new Date(s.at).toLocaleString("en-NG"))}</div>`).join("") : "No recent sign-ins on record."; } catch (e) { $("sessions-list").textContent = "Couldn't load."; }
};
$("save-persona").onclick = async () => { try { await post("/api/user/update-persona", { persona: $("persona-text").value }); toast("Persona saved"); await refreshMe(); closeModals(); } catch (e) { toast(e.message, "error"); } };
$("save-about").onclick = async () => { try { await post("/api/user/profile-extra", { aboutMe: $("about-me-text").value, aiNickname: $("ai-nickname").value }); toast("Saved"); await refreshMe(); closeModals(); } catch (e) { toast(e.message, "error"); } };
$("logout-others").onclick = () => confirmBox("Log out of all other devices?", "This signs you out everywhere except here.", "Log out others", async () => { await post("/api/user/logout-other-devices"); toast("Other devices signed out"); });
$("install-btn").onclick = async () => {
  if (window.vyraInstall) { window.vyraInstall.prompt(); await window.vyraInstall.userChoice; window.vyraInstall = null; } else toast("On iPhone: tap Share, then Add to Home Screen.");
};
$("logout").onclick = async () => { try { localStorage.removeItem(CHAT_CACHE_KEY); } catch (e) {} try { await post("/logout"); } catch (e) {} location.href = "/?login=1"; };
$("delete-account").onclick = () => {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Delete your account?</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><p class="muted">This permanently deletes your account, chats and images. Enter your password to confirm.</p><input class="input" id="del-pw" type="password" autocomplete="current-password" placeholder="Your password"><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button class="btn" data-close>Cancel</button><button class="btn danger" id="del-go">Delete my account</button></div>`;
  openModal("generic-modal"); $("del-go").onclick = async () => { try { await post("/api/user/delete", { password: $("del-pw").value }); location.href = "/"; } catch (e) { toast(e.message, "error"); } };
};

/* ---------------------------------------------------------------- Admin */
const ADMIN_TABS = [["overview", "Overview"], ["today", "Today"], ["health", "Health"], ["reports", "Reports"], ["growth", "Growth"], ["tools", "Admin tools"], ["users", "Users"], ["payments", "Payments"], ["codes", "Codes"], ["broadcast", "Broadcast"], ["inbox", "Inbox"], ["coupons", "Coupons"], ["rewards", "Rewards"], ["logs", "Logs & backup"]];
function bars(data, money_) {
  const w = 300, h = 120, n = data.length, max = Math.max(1, ...data.map((d) => Number(d.n))), bw = w / n;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Bar chart">${data.map((d, i) => { const v = Number(d.n), bh = v ? Math.max(3, (v / max) * (h - 6)) : 1; return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}"><title>${esc(d.day)}: ${money_ ? money(v) : v}</title></rect>`; }).join("")}</svg><div class="axis"><span>${esc(data[0].day.slice(5))}</span><span>peak ${money_ ? money(max) : max}</span><span>${esc(data[n - 1].day.slice(5))}</span></div>`;
}
async function renderAdmin(tab) {
  S.adminTab = tab;
  $("admin-tabs").innerHTML = ADMIN_TABS.map(([k, l]) => `<button class="btn sm ${k === tab ? "primary" : ""}" data-atab="${k}">${l}</button>`).join("");
  const body = $("admin-body"); body.innerHTML = `<div class="card"><span class="skeleton"></span></div>`;
  try {
    if (tab === "tools") {
      const groups = [
        ["User & account control", "users", "Manage user plans, suspend or restore accounts."],
        ["Payment review", "payments", "Review bank-transfer proof and approve or reject pending payments."],
        ["Signup & recovery codes", "codes", "Review and approve verification or password-reset requests."],
        ["Announcements", "broadcast", "Send a platform notice to registered users."],
        ["Rewards", "rewards", "Configure weekly prize notes and award weekly activity prizes."],
        ["Security, logs & backup", "logs", "Review failed sign-ins and audit events; download a user/payment backup."],
        ["Analytics overview", "overview", "View signups, usage, revenue, active users and plan distribution."]
      ];
      body.innerHTML = `<div class="admin-tool-grid">${groups.map(([title, key, desc]) => `<button class="card admin-tool" type="button" data-tool="${key}"><strong>${esc(title)}</strong><span class="muted">${esc(desc)}</span><span class="admin-tool-link">Open section ${ico("arrow-right")}</span></button>`).join("")}</div><div class="notice" style="margin-top:14px">Admin actions are available only to verified administrator accounts. Changes such as plan updates, payment approvals and broadcasts are logged where applicable.</div>`;
    }
    if (tab === "today") {
      const d = await api("/api/admin/summary"), t = d.today, y = d.yesterday;
      const arrow = (a, b) => (a === b ? "" : `<small class="muted"> ${a > b ? "up" : "down"} from ${b.toLocaleString()}</small>`);
      const tile = (l, v, prev, fmt) => `<div class="tile"><span>${l}</span><b>${fmt ? fmt(v) : v.toLocaleString()}</b>${prev === undefined ? "" : arrow(v, prev)}</div>`;
      const cost = (c) => `$${c.usd.toFixed(2)} <small class="muted">(${Object.entries(c.replies).map(([k, n]) => n + " " + k).join(", ") || "no replies"}; ${c.images} images)</small>`;
      body.innerHTML = `<div class="card"><h3>Today (Lagos time)</h3><div class="tiles">${tile("New signups", t.signups, y.signups)}${tile("Active users", t.activeUsers, y.activeUsers)}${tile("Messages sent", t.messages, y.messages)}${tile("Images made", t.images, y.images)}${tile("Revenue", t.revenue, y.revenue, money)}</div></div>
        <div class="card" style="margin-top:14px"><h3>Needs your attention</h3><div class="tiles">${tile("Payments to review", d.pendingPayments)}${tile("Open reports", d.openReports)}${tile("Unread support chats", d.unreadSupport)}${tile("Relaunch trials claimed", d.trialClaims)}</div></div>
        <div class="card" style="margin-top:14px"><h3>AI cost (estimate)</h3><div class="row"><div class="grow"><b>Today</b><small>${cost(d.aiToday)}</small></div></div><div class="row"><div class="grow"><b>This month</b><small>${cost(d.aiMonth)}</small></div></div>
        <p class="muted tiny" style="margin:8px 0 0">An estimate from reply counts and per-reply rates, not your real Groq bill. Set AI_COST_FAST, AI_COST_BALANCED, AI_COST_DEEP (US$ per reply) on Render to match your plan. Replies from before batch 1 count as Balanced.</p></div>`;
    }
    if (tab === "health") {
      body.innerHTML = `<div class="card"><h3>System health</h3><p class="muted">Checking...</p></div>`;
      const d = await api("/api/admin/health");
      body.innerHTML = `<div class="card"><h3>System health</h3>${d.checks.map((c) => `<div class="row"><div class="grow"><b>${esc(c.name)}</b><small>${esc(c.detail)} · ${c.ms} ms</small></div><span class="status ${c.ok ? "approved" : "rejected"}">${c.ok ? "OK" : "Problem"}</span></div>`).join("")}<p class="muted tiny" style="margin:8px 0 0">Site address: ${esc(d.siteUrl)}</p><button class="btn" id="health-refresh" style="margin-top:8px">Check again</button></div>
        <div class="card" style="margin-top:14px"><h3>Send a test email</h3><div style="display:flex;gap:8px"><input class="input" id="te-to" type="email" placeholder="your@email.com" aria-label="Email address"><button class="btn primary" id="te-send">Send</button></div></div>`;
    }
    if (tab === "reports") {
      const d = await api("/api/admin/reports");
      body.innerHTML = `<div class="card"><h3>Reported answers</h3>${d.reports.map((r) => `<div class="row" style="align-items:flex-start"><div class="grow"><b>${esc(r.reason)} · ${esc(r.username)}</b><small>${fmtDate(r.createdAt)}${r.details ? " · " + esc(r.details) : ""}</small><div class="tiny" style="margin-top:6px"><b>Question:</b> ${esc(r.question)}</div><div class="tiny" style="margin-top:4px"><b>Answer:</b> ${esc(r.answer)}</div></div><button class="btn sm" data-rep="${r.id}">Resolve</button></div>`).join("") || '<p class="muted">No open reports.</p>'}</div>`;
    }
    if (tab === "growth") {
      const [pr, gl, st] = await Promise.all([api("/api/admin/promo"), api("/api/admin/gift-links"), api("/api/admin/student-requests")]);
      body.innerHTML = `<div class="card"><h3>Promo banner</h3><p class="muted tiny">Shown at the top of the app for every user. They can dismiss it.${pr.promo ? ` Live now: "${esc(pr.promo.text)}"` : " Nothing live now."}</p>
        <input class="input" id="promo-input" maxlength="200" placeholder="e.g. 20% off all plans this weekend with code WEEKEND20"><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><select class="input" id="promo-days" style="max-width:170px"><option value="3">Show for 3 days</option><option value="7" selected>Show for 7 days</option><option value="30">Show for 30 days</option><option value="0">Until I remove it</option></select><button class="btn primary" id="promo-save">Publish</button><button class="btn" id="promo-clear">Remove banner</button></div></div>
        <div class="card" style="margin-top:14px"><h3>Gift links</h3><p class="muted tiny">Create a one-time link. Whoever opens it and signs in gets the plan. Links expire after 30 days.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><select class="input" id="gl-plan" style="max-width:170px">${["starter", "plus", "pro", "business", "enterprise"].map((k) => `<option value="${k}">${esc(S.plans[k]?.name || k)}</option>`).join("")}</select><input class="input" id="gl-days" type="number" min="1" max="365" value="30" style="max-width:110px" aria-label="Days"><button class="btn primary" id="gl-create">Create link</button></div><div id="gl-new" class="tiny" style="margin-top:8px;word-break:break-all"></div>
        ${gl.links.map((l) => `<div class="row"><div class="grow"><b>${esc(l.plan)} · ${l.days} days</b><small>${l.redeemedBy ? "Used by " + esc(l.redeemedBy) : "Not used yet"} · ${fmtDate(l.createdAt)}</small></div>${l.redeemedBy ? "" : `<button class="btn sm" data-gl-copy="${esc(l.url)}">Copy link</button>`}</div>`).join("")}</div>
        <div class="card" style="margin-top:14px"><h3>Student discount requests</h3>${st.requests.map((r) => `<div class="row"><div class="grow"><b>${esc(r.username)} · ${esc(r.school)}</b><small>${esc(r.email)}${r.note ? " · " + esc(r.note) : ""}</small></div><button class="btn sm primary" data-stu="approve" data-id="${r.id}">Approve 30%</button><button class="btn sm danger" data-stu="reject" data-id="${r.id}">Reject</button></div>`).join("") || '<p class="muted">No pending requests.</p>'}</div>`;
    }
    if (tab === "overview") {
      const d = await api("/api/admin/stats"), t = d.totals, sum = (a) => a.reduce((x, y) => x + Number(y.n), 0);
      const tile = (l, v) => `<div class="tile"><span>${l}</span><b>${v}</b></div>`;
      body.innerHTML = `<div class="tiles">${tile("Users", t.users)}${tile("Paying now", t.paying)}${tile("Active today", t.dau)}${tile("Active this week", t.wau)}${tile("Messages sent", Number(t.messages).toLocaleString())}${tile("Revenue", money(t.revenue))}${tile("Payments to review", t.pending_payments)}${tile("Codes to approve", t.pending_otps)}${tile("Unread support chats", t.unread_threads)}${tile("Helpful replies", t.feedback_up)}${tile("Unhelpful replies", t.feedback_down)}${tile("Referral signups", t.referral_signups)}</div>
      <div class="charts"><div class="card chart"><h3>New signups, last 30 days</h3><div class="total">${sum(d.signups)}</div>${bars(d.signups)}</div><div class="card chart"><h3>Active users per day</h3><div class="total">${t.wau} this week</div>${bars(d.active)}</div><div class="card chart money"><h3>Revenue, last 30 days</h3><div class="total">${money(sum(d.revenue))}</div>${bars(d.revenue, true)}</div></div>
      <div class="card" style="margin-top:14px"><h3>Users by plan</h3><div class="chips" style="margin-top:10px">${d.plans.map((p) => `<span class="pill">${esc(S.plans[p.plan]?.name || p.plan)}: ${p.n}</span>`).join("") || "<span class=muted>No users yet</span>"}</div></div>`;
    }
    if (tab === "users") { await adminUsers(); }
    if (tab === "payments") {
      const d = await api("/api/admin/payment-requests"); const ps = (await api("/api/admin/payment-settings")).payment || {};
      body.innerHTML = `<div class="card"><h3>Bank details shown to customers</h3><div class="grid two"><label class="field">Bank<input class="input" id="ps-bank" maxlength="80" value="${esc(ps.bank_name || "")}"></label><label class="field">Account number<input class="input" id="ps-number" maxlength="40" value="${esc(ps.account_number || "")}"></label><label class="field">Account name<input class="input" id="ps-name" maxlength="120" value="${esc(ps.account_name || "")}"></label><label class="field">Note<input class="input" id="ps-note" maxlength="500" value="${esc(ps.extra_note || "")}"></label></div><button class="btn primary" id="ps-save">Save bank details</button></div><div class="card" style="margin-top:12px"><h3>Payment requests</h3>${d.requests.length ? d.requests.map((r) => `<div class="row"><div class="grow"><b>${esc(r.username)} · ${esc(S.plans[r.plan]?.name || r.plan)} · ${money(r.amount_ngn)}</b><small>${r.provider === "paystack" ? "Card" : "Bank transfer"} · ${fmtDate(r.created_at)}</small></div><span class="status ${esc(r.status)}">${esc(r.status)}</span>${r.proof_id ? `<button class="btn sm" data-proof="${r.proof_id}">View proof</button>` : ""}${r.status === "pending" ? `<button class="btn sm primary" data-pay="approve" data-id="${r.id}">Approve</button><button class="btn sm danger" data-pay="reject" data-id="${r.id}">Reject</button>` : ""}</div>`).join("") : `<div class="empty">No payments yet.</div>`}</div>`;
    }
    if (tab === "codes") {
      const d = await api("/api/admin/otp-requests");
      body.innerHTML = `<div class="card"><p class="muted tiny" style="margin:0 0 6px">These appear when email isn't set up, or when sending failed. Approve one and send the code to the person.</p>${d.requests.length ? d.requests.map((r) => `<div class="row"><div class="grow"><b>${esc(r.email)}</b><small>${r.purpose === "reset" ? "Password reset" : "Sign-up"} · code ${esc(r.code)}</small></div><span class="status ${r.status === "approved" ? "approved" : "pending"}">${esc(r.status)}</span>${r.status === "pending" ? `<button class="btn sm primary" data-otp="${r.id}">Approve</button>` : ""}</div>`).join("") : `<div class="empty">No codes waiting.</div>`}</div>`;
    }
    if (tab === "coupons") {
      const d = await api("/api/admin/coupons");
      body.innerHTML = `<div class="card"><h3>Create coupon</h3><div class="grid two"><label class="field">Code<input class="input" id="coupon-code" placeholder="WELCOME20" maxlength="32"></label><label class="field">Type<select class="input" id="coupon-type"><option value="percent">Percentage</option><option value="fixed">Fixed amount (NGN)</option></select></label><label class="field">Value<input class="input" id="coupon-value" type="number" min="0.01" step="0.01"></label><label class="field">Plan (optional)<select class="input" id="coupon-plan"><option value="">All plans</option>${Object.entries(S.plans).filter(([k])=>k!=="free").map(([k,p])=>`<option value="${k}">${esc(p.name)}</option>`).join("")}</select></label><label class="field">Max uses (optional)<input class="input" id="coupon-max" type="number" min="1"></label><label class="field">Expires (optional)<input class="input" id="coupon-expiry" type="date"></label></div><button class="btn primary" id="coupon-create">Create coupon</button></div><div class="card" style="margin-top:12px"><h3>Existing coupons</h3>${d.coupons.map(c=>`<div class="row"><div class="grow"><b>${esc(c.code)} · ${c.discount_type==="percent"?c.discount_value+"%":money(c.discount_value)}</b><small>${esc(c.applicable_plan||"All paid plans")} · ${c.uses}${c.max_uses?"/"+c.max_uses:""} uses · ${c.active?"Active":"Disabled"}</small></div><button class="btn sm" data-coupon-toggle="${c.id}">${c.active?"Disable":"Enable"}</button></div>`).join("")||"<div class=empty>No coupons yet.</div>"}</div>`;
    }
    if (tab === "broadcast") body.innerHTML = `<div class="card"><h3>Message every user</h3><textarea class="input" id="bc-msg" rows="3" maxlength="1000" placeholder="Write a short update"></textarea><button class="btn primary" id="bc-send" style="margin-top:10px">Send to all users</button></div>`;
    if (tab === "rewards") body.innerHTML = `<div class="card"><h3>Weekly prize note</h3><p class="muted tiny" style="margin:4px 0 0">Shown above the weekly leaderboard.</p><input class="input" id="prize-text" maxlength="140" placeholder="Top 3 this week win bonus messages"><button class="btn" id="prize-save" style="margin-top:10px">Save note</button></div><div class="card" style="margin-top:14px"><h3>Award last week's winners</h3><p class="muted tiny" style="margin:4px 0 10px">Gives the top 3 chatters +100, +50 and +25 bonus messages. Works once per week.</p><button class="btn primary" id="award-go">Award last week's top 3</button></div>`;
    if (tab === "inbox") {
      const d = await api("/api/admin/inbox");
      body.innerHTML = `<div class="card"><h3>Support inbox</h3>${d.threads.length ? d.threads.map((t) => `<div class="row"><div class="grow"><b>${esc(t.username)} ${t.unread ? `<span class="status pending">${t.unread} new</span>` : ""}</b><small>${esc(t.lastMessage)} · ${fmtDate(t.lastAt)}</small></div><button class="btn sm primary" data-inbox-open="${t.userId}">Open</button></div>`).join("") : `<div class="empty">No messages yet.</div>`}</div>`;
    }
    if (tab === "logs") {
      const d = await api("/api/admin/audit" + (S.auditDate ? "?date=" + S.auditDate : ""));
      body.innerHTML = `<div class="card"><h3>Filter by date</h3><div style="display:flex;gap:8px;flex-wrap:wrap"><input type="date" id="audit-date" class="input" value="${esc(S.auditDate || "")}" style="max-width:190px"><button class="btn primary" id="audit-go">Filter</button><button class="btn" id="audit-clear">Show latest</button></div></div><div class="card" style="margin-top:14px"><h3>Backup</h3><p class="muted tiny" style="margin:4px 0 10px">Downloads users and payments as a file. Keep it somewhere private.</p><a class="btn" href="/api/admin/export" download>${ico("download")}Download backup</a></div><div class="card" style="margin-top:14px"><h3>Failed sign-ins</h3>${d.failedLogins.length ? d.failedLogins.map((f) => `<div class="row"><div class="grow"><b>${esc(f.username || "(blank)")}</b><small>${esc(f.ip)} · ${new Date(f.created_at).toLocaleString("en-NG")}</small></div></div>`).join("") : `<div class="empty">None. Nice.</div>`}</div><div class="card" style="margin-top:14px"><h3>Admin actions</h3>${d.audit.length ? d.audit.map((a) => `<div class="row"><div class="grow"><b>${esc(a.action)}</b><small>${esc(a.actor || "")} · ${esc(a.detail || "")} · ${new Date(a.created_at).toLocaleString("en-NG")}</small></div></div>`).join("") : `<div class="empty">Nothing yet.</div>`}</div>`;
    }
  } catch (e) { body.innerHTML = `<div class="card"><p class="notice error">${esc(e.message)}</p></div>`; }
}
$("admin-page").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-atab]"); if (t) return renderAdmin(t.dataset.atab);
  const tool = e.target.closest("[data-tool]"); if (tool) return renderAdmin(tool.dataset.tool);
  try {
    const dm = e.target.closest("[data-admin-msg-user]"); if (dm) { const uname=dm.dataset.adminMsgName||"customer"; $("generic-card").innerHTML=`<div class="modal-head"><h2>Message ${esc(uname)}</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><textarea class="input" id="admin-direct-message" rows="4" maxlength="2000" placeholder="Write a private message to this customer"></textarea><button class="btn primary block" id="admin-direct-send" data-user-id="${dm.dataset.adminMsgUser}" style="margin-top:10px">Send private message</button>`; openModal("generic-modal"); return; }
    if (e.target.closest("#coupon-create")) { const code=$("coupon-code").value.trim(), value=$("coupon-value").value; const d=await post("/api/admin/coupons",{code,discount_type:$("coupon-type").value,discount_value:value,applicable_plan:$("coupon-plan").value,max_uses:$("coupon-max").value||null,expires_at:$ ("coupon-expiry").value||null}); toast(`Coupon ${d.code} created`); return renderAdmin("coupons"); }
    const sp = e.target.closest("[data-suspend]"); if (sp) { await post(`/api/admin/users/${sp.dataset.suspend}/suspend`, { suspended: sp.dataset.on === "1" }); return renderAdmin("users"); }
    const pay = e.target.closest("[data-pay]"); if (pay) { await post(`/api/admin/payment-requests/${pay.dataset.id}/${pay.dataset.pay}`); toast(pay.dataset.pay === "approve" ? "Approved. The plan is active." : "Rejected"); return renderAdmin("payments"); }
    const pr = e.target.closest("[data-proof]"); if (pr) { $("generic-card").innerHTML = `<div class="modal-head"><h2>Payment proof</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><img class="proof-img" alt="Payment screenshot" src="/api/admin/payment-proof/${pr.dataset.proof}">`; return openModal("generic-modal"); }
    const otp = e.target.closest("[data-otp]"); if (otp) { const d = await post(`/api/admin/approve-otp/${otp.dataset.otp}`); toast(d.message); return renderAdmin("codes"); }
    if (e.target.closest("#bc-send")) { const d = await post("/api/admin/broadcast", { message: $("bc-msg").value }); toast(`Sent to ${d.sent} users`); $("bc-msg").value = ""; }
    if (e.target.closest("#prize-save")) { await post("/api/admin/weekly-prize", { prize: $("prize-text").value }); toast("Saved"); }
    if (e.target.closest("#award-go")) { const d = await post("/api/admin/award-weekly"); toast(d.message); }
  } catch (err) { toast(err.message, "error"); }
});
$("admin-page").addEventListener("change", async (e) => {
  const s = e.target.closest("[data-setplan]"); if (!s) return;
  try { await post(`/api/admin/users/${s.dataset.setplan}/plan`, { plan: s.value }); toast("Plan updated"); renderAdmin("users"); } catch (err) { toast(err.message, "error"); }
});

document.addEventListener("click",async(e)=>{const b=e.target.closest("#admin-direct-send");if(!b)return;try{const msg=$("admin-direct-message").value.trim();if(!msg)return toast("Write a message first.");await post(`/api/admin/users/${b.dataset.userId}/message`,{message:msg});closeModals();toast("Private message sent.");}catch(err){toast(err.message,"error");}});
$("copy-vyra-id")?.addEventListener("click",async()=>{const id=S.user?.publicId||""; if(!id)return toast("VYRA ID unavailable"); toast(await copyText(id)?"VYRA ID copied":"Unable to copy ID");});
$("restart-tour")?.addEventListener("click",()=>{try{localStorage.removeItem("vyra-tour");}catch(_){}closeModals();runTour(0);});
/* ---------------------------------------------------------------- support inbox, bank details, coupon switch */
function threadHtml(messages, adminView) {
  return messages.length ? messages.map((m) => { const mine = adminView ? m.sender === "admin" : m.sender === "user";
    return `<div class="notif-item ${mine ? "read" : ""}"><b>${m.sender === "admin" ? "VYRA Admin" : (adminView ? "Customer" : "You")}</b><p style="margin:2px 0">${esc(m.message)}</p><small>${fmtTime(m.createdAt)}</small></div>`; }).join("") : "No messages yet.";
}
async function openSupport() {
  closeModals();
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Contact support</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><div id="support-thread" class="tiny" style="max-height:40vh;overflow:auto;margin-bottom:10px">Loading...</div><textarea class="input" id="support-text" rows="3" maxlength="2000" placeholder="Describe your question or problem"></textarea><button class="btn primary block" id="support-send" style="margin-top:10px">Send message</button>`;
  openModal("generic-modal");
  const load = async () => { try { const d = await api("/api/support/messages"); $("support-thread").innerHTML = threadHtml(d.messages, false); $("support-thread").scrollTop = 1e6; loadNotifs().catch(() => {}); } catch (e) { $("support-thread").textContent = e.message; } };
  load();
  $("support-send").onclick = async () => { const t = $("support-text").value.trim(); if (t.length < 2) return toast("Write your message first."); try { await post("/api/support/messages", { message: t }); $("support-text").value = ""; toast("Message sent. The admin will reply here."); load(); } catch (e) { toast(e.message, "error"); } };
}
$("open-support")?.addEventListener("click", openSupport);
async function openInbox(userId) {
  $("generic-card").innerHTML = `<div class="modal-head"><h2 id="inbox-title">Conversation</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><div id="inbox-thread" class="tiny" style="max-height:40vh;overflow:auto;margin-bottom:10px">Loading...</div><div style="display:flex;gap:6px;margin-bottom:6px"><select class="select" id="canned-sel" style="flex:1;max-width:none" aria-label="Canned replies"><option value="">Canned replies...</option></select><button type="button" class="btn sm danger hidden" id="canned-del">Delete</button></div><textarea class="input" id="inbox-text" rows="3" maxlength="2000" placeholder="Write a reply"></textarea><div style="display:flex;gap:8px;margin-top:10px"><button class="btn" id="canned-save" type="button">Save as canned</button><button class="btn primary grow" id="inbox-send">Send reply</button></div>`;
  openModal("generic-modal"); loadCanned();
  const load = async () => { try { const d = await api("/api/admin/inbox/" + userId); $("inbox-title").textContent = "Conversation with " + d.username; $("inbox-thread").innerHTML = threadHtml(d.messages, true); $("inbox-thread").scrollTop = 1e6; } catch (e) { $("inbox-thread").textContent = e.message; } };
  load();
  $("inbox-send").onclick = async () => { const t = $("inbox-text").value.trim(); if (!t) return toast("Write a reply first."); try { await post(`/api/admin/inbox/${userId}/reply`, { message: t }); $("inbox-text").value = ""; toast("Reply sent."); load(); } catch (e) { toast(e.message, "error"); } };
}
document.addEventListener("click", async (e) => {
  const open = e.target.closest("[data-inbox-open]"); if (open) { openInbox(open.dataset.inboxOpen); return; }
  const tg = e.target.closest("[data-coupon-toggle]"); if (tg) { try { await post(`/api/admin/coupons/${tg.dataset.couponToggle}/toggle`); renderAdmin("coupons"); } catch (err) { toast(err.message, "error"); } return; }
  if (e.target.closest("#ps-save")) { try { await post("/api/admin/payment-settings", { bank_name: $("ps-bank").value, account_number: $("ps-number").value, account_name: $("ps-name").value, extra_note: $("ps-note").value }); toast("Bank details saved."); } catch (err) { toast(err.message, "error"); } }
});

/* ---------------------------------------------------------------- follow-ups, voice, read aloud, tour */
const FOLLOWUPS = ["Explain it simpler", "Give me an example", "Make it shorter"];
async function showFollowups() {
  document.querySelectorAll(".followups").forEach((x) => x.remove());
  const last = S.msgs[S.msgs.length - 1];
  if (!last || last.role !== "assistant" || !last.el || last.el.querySelector(".msg-error") || !last.content) return;
  let list = FOLLOWUPS;
  if (last.id) { try { const d = await post(`/api/messages/${last.id}/followups`); if (d.followups && d.followups.length) list = d.followups; } catch (e) {} }
  if (S.busy || S.msgs[S.msgs.length - 1] !== last || !last.el.isConnected) return; // the chat moved on while we waited
  document.querySelectorAll(".followups").forEach((x) => x.remove());
  last.el.insertAdjacentHTML("beforeend", `<div class="followups">${list.map((f) => `<button type="button" class="chip" data-followup="${esc(f)}">${esc(f)}</button>`).join("")}</div>`);
}
document.addEventListener("click", (e) => { const f = e.target.closest("[data-followup]"); if (f && !S.busy) send(f.dataset.followup); });
function speak(text) {
  if (!("speechSynthesis" in window)) return toast("Your browser can't read aloud.");
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
  speechSynthesis.speak(new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, " code block. ").replace(/[*_`#>]/g, "").slice(0, 3000)));
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  let rec = null; $("mic-btn").classList.remove("hidden");
  $("mic-btn").onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = "en-NG"; rec.interimResults = true; const base = $("message-input").value;
    rec.onresult = (e) => { let t = ""; for (const r of e.results) t += r[0].transcript; $("message-input").value = (base ? base + " " : "") + t; autosize(); };
    rec.onend = () => { rec = null; $("mic-btn").classList.remove("rec"); };
    rec.onerror = () => toast("Couldn't hear you. Check that the microphone is allowed.");
    rec.start(); $("mic-btn").classList.add("rec");
  };
}

async function loadWorkspace() {
  try {
    const [projects, memories, skills, prefs] = await Promise.all([
      api("/api/projects"), api("/api/memory"), api("/api/skills"), api("/api/preferences")
    ]);
    S.projectCache = projects.projects || [];
    if (S.selectedProject && !S.projectCache.some((x) => x.id === S.selectedProject)) { S.selectedProject = null; store.set("vyra-project", ""); }
    renderProjects(); $("project-file-tools").classList.toggle("hidden", !S.selectedProject); loadProjectFiles();
    $("memory-list").innerHTML = renderMemories(memories.memories || []);
    $("skill-list").innerHTML = (skills.skills||[]).map(x=>`<div class="board-row"><b>${esc(x.name)}</b> <code>/${esc(x.slash_command)}</code><button class="btn sm danger" data-skill-delete="${x.id}">Delete</button></div>`).join("") || `<p class="tiny muted">No Skills saved.</p>`;
    let detectedCountry = prefs.country || "";
    const localeParts=(navigator.language||"en-US").split("-");
    const localeCountry=(localeParts.length>1 && localeParts[1].length===2)?localeParts[1].toUpperCase():"";
    const tz=(Intl.DateTimeFormat().resolvedOptions().timeZone||"");
    if(!detectedCountry) detectedCountry=localeCountry || (tz==="Africa/Lagos"?"NG":"");
    const localCurrency=({NG:"NGN",US:"USD",GB:"GBP",CA:"CAD",GH:"GHS",KE:"KES",ZA:"ZAR",FR:"EUR",DE:"EUR",ES:"EUR",BR:"BRL"})[detectedCountry] || prefs.currency || "USD";
    const localLanguage=({fr:"French",es:"Spanish",de:"German",pt:"Portuguese",yo:"Yoruba",ha:"Hausa",ig:"Igbo"})[localeParts[0]] || prefs.language || "English";
    $("pref-country").value=detectedCountry;
    $("pref-currency").value=prefs.currency || localCurrency;
    $("pref-language").value=prefs.language || localLanguage;
  } catch(e) { toast(e.message,"error"); }
}
$("project-create").onclick=async()=>{try{await post("/api/projects",{name:$("project-name").value,instructions:$("project-instructions").value,persona:S.tplPersona||""});S.tplPersona="";$("project-template").value="";$("project-name").value="";$("project-instructions").value="";await loadWorkspace();toast("Project created.");}catch(e){toast(e.message,"error");}};
S.selectedProject = Number(store.get("vyra-project")) || null;
function renderProjects() {
  const sel = S.selectedProject;
  $("project-list").innerHTML = (S.projectCache || []).map((x) => `<div class="board-row"><b>${esc(x.name)}</b>${sel === x.id ? ' <span class="status approved">Selected</span>' : ""}<div class="tiny muted">${esc(x.instructions || "No extra instructions")}</div><button class="btn sm" data-project-select="${x.id}">Select</button><button class="btn sm" data-project-edit="${x.id}">Edit</button><button class="btn sm danger" data-project-delete="${x.id}">Delete</button></div>`).join("") || `<p class="tiny muted">No projects yet.</p>`;
}
async function loadProjectFiles() {
  const box = $("project-file-list"); if (!box) return;
  if (!S.selectedProject) { box.innerHTML = ""; return; }
  try {
    const d = await api(`/api/projects/${S.selectedProject}/files`);
    box.innerHTML = d.files.map((f) => `<div class="board-row"><b>${esc(f.filename)}</b><div class="tiny muted">${esc((f.preview || "").slice(0, 120))}</div><button class="btn sm danger" data-pfile-delete="${f.id}">Remove</button></div>`).join("") || `<p class="tiny muted">No files in this project yet.</p>`;
  } catch (e) { box.innerHTML = `<p class="tiny muted">${esc(e.message)}</p>`; }
}
$("project-create").onclick=async()=>{try{await post("/api/projects",{name:$("project-name").value,instructions:$("project-instructions").value,persona:S.tplPersona||""});S.tplPersona="";$("project-template").value="";$("project-name").value="";$("project-instructions").value="";await loadWorkspace();toast("Project created.");}catch(e){toast(e.message,"error");}};
$("project-list").onclick=async e=>{
  const select=e.target.closest("[data-project-select]"), del=e.target.closest("[data-project-delete]"), edit=e.target.closest("[data-project-edit]");
  if(select){S.selectedProject=Number(select.dataset.projectSelect);store.set("vyra-project",String(S.selectedProject));renderProjects();$("project-file-tools").classList.remove("hidden");loadProjectFiles();toast("Project selected. Add files, then press Use this project in Chat.");}
  if(edit){const x=(S.projectCache||[]).find(p=>p.id===Number(edit.dataset.projectEdit));if(!x)return;
    $("generic-card").innerHTML=`<div class="modal-head"><h2>Edit project</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><label class="field">Name<input class="input" id="pe-name" maxlength="100"></label><label class="field">Instructions<textarea class="input" id="pe-instr" rows="4" maxlength="4000"></textarea></label><label class="field">Persona for this project (optional)<textarea class="input" id="pe-persona" rows="3" maxlength="1000" placeholder="e.g. You are a patient maths tutor for secondary school students"></textarea></label><button class="btn primary block" id="pe-save">Save</button>`;
    $("pe-name").value=x.name;$("pe-instr").value=x.instructions||"";$("pe-persona").value=x.persona||"";openModal("generic-modal");
    $("pe-save").onclick=async()=>{try{await api("/api/projects/"+x.id,{method:"PATCH",body:JSON.stringify({name:$("pe-name").value,instructions:$("pe-instr").value,persona:$("pe-persona").value})});closeModals();await loadWorkspace();toast("Project updated.");}catch(err){toast(err.message,"error");}};}
  if(del){if(!confirm("Delete this project and its files? Your chats are kept."))return;try{await api("/api/projects/"+del.dataset.projectDelete,{method:"DELETE"});if(S.selectedProject===Number(del.dataset.projectDelete)){S.selectedProject=null;store.set("vyra-project","");}if(S.projectId===Number(del.dataset.projectDelete))S.projectId=null;await loadWorkspace();}catch(err){toast(err.message,"error");}}
};
$("project-file-list").onclick=async e=>{const b=e.target.closest("[data-pfile-delete]");if(!b||!S.selectedProject)return;try{await api(`/api/projects/${S.selectedProject}/files/${b.dataset.pfileDelete}`,{method:"DELETE"});loadProjectFiles();}catch(err){toast(err.message,"error");}};
$("project-file-upload").onchange=async e=>{const f=e.target.files[0];e.target.value="";if(!f)return;
  try{
    if(/\.(pdf|docx|xlsx)$/i.test(f.name)){if(f.size>8*1024*1024)return toast("That file is over 8 MB.","error");const fd=new FormData();fd.append("file",f);toast("Reading your file...");const d=await api("/api/extract-text?for=project",{method:"POST",body:fd});$("project-file-name").value=d.filename;$("project-file-content").value=d.text;}
    else if(/\.(txt|md|csv|json)$/i.test(f.name)&&f.size<=200000){const t=await f.text();$("project-file-name").value=f.name;$("project-file-content").value=t.slice(0,30000);}
    else return toast("Choose a PDF, Word, Excel, .txt, .md, .csv or .json file.","error");
    toast("File loaded. Press Add project file to save it.");
  }catch(err){toast(err.message,"error");}};
$("project-file-add").onclick=async()=>{if(!S.selectedProject)return toast("Select a project first.");try{await post(`/api/projects/${S.selectedProject}/files`,{filename:$("project-file-name").value||"project-notes.txt",content:$("project-file-content").value});$("project-file-content").value="";$("project-file-name").value="";toast("Project file added.");loadProjectFiles();}catch(e){toast(e.message,"error");}};
$("project-use-chat").onclick=()=>{if(!S.selectedProject)return toast("Select a project first.");S.projectId=S.selectedProject;newChat(true);toast("New chat started inside this project.");};
$("memory-add").onclick=async()=>{try{await post("/api/memory",{memory:$("memory-input").value,category:$("memory-cat").value,expiresInDays:$("memory-exp").value||0});$("memory-input").value="";await loadWorkspace();toast("Memory saved.");}catch(e){toast(e.message,"error");}};
$("memory-list").onclick=async e=>{
  const ed=e.target.closest("[data-memory-edit]");
  if(ed){const id=ed.dataset.memoryEdit;$("generic-card").innerHTML=`<div class="modal-head"><h2>Edit memory</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><textarea class="input" id="memory-edit-text" rows="4" maxlength="1000"></textarea><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><select id="memory-edit-cat" class="select">${MEM_CATS.map(([k,l])=>`<option value="${k}">${l}</option>`).join("")}</select><select id="memory-edit-exp" class="select"><option value="">Keep expiry as is</option><option value="0">Never forget</option><option value="7">Forget in 7 days</option><option value="30">Forget in 30 days</option><option value="90">Forget in 90 days</option></select></div><button class="btn primary block" id="memory-edit-save" style="margin-top:12px">Save</button>`;$("memory-edit-text").value=ed.dataset.text||"";$("memory-edit-cat").value=ed.dataset.cat||"general";openModal("generic-modal");
    $("memory-edit-save").onclick=async()=>{try{await api("/api/memory/"+id,{method:"PATCH",body:JSON.stringify({memory:$("memory-edit-text").value,category:$("memory-edit-cat").value,...($("memory-edit-exp").value!==""?{expiresInDays:Number($("memory-edit-exp").value)}:{})})});closeModals();await loadWorkspace();toast("Memory updated.");}catch(err){toast(err.message,"error");}};return;}
  const b=e.target.closest("[data-memory-delete]");if(b){try{await api("/api/memory/"+b.dataset.memoryDelete,{method:"DELETE"});await loadWorkspace();}catch(err){toast(err.message,"error");}}};
$("skill-add").onclick=async()=>{try{const r=await post("/api/skills",{name:$("skill-name").value,command:$("skill-command").value,instruction:$("skill-instruction").value});$("skill-name").value="";$("skill-command").value="";$("skill-instruction").value="";await loadWorkspace();toast("Skill saved. Invoke /"+r.command.replace("/","")+" in chat.");}catch(e){toast(e.message,"error");}};
$("skill-list").onclick=async e=>{const b=e.target.closest("[data-skill-delete]");if(b){try{await api("/api/skills/"+b.dataset.skillDelete,{method:"DELETE"});await loadWorkspace();}catch(err){toast(err.message,"error");}}};
$("pref-save").onclick=async()=>{try{await post("/api/preferences",{country:$("pref-country").value,currency:$("pref-currency").value,language:$("pref-language").value});toast("Preferences saved.");}catch(e){toast(e.message,"error");}};
function renderResearch(data) {
  const groups=data.results||[];
  $("research-results").innerHTML=groups.map(g=>`<div class="board-row"><b>${esc(g.topic||g.title||"Search results")}</b>${(g.sources||[]).map(x=>`<p><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title||x.url)}</a><br><span class="tiny muted">${esc(x.snippet||"")}</span></p>`).join("")}</div>`).join("") || (data.answer?`<p>${esc(data.answer)}</p>`:"<p class='tiny muted'>No results.</p>");
}
$("web-search").onclick=async()=>{try{const d=await post("/api/tools/web-search",{query:$("web-query").value});renderResearch({results:[{topic:d.answer||d.query,sources:d.results}]});}catch(e){toast(e.message,"error");}};
$("agent-run").onclick=async()=>{try{const topics=$("agent-topics").value.split("\\n").map(x=>x.trim()).filter(Boolean).slice(0,3);const d=await post("/api/tools/agent-research",{topics});renderResearch(d);}catch(e){toast(e.message,"error");}};

const TOUR_STEPS = [
  ["Welcome to VYRA AI 💜", "Your AI workspace for learning, creating, researching, solving problems and building ideas."],
  ["AI Chat", "Ask questions, brainstorm, learn, write, code and explore ideas. Start with anything you want help with."],
  ["AI Toolbox", "Explore Study Tutor, Writing Studio, Coding Assistant, Data Analyst, Creative Lab, Planner and more."],
  ["Projects", "Keep related chats, files and instructions together in dedicated workspaces."],
  ["Memory & Personalization", "Manage saved preferences and memory. You control what is saved and what you choose to share."],
  ["Image Studio & Files", "Generate images and export supported content. ZIP exports package generated files when available."],
  ["Chat Settings", "Choose Fast, Balanced or Deep, adjust language and response preferences, and personalize replies."],
  ["Account, Plans & Support", "Find your account details, VYRA ID, usage, plans, settings and help. Welcome aboard!"]
];
function runTour(index=0) {
  const step=Math.max(0,Math.min(index,TOUR_STEPS.length-1)), [title,desc]=TOUR_STEPS[step];
  $("generic-card").innerHTML=`<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" id="tour-close" aria-label="Close tour">${ico("x")}</button></div><p>${esc(desc)}</p><div class="tiny muted">Step ${step+1} of ${TOUR_STEPS.length}</div><div style="display:flex;gap:8px;margin-top:16px;justify-content:space-between"><button class="btn" id="tour-skip">Skip tour</button><div style="display:flex;gap:8px"><button class="btn" id="tour-back" ${step===0?"disabled":""}>Back</button><button class="btn primary" id="tour-next">${step===TOUR_STEPS.length-1?"Finish":"Next"}</button></div></div>`;
  openModal("generic-modal");
  $("tour-close").onclick=()=>{store.set("vyra-tour","1");closeModals();};
  $("tour-skip").onclick=()=>{store.set("vyra-tour","1");closeModals();};
  $("tour-back").onclick=()=>runTour(step-1);
  $("tour-next").onclick=()=>{if(step===TOUR_STEPS.length-1){store.set("vyra-tour","1");closeModals();toast("Tour complete. Enjoy VYRA!");}else runTour(step+1);};
}
function maybeTour() { if(store.get("vyra-tour")) return; runTour(0); }


/* ---------------------------------------------------------------- start */

/* ---- Batch 1: drafts, quick chips, pinned messages, notes ---- */
const draftKey = () => "vyra-draft:" + (S.conv || "new");
$("message-input").addEventListener("input", () => {
  if (S.editFromId) return; const v = $("message-input").value;
  try { if (v.trim()) localStorage.setItem(draftKey(), v); else localStorage.removeItem(draftKey()); } catch (e) {}
});
const QUICK = [["Summarize", "Summarize this in 5 bullet points:\n\n"], ["Fix grammar", "Fix the grammar and spelling, keep my meaning:\n\n"], ["Translate", "Translate this to English:\n\n"], ["Explain code", "Explain this code step by step:\n\n"], ["Write email", "Write a polite email about: "], ["Brainstorm", "Give me 10 ideas for: "]];
$("quick-chips").innerHTML = QUICK.map(([l], i) => `<button type="button" class="chip" data-quick="${i}">${esc(l)}</button>`).join("");
$("quick-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-quick]"); if (!b) return;
  const t = $("message-input"); t.value = QUICK[+b.dataset.quick][1]; autosize(); t.focus(); t.setSelectionRange(t.value.length, t.value.length);
  try { localStorage.setItem(draftKey(), t.value); } catch (e2) {}
});
function updateChips() { const c = $("quick-chips"); if (c) c.classList.toggle("hidden", !!$("message-input").value || S.busy); }
function updatePinsBtn() { $("pins-btn").classList.toggle("hidden", !S.msgs.some((m) => m.pinned)); }
$("pins-btn").onclick = () => {
  const pins = S.msgs.map((m, i) => ({ m, i })).filter((x) => x.m.pinned);
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Pinned messages</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <div class="note-list">${pins.map((x) => `<button type="button" class="note-row" data-pin-i="${x.i}"><b>${x.m.role === "user" ? "You" : esc(document.title)}</b><span>${esc((x.m.content || "").replace(/\s+/g, " ").slice(0, 160))}</span></button>`).join("") || '<p class="muted">Nothing pinned in this chat.</p>'}</div>`;
  openModal("generic-modal");
  $("generic-card").querySelectorAll("[data-pin-i]").forEach((b) => (b.onclick = () => {
    const m = S.msgs[+b.dataset.pinI]; closeModals();
    if (m && m.el) { m.el.scrollIntoView({ block: "center", behavior: "smooth" }); m.el.classList.add("flash"); setTimeout(() => m.el.classList.remove("flash"), 1600); }
  }));
};
$("notes-btn").onclick = async () => {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Saved notes</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><div class="note-list"><p class="muted">Loading...</p></div>`;
  openModal("generic-modal");
  try {
    const d = await api("/api/notes");
    $("generic-card").querySelector(".note-list").innerHTML = d.notes.map((n) => `<div class="note-row" data-note="${n.id}"><b>${esc(n.title)}</b><span>${esc(n.content.replace(/\s+/g, " ").slice(0, 200))}</span><div class="note-acts"><button type="button" class="btn sm" data-ncopy>Copy</button><button type="button" class="btn sm" data-ndel>Delete</button></div></div>`).join("") || '<p class="muted">No notes yet. Tap the book icon under any answer to save it here.</p>';
    $("generic-card").querySelectorAll(".note-row[data-note]").forEach((row) => {
      const n = d.notes.find((x) => String(x.id) === row.dataset.note);
      row.querySelector("[data-ncopy]").onclick = async () => toast((await copyText(n.content)) ? "Copied" : "Couldn't copy");
      row.querySelector("[data-ndel]").onclick = async () => { try { await api("/api/notes/" + n.id, { method: "DELETE" }); row.remove(); toast("Deleted"); } catch (e) { toast(e.message, "error"); } };
    });
  } catch (e) { $("generic-card").querySelector(".note-list").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
};
updateChips();


/* ---- Batch 2: folders, swipe actions, tidy composer options ---- */
function nameModal(title, label, value, onSave, onDelete) {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <input class="input" id="name-input" maxlength="40" value="${esc(value)}" placeholder="Folder name" aria-label="Folder name">
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">${onDelete ? `<button class="btn" id="name-del">Delete folder</button>` : ""}<button class="btn primary" id="name-save">${esc(label)}</button></div>`;
  openModal("generic-modal"); $("name-input").focus();
  const go = async () => { try { await onSave($("name-input").value); closeModals(); } catch (e) { toast(e.message, "error"); } };
  $("name-save").onclick = go; $("name-input").onkeydown = (e) => { if (e.key === "Enter") go(); };
  if (onDelete) $("name-del").onclick = () => confirmBox("Delete this folder?", "The chats inside are kept and move back to your main list.", "Delete folder", async () => { try { await onDelete(); } catch (e) { toast(e.message, "error"); } });
}
$("new-folder").onclick = () => nameModal("New folder", "Create", "", async (name) => { await post("/api/folders", { name }); await loadHistory(); toast("Folder created"); });
function openFolderPicker(c) {
  const fs = S.folders || [];
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Move to folder</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <div class="note-list">${fs.map((f) => `<button type="button" class="note-row ${c.folderId === f.id ? "on" : ""}" data-fid="${f.id}"><b>${esc(f.name)}</b></button>`).join("")}
    ${c.folderId ? `<button type="button" class="note-row" data-fid=""><b>Remove from folder</b></button>` : ""}
    ${fs.length ? "" : '<p class="muted">No folders yet. Tap "+ Folder" above your chat list to make one.</p>'}</div>`;
  openModal("generic-modal");
  $("generic-card").querySelectorAll("[data-fid]").forEach((b) => (b.onclick = async () => {
    try { await post(`/api/conversations/${c.id}/folder`, { folderId: b.dataset.fid ? +b.dataset.fid : null }); closeModals(); await loadHistory(); toast(b.dataset.fid ? "Moved" : "Removed from folder"); } catch (e) { toast(e.message, "error"); }
  }));
}
$("history-list").addEventListener("click", (e) => {
  const t = e.target.closest("[data-fold]");
  if (t) { const id = +t.dataset.fold, set = foldedSet(); if (set.has(id)) set.delete(id); else set.add(id); store.set("vyra-folds", JSON.stringify([...set])); renderHistory(); return; }
  const m = e.target.closest("[data-fmore]");
  if (m) { const f = (S.folders || []).find((x) => x.id === +m.dataset.fmore); if (!f) return;
    nameModal("Folder", "Save", f.name, async (name) => { await post(`/api/folders/${f.id}/rename`, { name }); await loadHistory(); },
      async () => { await api("/api/folders/" + f.id, { method: "DELETE" }); await loadHistory(); toast("Folder deleted"); }); }
});

/* swipe a chat row: right = archive, left = delete (touch screens only) */
(function swipeRows() {
  const list = $("history-list"); let row = null, x0 = 0, y0 = 0, dx = 0, mode = "";
  const reset = () => { if (row) { row.style.removeProperty("--sx"); delete row.dataset.swipe; row.classList.remove("swiping"); } row = null; dx = 0; mode = ""; };
  list.addEventListener("touchstart", (e) => {
    const r = e.target.closest(".h-row[data-id]"); if (!r || e.target.closest(".menu, input") || e.touches.length !== 1) return;
    row = r; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = "";
  }, { passive: true });
  list.addEventListener("touchmove", (e) => {
    if (!row) return; const t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
    if (!mode) { if (Math.abs(my) > 12 && Math.abs(my) > Math.abs(mx)) { row = null; return; } if (Math.abs(mx) > 12) mode = "x"; else return; }
    dx = Math.max(-140, Math.min(140, mx)); row.classList.add("swiping"); row.style.setProperty("--sx", dx + "px");
    row.dataset.swipe = dx > 0 ? "archive" : "delete"; row.dataset.hint = dx > 0 ? (S.historyView === "archived" ? "Unarchive" : "Archive") : "Delete";
  }, { passive: true });
  list.addEventListener("touchend", () => {
    if (!row) return; const r = row, act = mode === "x" && Math.abs(dx) >= 90 ? (dx > 0 ? "archive" : "delete") : null;
    if (mode === "x") { r.dataset.swiped = "1"; setTimeout(() => delete r.dataset.swiped, 400); } // stop the tap that ends a swipe from opening the chat
    reset(); const c = S.chats.find((x) => x.id === r.dataset.id); if (act && c) chatAction(act, c, r);
  });
  list.addEventListener("touchcancel", reset);
  list.addEventListener("click", (e) => { const r = e.target.closest(".h-row"); if (r && r.dataset.swiped) { e.stopPropagation(); e.preventDefault(); } }, true);
})();

/* composer: options panel */
function setOpts(open) { $("opts-panel").classList.toggle("hidden", !open); $("opts-btn").setAttribute("aria-expanded", open); $("opts-btn").classList.toggle("on", open); store.set("vyra-opts", open ? "1" : "0"); }
$("opts-btn").onclick = () => setOpts($("opts-panel").classList.contains("hidden"));
function updateOptsDot() {
  const changed = $("persona-select").value !== "assistant" || $("lang-select").value !== "English" || +$("temp-slider").value !== 0.7 || (S.length && S.length !== "normal") || (S.tone && S.tone !== "friendly") || S.eli5 || S.memoryOn === false || !!S.styleId;
  $("opts-dot").classList.toggle("hidden", !changed);
}
document.addEventListener("click", () => setTimeout(updateOptsDot, 0));
["persona-select", "lang-select", "temp-slider"].forEach((id) => $(id).addEventListener("input", updateOptsDot));
setOpts(store.get("vyra-opts") === "1"); updateOptsDot();


/* ---- Batch 3: memory categories/expiry, "What Vyra knows", per-chat memory switch, reply styles ---- */
S.memoryOn = true; S.styles = []; S.styleId = store.get("vyra-style") || "";
const MEM_CATS = [["general", "General"], ["personal", "Personal"], ["work", "Work"], ["preferences", "Preferences"], ["goals", "Goals"]];
const daysLeft = (iso) => Math.max(1, Math.ceil((new Date(iso) - Date.now()) / 86400000));
function renderMemories(list) {
  if (!list.length) return `<p class="tiny muted">No saved memories.</p>`;
  return MEM_CATS.map(([k, label]) => {
    const items = list.filter((x) => (x.category || "general") === k); if (!items.length) return "";
    return `<div class="history-group">${label} (${items.length})</div>` + items.map((x) => `<div class="board-row">${esc(x.memory)}${x.expiresAt ? ` <span class="tiny muted">(forgets in ${daysLeft(x.expiresAt)}d)</span>` : ""} <button class="btn sm" data-memory-edit="${x.id}" data-text="${esc(x.memory)}" data-cat="${esc(x.category || "general")}">Edit</button><button class="btn sm danger" data-memory-delete="${x.id}">Delete</button></div>`).join("");
  }).join("");
}
$("mem-switch").onchange = async (e) => {
  S.memoryOn = e.target.checked; updateOptsDot();
  if (S.conv) { try { await post(`/api/conversations/${S.conv}/memory`, { enabled: S.memoryOn }); } catch (err) { toast(err.message, "error"); } }
  toast(S.memoryOn ? "Memory is on for this chat" : "Memory is off for this chat");
};
async function loadStyles() {
  const d = await api("/api/styles"); S.styles = d.styles || [];
  if (S.styleId && !S.styles.some((x) => String(x.id) === String(S.styleId))) { S.styleId = ""; store.set("vyra-style", ""); }
  $("style-select").innerHTML = `<option value="">Default</option>` + S.styles.map((x) => `<option value="${x.id}" ${String(x.id) === String(S.styleId) ? "selected" : ""}>${esc(x.name)}</option>`).join(""); updateOptsDot();
}
$("style-select").onchange = (e) => { S.styleId = e.target.value; store.set("vyra-style", S.styleId); updateOptsDot(); };
$("styles-btn").onclick = () => {
  const draw = () => {
    $("generic-card").innerHTML = `<div class="modal-head"><h2>Reply styles</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
      <p class="muted tiny" style="margin:0 0 8px">A style tells ${esc(document.title)} how to write, e.g. "Short bullet points, no fluff". Pick one in Options.</p>
      <div class="note-list">${S.styles.map((x) => `<div class="note-row"><b>${esc(x.name)}</b><span>${esc(x.instruction)}</span><div class="note-acts"><button type="button" class="btn sm" data-sdel="${x.id}">Delete</button></div></div>`).join("") || '<p class="muted">No styles yet.</p>'}</div>
      <input class="input" id="style-name" maxlength="40" placeholder="Style name" style="margin-top:10px"><textarea class="input" id="style-text" rows="3" maxlength="500" placeholder="How should replies be written?" style="margin-top:8px"></textarea>
      <button class="btn primary block" id="style-save" style="margin-top:10px">Save style</button>`;
    $("generic-card").querySelectorAll("[data-sdel]").forEach((b) => (b.onclick = async () => { try { await api("/api/styles/" + b.dataset.sdel, { method: "DELETE" }); await loadStyles(); draw(); } catch (e) { toast(e.message, "error"); } }));
    $("style-save").onclick = async () => { try { await post("/api/styles", { name: $("style-name").value, instruction: $("style-text").value }); await loadStyles(); draw(); toast("Style saved"); } catch (e) { toast(e.message, "error"); } };
  };
  draw(); openModal("generic-modal");
};
$("knows-btn").onclick = async () => {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>What ${esc(document.title)} knows about you</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><p class="muted">Loading...</p>`; openModal("generic-modal");
  try {
    const [mem, pr, prefs] = await Promise.all([api("/api/memory"), api("/api/projects"), api("/api/preferences")]);
    const u = S.user || {}, row = (k, v) => v ? `<div class="board-row"><b>${k}</b><div class="tiny muted">${esc(v)}</div></div>` : "";
    const mems = renderMemories(mem.memories || []).replace(/<button[^>]*>(Edit|Delete)<\/button>/g, "");
    const pj = (pr.projects || []).filter((p) => p.persona);
    $("generic-card").innerHTML = `<div class="modal-head"><h2>What ${esc(document.title)} knows about you</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
      <div class="note-list">${row("About you (your profile)", u.aboutMe) + row("What you call the AI", u.aiNickname) + row("Your custom persona", u.customPersona) + row("Country and language", [prefs.country, prefs.language].filter(Boolean).join(" · ")) + row("Reply styles saved", S.styles.map((x) => x.name).join(", ")) + pj.map((p) => row("Persona in project: " + p.name, p.persona)).join("")}
      <div><b>Saved memories</b>${mems}</div></div>
      <p class="muted tiny" style="margin-top:10px">Only what you chose to share or save is listed. Change or delete anything under Projects &amp; Memory. Turn memory off for one chat in Options.</p>
      <button class="btn primary block" data-close style="margin-top:10px">Close</button>`;
  } catch (e) { $("generic-card").querySelector(".muted").textContent = e.message; }
};

/* ---- Batch 4: project templates, dashboard, search, summary, export ---- */
const PROJECT_TEMPLATES = {
  business: { name: "Business plan", persona: "You are an experienced business consultant who writes clear, practical plans for small businesses.",
    instructions: "Help me write a complete business plan: executive summary, problem, solution, market and competitors, customers, marketing and sales plan, operations, team, financials (start-up costs, pricing, break-even and a 12-month forecast) and risks. Ask me for missing facts one section at a time. Use Naira (₦) unless I say otherwise. Keep every section clear and practical." },
  study: { name: "Study plan", persona: "You are a patient, encouraging study coach.",
    instructions: "Ask for my subject, exam date and the hours I can study each day, then build a week-by-week plan with daily topics, revision days, practice questions and a weekly self-test. Keep sessions realistic and adjust the plan when I tell you what I finished or struggled with." },
  content: { name: "Content calendar", persona: "You are a creative social media strategist who writes in the brand's own voice.",
    instructions: "Ask for my niche, audience and platforms, then create a 30-day content calendar with date, platform, topic, format, hook, caption and call to action. Mix educational, entertaining and selling posts. Write captions in my brand voice when I give examples." }
};
$("project-template").onchange = (e) => {
  const t = PROJECT_TEMPLATES[e.target.value]; S.tplPersona = t ? t.persona : "";
  if (t) { $("project-name").value = t.name; $("project-instructions").value = t.instructions; }
};
const projName = () => ((S.projectCache || []).find((p) => p.id === S.selectedProject) || {}).name || "project";
$("proj-dash").onclick = async () => {
  if (!S.selectedProject) return toast("Select a project first.");
  try {
    const d = await api(`/api/projects/${S.selectedProject}/dashboard`);
    $("generic-card").innerHTML = `<div class="modal-head"><h2>${esc(d.name)}</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
      <div class="kv"><div><span>Chats</span><b>${d.chats}</b></div><div><span>Messages</span><b>${d.messages}</b></div><div><span>Files</span><b>${d.files}</b></div><div><span>File text</span><b>${d.fileChars.toLocaleString()} chars</b></div><div><span>Project persona</span><b>${d.hasPersona ? "Set" : "None"}</b></div><div><span>Last activity</span><b>${d.lastActivity ? fmtDate(d.lastActivity) : "None yet"}</b></div></div>
      <p class="muted tiny" style="margin:12px 0 6px">Recent chats</p><div class="note-list">${d.recent.map((c) => `<button type="button" class="note-row" data-chat="${esc(c.id)}"><b>${esc(c.title)}</b></button>`).join("") || '<p class="muted">No chats in this project yet.</p>'}</div>`;
    openModal("generic-modal");
    $("generic-card").querySelectorAll("[data-chat]").forEach((b) => (b.onclick = () => { closeModals(); openConversation(b.dataset.chat); }));
  } catch (e) { toast(e.message, "error"); }
};
$("proj-search").onclick = () => {
  if (!S.selectedProject) return toast("Select a project first.");
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Search this project</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <div style="display:flex;gap:8px"><input class="input" id="ps-q" maxlength="80" placeholder="Search chats and files" aria-label="Search"><button class="btn primary" id="ps-go">Search</button></div><div class="note-list" id="ps-out" style="margin-top:10px"></div>`;
  openModal("generic-modal"); $("ps-q").focus();
  const go = async () => {
    const q = $("ps-q").value.trim(); if (q.length < 2) return;
    $("ps-out").innerHTML = '<p class="muted">Searching...</p>';
    try {
      const d = await api(`/api/projects/${S.selectedProject}/search?q=` + encodeURIComponent(q));
      $("ps-out").innerHTML = d.results.map((r, i) => `<button type="button" class="note-row" data-i="${i}"><b>${r.type === "file" ? "File: " : "Chat: "}${esc(r.title)}</b><span>${esc(r.snippet)}</span></button>`).join("") || '<p class="muted">Nothing found.</p>';
      $("ps-out").querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { const r = d.results[+b.dataset.i]; if (r.type === "chat") { closeModals(); openConversation(r.id); } else toast("That is in the project file: " + r.title); }));
    } catch (e) { $("ps-out").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  };
  $("ps-go").onclick = go; $("ps-q").onkeydown = (e) => { if (e.key === "Enter") go(); };
};
$("proj-sum").onclick = async () => {
  if (!S.selectedProject) return toast("Select a project first.");
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Project summary</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><p class="muted">Reading your project...</p>`; openModal("generic-modal");
  try {
    const d = await post(`/api/projects/${S.selectedProject}/summarize`);
    $("generic-card").innerHTML = `<div class="modal-head"><h2>Project summary</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><div class="note-list">${md(d.summary)}</div>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn" id="sum-copy">Copy</button><button class="btn primary" id="sum-note">Save as note</button></div>`;
    $("sum-copy").onclick = async () => toast((await copyText(d.summary)) ? "Copied" : "Couldn't copy");
    $("sum-note").onclick = async () => { try { await post("/api/notes", { title: "Summary: " + projName(), content: d.summary }); toast("Saved to Notes"); } catch (e) { toast(e.message, "error"); } };
  } catch (e) { $("generic-card").querySelector(".muted").textContent = e.message; }
};
$("proj-zip").onclick = async () => {
  if (!S.selectedProject) return toast("Select a project first.");
  try {
    toast("Preparing your ZIP...");
    const r = await fetch(`/api/projects/${S.selectedProject}/export`, { credentials: "same-origin", headers: { "X-Requested-With": "vyra" } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "Export failed"); }
    const url = URL.createObjectURL(await r.blob()), a = document.createElement("a"); a.href = url; a.download = (projName().replace(/[^\w\- ]+/g, "").trim().slice(0, 40) || "project") + "-project.zip"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast(e.message, "error"); }
};
$("project-file-tools").classList.toggle("hidden", !S.selectedProject);

/* ---- Batch 5: billing extras ---- */
function updateBillingBits(d) {
  const u = S.user, us = S.usage, p = d.promo;
  const showPromo = p && p.text && store.get("vyra-promo-x") !== p.id;
  $("promo-banner").classList.toggle("hidden", !showPromo); if (showPromo) { $("promo-text").textContent = p.text; $("promo-x").onclick = () => { store.set("vyra-promo-x", p.id); $("promo-banner").classList.add("hidden"); }; }
  const left = u.planExpiresAt ? new Date(u.planExpiresAt) - Date.now() : 0, warn = !u.isAdmin && !u.trial && u.paidPlan && u.paidPlan !== "free" && left > 0 && left <= 3 * 864e5;
  $("expiry-banner").classList.toggle("hidden", !warn); if (warn) { const n = Math.ceil(left / 864e5); $("expiry-text").textContent = `Your ${S.plans[u.paidPlan]?.name || ""} plan ends in ${n} day${n === 1 ? "" : "s"}.`; }
  clearInterval(S.trialTimer);
  const chip = $("trial-chip"), tick = () => {
    const ms = new Date(us.trialEndsAt) - Date.now(); if (!(u.trial && us.trialEndsAt) || ms <= 0) return chip.classList.add("hidden");
    const dd = Math.floor(ms / 864e5), hh = Math.floor(ms / 36e5) % 24, mm = Math.floor(ms / 6e4) % 60;
    chip.textContent = "Trial: " + (dd ? `${dd}d ${hh}h` : `${hh}h ${mm}m`) + " left"; chip.classList.remove("hidden");
  };
  tick(); if (u.trial) S.trialTimer = setInterval(tick, 60000);
}
const STATUS_LABEL = { approved: "Paid", pending: "Pending", rejected: "Rejected" };
async function loadBillingExtras() {
  try {
    const d = await api("/api/billing/history");
    $("billing-list").innerHTML = d.payments.map((p) => `<div class="board-row"><span><b>${esc(p.plan)}</b> <span class="tiny muted">${esc(p.period || "")} · ${fmtDate(p.createdAt)}</span>${p.coupon ? ` <span class="tiny muted">coupon ${esc(p.coupon)}</span>` : ""}</span><span>${money(p.amount)} <span class="status ${esc(p.status)}">${STATUS_LABEL[p.status] || esc(p.status)}</span> ${p.status === "approved" ? `<a class="btn sm" href="/receipt/${p.id}" target="_blank" rel="noopener">Receipt</a>` : ""}</span></div>`).join("")
      + d.gifts.map((g) => `<div class="board-row"><span><b>${esc(g.plan)}</b> <span class="tiny muted">gift · ${g.days} days · ${fmtDate(g.createdAt)}</span></span><span class="status approved">Gift</span></div>`).join("") || `<div class="empty tiny">No payments yet.</div>`;
  } catch (e) { $("billing-list").innerHTML = `<div class="empty tiny">${esc(e.message)}</div>`; }
  try {
    const r = await api("/api/student-request"), pending = r.status === "pending", got = r.status === "approved";
    $("stu-form").classList.toggle("hidden", pending || got);
    $("stu-status").textContent = got ? `Approved. Your coupon is ${r.code} (check Notifications). Enter it at checkout.` : pending ? "Your request is being reviewed. You'll get a notification." : "Students can ask for a discount coupon. We review each request.";
  } catch (e) {}
}
$("compare-btn").onclick = () => {
  const wrap = $("compare-wrap"); if (!wrap.classList.contains("hidden")) { wrap.classList.add("hidden"); return; }
  const ps = Object.entries(S.plans || {}).filter(([k, p]) => p && p.name && ["free", "starter", "plus", "pro", "business", "enterprise"].includes(k)), cur = S.user.trial ? "free" : (S.user.plan || "free");
  const rows = [["Monthly price", (p) => (p.price ? money(p.price) : "Free")], ["Weekly price", (p) => (p.price ? money(Math.round(p.price * BILLING_FACTORS.weekly)) : "Free")], ["Annual price", (p) => (p.price ? money(Math.round(p.price * BILLING_FACTORS.annual)) : "Free")], ["Messages a month", (p) => Number(p.monthly_messages).toLocaleString()], ["Images a day", (p) => Number(p.daily_images).toLocaleString()]];
  wrap.innerHTML = `<table class="compare"><thead><tr><th></th>${ps.map(([k, p]) => `<th class="${k === cur ? "cur" : ""}">${esc(p.name)}</th>`).join("")}</tr></thead><tbody>${rows.map(([l, f]) => `<tr><th>${l}</th>${ps.map(([k, p]) => `<td class="${k === cur ? "cur" : ""}">${f(p)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  wrap.classList.remove("hidden");
};
async function redeemGift(code) {
  try { const d = await post("/api/gift/redeem", { code }); toast(d.message); await refreshMe(); renderPlans(); loadBillingExtras(); return true; } catch (e) { toast(e.message, "error"); return false; }
}
$("gift-redeem").onclick = async () => { const c = $("gift-code").value.trim(); if (c && (await redeemGift(c))) $("gift-code").value = ""; };
$("stu-send").onclick = async () => { try { await post("/api/student-request", { school: $("stu-school").value, note: $("stu-note").value }); toast("Request sent. We'll notify you."); loadBillingExtras(); } catch (e) { toast(e.message, "error"); } };
(function giftFromLink() { // /?gift=CODE: remember it, then offer it once the user is signed in
  const g = new URLSearchParams(location.search).get("gift");
  if (g) { store.set("vyra-gift", g.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)); const q = new URLSearchParams(location.search); q.delete("gift"); history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "")); }
})();
async function offerPendingGift() {
  const c = store.get("vyra-gift"); if (!c) return; store.set("vyra-gift", "");
  confirmBox("You have a gift", "Add this gift plan to your account now?", "Redeem gift", () => redeemGift(c));
}
$("admin-page").addEventListener("click", async (e) => {
  try {
    if (e.target.closest("#promo-save")) { await post("/api/admin/promo", { text: $("promo-input").value, days: Number($("promo-days").value) }); toast("Banner published"); renderAdmin("growth"); }
    if (e.target.closest("#promo-clear")) { await post("/api/admin/promo", { text: "" }); toast("Banner removed"); renderAdmin("growth"); }
    if (e.target.closest("#gl-create")) { const d = await post("/api/admin/gift-links", { plan: $("gl-plan").value, days: Number($("gl-days").value) }); $("gl-new").innerHTML = `New link (tap to copy): <a href="#" data-gl-copy="${esc(d.url)}">${esc(d.url)}</a>`; }
    const gc = e.target.closest("[data-gl-copy]"); if (gc) { e.preventDefault(); toast((await copyText(gc.dataset.glCopy)) ? "Link copied" : "Couldn't copy"); }
    const st = e.target.closest("[data-stu]"); if (st) { await post(`/api/admin/student-requests/${st.dataset.id}/${st.dataset.stu}`, { percent: 30 }); toast(st.dataset.stu === "approve" ? "Approved. Coupon sent to the student." : "Rejected"); renderAdmin("growth"); }
  } catch (err) { toast(err.message, "error"); }
});

/* ---- Batch 6: admin two-step login, privacy dashboard ---- */
function askAdminCode() {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Two-step login</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><p class="muted">Enter the 6-digit code from your authenticator app.</p>
    <input class="input" id="a2fa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" aria-label="Authenticator code"><button class="btn primary block" id="a2fa-go" style="margin-top:10px">Verify</button>`;
  openModal("generic-modal"); $("a2fa-code").focus();
  const go = async () => { try { await post("/login/2fa", { code: $("a2fa-code").value }); closeModals(); await enterApp(); } catch (e) { toast(e.message, "error"); if (/timed out/i.test(e.message)) closeModals(); } };
  $("a2fa-go").onclick = go; $("a2fa-code").onkeydown = (e) => { if (e.key === "Enter") go(); };
}
async function load2faBlock() {
  try {
    const d = await api("/api/admin/2fa"); $("a2fa-status").textContent = d.enabled ? "On. Signing in needs a code from your authenticator app." : "Off. Turn it on so a stolen password alone can't open the admin account.";
    $("a2fa-btn").textContent = d.enabled ? "Turn off" : "Set up"; $("a2fa-btn").onclick = () => (d.enabled ? disable2fa() : setup2fa());
  } catch (e) { $("a2fa-status").textContent = e.message; }
}
async function setup2fa() {
  try {
    const d = await post("/api/admin/2fa/setup");
    $("generic-card").innerHTML = `<div class="modal-head"><h2>Set up two-step login</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
      <ol class="tiny muted" style="padding-left:18px;margin:0 0 10px"><li>Install Google Authenticator or Microsoft Authenticator.</li><li>Tap + then "Enter a setup key". Account: ${esc(document.title)}. Time based.</li><li>Paste this key, then type the 6-digit code below.</li></ol>
      <input class="input" id="a2fa-key" readonly value="${esc(d.secret)}" aria-label="Setup key"><button class="btn sm" id="a2fa-copy" style="margin-top:6px">Copy key</button>
      <input class="input" id="a2fa-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="margin-top:10px"><button class="btn primary block" id="a2fa-on" style="margin-top:10px">Turn on</button>`;
    openModal("generic-modal"); $("a2fa-copy").onclick = async () => toast((await copyText(d.secret)) ? "Key copied" : "Couldn't copy");
    $("a2fa-on").onclick = async () => { try { await post("/api/admin/2fa/enable", { code: $("a2fa-code").value }); closeModals(); toast("Two-step login is on"); } catch (e) { toast(e.message, "error"); } };
  } catch (e) { toast(e.message, "error"); }
}
function disable2fa() {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Turn off two-step login</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <input class="input" id="a2fa-pw" type="password" placeholder="Your password" autocomplete="current-password"><input class="input" id="a2fa-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="margin-top:8px"><button class="btn danger block" id="a2fa-off" style="margin-top:10px">Turn off</button>`;
  openModal("generic-modal");
  $("a2fa-off").onclick = async () => { try { await post("/api/admin/2fa/disable", { password: $("a2fa-pw").value, code: $("a2fa-code").value }); closeModals(); toast("Two-step login is off"); } catch (e) { toast(e.message, "error"); } };
}
$("privacy-btn").onclick = async () => {
  closeModals();
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Privacy dashboard</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><p class="muted">Loading...</p>`; openModal("generic-modal");
  try {
    const d = await api("/api/privacy/summary"), c = d.counts;
    $("generic-card").innerHTML = `<div class="modal-head"><h2>Privacy dashboard</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
      <p class="muted tiny" style="margin:0 0 8px">What is stored for your account:</p>
      <div class="kv">${[["Chats", c.chats], ["Messages", c.messages], ["Memories", c.memories], ["Notes", c.notes], ["Images", c.images], ["Projects", c.projects]].map(([l, n]) => `<div><span>${l}</span><b>${n.toLocaleString()}</b></div>`).join("")}</div>
      <h3 style="margin:14px 0 4px">Auto-delete old chats</h3><p class="muted tiny" style="margin:0 0 6px">Chats you have not opened or continued for this long are deleted for good. Pinned and archived chats are kept.</p>
      <div style="display:flex;gap:8px"><select class="select" id="ad-days">${[[0, "Never"], [30, "After 30 days"], [90, "After 90 days"], [180, "After 6 months"], [365, "After 1 year"]].map(([v, l]) => `<option value="${v}" ${v === d.autoDeleteDays ? "selected" : ""}>${l}</option>`).join("")}</select><button class="btn primary" id="ad-save">Save</button></div>
      <h3 style="margin:14px 0 4px">Devices that signed in</h3><div class="tiny muted">${d.devices.map((x) => `<div>${esc(x.label)} · ${fmtDate(x.lastSeen)}</div>`).join("") || "Nothing recorded yet. Devices appear from your next sign-in."}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><a class="btn sm" href="/api/user/export" download>${ico("download", "sm")}Download my data</a><button class="btn sm danger" id="del-chats">Delete all my chats</button></div>
      <p class="muted tiny" style="margin-top:10px">To delete your whole account, use Settings &gt; Your data.</p>`;
    $("ad-save").onclick = () => {
      const v = Number($("ad-days").value), save = async () => { try { await post("/api/privacy/settings", { autoDeleteDays: v }); toast(v ? "Auto-delete is on" : "Auto-delete is off"); } catch (e) { toast(e.message, "error"); } };
      if (v) confirmBox("Turn on auto-delete?", `Chats not used for ${v} days will be deleted permanently, starting soon. Pinned and archived chats are kept. This cannot be undone.`, "Turn on", save); else save();
    };
    $("del-chats").onclick = () => confirmBox("Delete ALL your chats?", "Every chat and message will be permanently deleted. Memories, notes and projects are not affected.", "Delete all chats", async () => { await post("/api/privacy/delete-chats", { confirm: true }); newChat(); await loadHistory(); toast("All chats deleted"); });
  } catch (e) { $("generic-card").querySelector(".muted").textContent = e.message; }
};
$("admin-page").addEventListener("click", async (e) => {
  const r = e.target.closest("[data-rep]"); if (!r) return;
  try { await post(`/api/admin/reports/${r.dataset.rep}/resolve`); toast("Resolved"); renderAdmin("reports"); } catch (err) { toast(err.message, "error"); }
});

/* ---- Batch 7: relaunch trial claim + admin tools ---- */
function updateRelaunch(d) {
  S.relaunchOffer = !!d.relaunchOffer; S.trialDays = d.billing && d.billing.trialDays;
  if (S.trialDays && $("trial-days")) $("trial-days").textContent = S.trialDays;
  const show = S.relaunchOffer && sessionStorage.getItem("vyra-later") !== "1";
  $("relaunch-banner").classList.toggle("hidden", !show);
  if (show) $("relaunch-text").textContent = `Welcome back! Claim your free ${S.trialDays || 7}-day trial with full access.`;
}
async function claimTrial() {
  try { const d = await post("/api/trial/claim"); toast(d.message); await refreshMe(); loadNotifs().catch(() => {}); } catch (e) { toast(e.message, "error"); }
}
$("relaunch-claim").onclick = claimTrial;
$("relaunch-later").onclick = () => { try { sessionStorage.setItem("vyra-later", "1"); } catch (e) {} $("relaunch-banner").classList.add("hidden"); };
$("notif-list").addEventListener("click", (e) => { if (e.target.closest("[data-claim-trial]")) claimTrial(); });

S.adminUserFilter = { q: "", plan: "", status: "" };
async function adminUsers() {
  const f = S.adminUserFilter, qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const d = await api("/api/admin/users" + (qs ? "?" + qs : "")), body = $("admin-body");
  const paid = ["starter", "plus", "pro", "business", "enterprise"].map((k) => `<option value="${k}">${esc(S.plans[k]?.name || k)}</option>`).join("");
  body.innerHTML = `<div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap"><input class="input" id="uf-q" placeholder="Search name, email or VYRA ID" value="${esc(f.q)}" style="flex:1;min-width:180px"><select class="select" id="uf-plan" aria-label="Plan"><option value="">All plans</option><option value="free">Free</option>${paid}</select><select class="select" id="uf-status" aria-label="Status"><option value="">Any status</option><option value="paying">Paying now</option><option value="trial">On trial</option><option value="suspended">Suspended</option><option value="unverified">Not verified</option><option value="inactive">Inactive 30+ days</option></select><button class="btn primary" id="uf-go">Search</button></div></div>
    <div class="card" style="margin-top:14px"><b>Bulk gift plans</b><p class="muted tiny" style="margin:4px 0 8px">Give a plan to many people at once. You will see a preview first. Anyone who already has a higher plan is skipped.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><select class="select" id="bg-plan">${paid}</select><input class="input" id="bg-days" type="number" min="1" max="365" value="30" style="max-width:100px" aria-label="Days"><select class="select" id="bg-aud"><option value="free">All free users</option><option value="all">Everyone</option><option value="usernames">These usernames</option></select></div>
      <textarea class="input hidden" id="bg-names" rows="2" placeholder="Usernames separated by commas or new lines" style="margin-top:8px"></textarea><input class="input" id="bg-reason" maxlength="300" placeholder="Note to include in their notification (optional)" style="margin-top:8px"><button class="btn primary" id="bg-preview" style="margin-top:8px">Preview</button></div>
    <div class="card" style="margin-top:14px"><p class="muted tiny" style="margin:0 0 6px">${d.users.length} user${d.users.length === 1 ? "" : "s"} shown (latest 200 matches)</p>${d.users.length ? d.users.map((u) => `<div class="row"><div class="grow"><b>${esc(u.username)} ${u.is_suspended ? '<span class="status rejected">Suspended</span>' : ""}${u.trial ? '<span class="status pending">Trial</span>' : ""}</b><small>${esc(u.email)} · VYRA ID ${esc(u.public_id || "Pending")} · joined ${fmtDate(u.created_at)}${u.plan_expires_at ? " · plan until " + fmtDate(u.plan_expires_at) : ""}</small></div><select data-setplan="${u.id}" aria-label="Plan for ${esc(u.username)}">${Object.entries(S.plans).map(([k, p]) => `<option value="${k}" ${k === u.plan ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select><button class="btn sm" data-admin-msg-user="${u.id}" data-admin-msg-name="${esc(u.username)}">Message</button><button class="btn sm ${u.is_suspended ? "" : "danger"}" data-suspend="${u.id}" data-on="${u.is_suspended ? 0 : 1}">${u.is_suspended ? "Restore" : "Suspend"}</button></div>`).join("") : `<div class="empty">No users match.</div>`}</div>`;
  $("uf-plan").value = f.plan; $("uf-status").value = f.status;
}
async function loadCanned() {
  try {
    const d = await api("/api/admin/canned"), sel = $("canned-sel"); S.canned = d.replies;
    sel.innerHTML = `<option value="">Canned replies...</option>` + d.replies.map((r) => `<option value="${r.id}">${esc(r.title)}</option>`).join("");
    sel.onchange = () => { const r = S.canned.find((x) => String(x.id) === sel.value); if (r) $("inbox-text").value = r.text; $("canned-del").classList.toggle("hidden", !r); };
    $("canned-del").onclick = async () => { try { await api("/api/admin/canned/" + sel.value, { method: "DELETE" }); toast("Deleted"); loadCanned(); $("canned-del").classList.add("hidden"); } catch (e) { toast(e.message, "error"); } };
    $("canned-save").onclick = async () => { const t = $("inbox-text").value.trim(); if (t.length < 2) return toast("Write the reply first."); try { await post("/api/admin/canned", { text: t }); toast("Saved as canned reply"); loadCanned(); } catch (e) { toast(e.message, "error"); } };
  } catch (e) { /* canned replies are optional */ }
}
$("admin-page").addEventListener("click", async (e) => {
  try {
    if (e.target.closest("#uf-go")) { S.adminUserFilter = { q: $("uf-q").value.trim(), plan: $("uf-plan").value, status: $("uf-status").value }; return adminUsers(); }
    if (e.target.closest("#bg-preview")) {
      const p = { plan: $("bg-plan").value, days: Number($("bg-days").value), audience: $("bg-aud").value, usernames: $("bg-names").value, reason: $("bg-reason").value };
      const r = await post("/api/admin/gift-bulk", p);
      return confirmBox(`Gift ${S.plans[p.plan].name} to ${r.count} people?`, `${r.count} will receive ${p.days} days.${r.skipped ? ` ${r.skipped} skipped (already on a higher plan).` : ""}${r.sample.length ? " Includes: " + r.sample.join(", ") + (r.count > r.sample.length ? "..." : "") : ""}`, "Send gifts", async () => { const d = await post("/api/admin/gift-bulk", { ...p, confirm: true }); toast(d.message); });
    }
    if (e.target.closest("#audit-go")) { S.auditDate = $("audit-date").value; return renderAdmin("logs"); }
    if (e.target.closest("#audit-clear")) { S.auditDate = ""; return renderAdmin("logs"); }
    if (e.target.closest("#health-refresh")) return renderAdmin("health");
    if (e.target.closest("#te-send")) { const d = await post("/api/admin/health/test-email", { to: $("te-to").value }); toast(d.message, d.success ? "" : "error"); }
  } catch (err) { toast(err.message, "error"); }
});
$("admin-page").addEventListener("change", (e) => { if (e.target.id === "bg-aud") $("bg-names").classList.toggle("hidden", e.target.value !== "usernames"); });
// ---- Batch 8: phone bottom navigation, install prompt after the 3rd visit
(function mobileExtras() {
  const mq = matchMedia("(max-width: 860px)");
  const nav = document.createElement("nav"); nav.id = "bottom-nav"; nav.setAttribute("aria-label", "Main");
  document.querySelectorAll(".nav-item[data-page]").forEach((b) => {
    if (b.dataset.page === "admin") return;
    const x = document.createElement("button"); x.type = "button"; x.className = "bn-item"; x.dataset.page = b.dataset.page; x.innerHTML = b.innerHTML;
    x.onclick = () => showPage(b.dataset.page); nav.appendChild(x);
  });
  $("app-view").appendChild(nav);
  const sync = () => { const p = S.page || "chat"; nav.querySelectorAll(".bn-item").forEach((x) => x.classList.toggle("active", x.dataset.page === p)); document.body.classList.toggle("has-bn", mq.matches); };
  document.addEventListener("click", (e) => { if (e.target.closest(".nav-item,.bn-item")) setTimeout(sync, 0); });
  setTimeout(sync, 400); setInterval(sync, 1500);
  if (mq.addEventListener) mq.addEventListener("change", sync);
  const inp = $("message-input");
  inp.addEventListener("focus", () => document.body.classList.add("kb-open")); inp.addEventListener("blur", () => document.body.classList.remove("kb-open"));

  // Install prompt: count one visit per browser session, offer after the 3rd, never nag.
  try { if (!sessionStorage.getItem("vyra-visit-counted")) { sessionStorage.setItem("vyra-visit-counted", "1"); store.set("vyra-visits", String((parseInt(store.get("vyra-visits") || "0", 10) || 0) + 1)); } } catch (e) {}
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let shown = false;
  function maybeOfferInstall() {
    if (shown || standalone() || store.get("vyra-installed")) return;
    if ((parseInt(store.get("vyra-visits") || "0", 10) || 0) < 3) return;
    const dis = parseInt(store.get("vyra-install-dismissed") || "0", 10); if (dis && Date.now() - dis < 30 * 86400000) return;
    if (!window.vyraInstall && !isIos) return;
    if ($("app-view").classList.contains("hidden")) return;
    shown = true;
    const bar = document.createElement("div"); bar.id = "install-bar"; bar.setAttribute("role", "dialog");
    bar.innerHTML = `<div class="ib-text"><b>Add Vyra to your home screen</b><span>Opens faster and feels like an app.</span></div><button class="btn small" id="ib-go">${isIos && !window.vyraInstall ? "How" : "Install"}</button><button class="icon-btn" id="ib-x" aria-label="Not now">&times;</button>`;
    document.body.appendChild(bar);
    $("ib-x").onclick = () => { store.set("vyra-install-dismissed", String(Date.now())); bar.remove(); };
    $("ib-go").onclick = async () => {
      if (window.vyraInstall) { try { window.vyraInstall.prompt(); await window.vyraInstall.userChoice; } catch (e) {} window.vyraInstall = null; bar.remove(); }
      else { toast("On iPhone: tap Share, then Add to Home Screen."); store.set("vyra-install-dismissed", String(Date.now())); bar.remove(); }
    };
  }
  document.addEventListener("vyra-installable", () => setTimeout(maybeOfferInstall, 3000));
  document.addEventListener("vyra-installed", () => { store.set("vyra-installed", "1"); const b = $("install-bar"); if (b) b.remove(); });
  setTimeout(maybeOfferInstall, 8000);
})();

// ---- Batch 9: image shapes and photo editing
(function imageStudioPlus() {
  S.imgSize = "square";
  $("size-chips").onclick = (e) => { const b = e.target.closest("[data-size]"); if (!b) return; S.imgSize = b.dataset.size; document.querySelectorAll("#size-chips .chip").forEach((c) => c.classList.toggle("on", c === b)); };
  const ED = { file: null, url: "" };
  window.setEditFile = (f) => {
    ED.file = f; if (ED.url) URL.revokeObjectURL(ED.url);
    ED.url = f ? URL.createObjectURL(f) : ""; const p = $("edit-preview"); p.src = ED.url; p.classList.toggle("hidden", !f);
  };
  function shrink(file) { // phones take big photos: shrink before uploading so it is fast and never hits the size limit
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => {
        const k = Math.min(1, 1024 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob((b) => b ? resolve(b) : reject(new Error("Could not read that picture.")), "image/jpeg", 0.9);
      };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that picture.")); };
      im.src = url;
    });
  }
  $("edit-file").onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) setEditFile(f); e.target.value = ""; };
  $("edit-go").onclick = async () => {
    const prompt = $("edit-prompt").value.trim();
    if (!ED.file) return toast("Choose a picture first.");
    if (prompt.length < 3) return toast("Say what the picture should become.");
    const btn = $("edit-go"); setBtn(btn, true, ico("edit") + "Editing...");
    try {
      const blob = await shrink(ED.file), fd = new FormData();
      fd.append("image", blob, "picture.jpg"); fd.append("prompt", prompt); fd.append("strength", $("edit-strength").value);
      const d = await api("/api/edit-image", { method: "POST", body: fd });
      const box = $("img-result"), img = $("img-result-img");
      box.classList.remove("hidden"); box.style.aspectRatio = "1"; box.querySelector(".skeleton").classList.remove("hidden"); img.style.opacity = "0";
      img.onload = () => { box.querySelector(".skeleton").classList.add("hidden"); img.style.opacity = "1"; box.style.aspectRatio = img.naturalWidth && img.naturalHeight ? img.naturalWidth + " / " + img.naturalHeight : "1"; loadGallery(); };
      img.onerror = () => { box.querySelector(".skeleton").classList.add("hidden"); toast("Could not show the edited picture. Check your gallery.", "error"); };
      img.src = d.image_url; $("img-download").href = d.image_url; refreshMe();
    } catch (e) { toast(e.message, "error"); } finally { setBtn(btn, false, ico("edit") + "Edit picture"); }
  };
  const sync = () => $("edit-card").classList.toggle("hidden", !(S.images && S.images.edit));
  document.addEventListener("click", (e) => { if (e.target.closest('[data-page="images"]')) setTimeout(sync, 300); });
  setInterval(sync, 2000);
})();

(async function boot() {
  const ref = document.body.dataset.ref || new URLSearchParams(location.search).get("ref") || "";
  if (ref) { $("reg-ref").value = ref.toUpperCase(); showForm("register"); }
  // Free hosting can be asleep: retry a few times on "waking up"/network errors instead of silently showing the sign-in form.
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await api("/api/me"); await enterApp(); return; }
    catch (e) {
      if (e.status === 401) return; // genuinely not signed in: the sign-in form is already showing
      if (attempt === 0) setNote("Waking the server up, this can take a few seconds...", "");
      if (attempt === 3) { setNote("The server is slow to respond. Refresh in a moment, or sign in below.", "error"); return; }
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
})();
