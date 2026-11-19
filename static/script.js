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
  conv: null, msgs: [], busy: false, abort: null, mode: store.get("vyra-mode") || "deep",
  fileText: "", fileName: "", editFromId: null, chats: [], personas: [], lbMode: "weekly",
  pendingEmail: "", page: "chat", adminTab: "overview", imgStyle: "", historyView: "active",
  length: store.get("vyra-length") || "normal", tone: store.get("vyra-tone") || "friendly", eli5: store.get("vyra-eli5") === "1",
};

/* ---------------------------------------------------------------- helpers */
async function api(url, opts = {}) {
  const headers = { "X-Requested-With": "vyra", ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  let res;
  try { res = await fetch(url, { credentials: "same-origin", ...opts, headers }); }
  catch (e) { throw new Error("You're offline or the server is unreachable. Check your connection and try again."); }
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
  try { const d = await post("/login", { username: $("login-username").value.trim(), password: $("login-password").value }); await enterApp(); }
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
  await refreshMe();
  const tasks = [loadPersonas(), loadHistory(), loadNotifs(), loadDailyPrompt()];
  await Promise.all(tasks.map((t) => t.catch(() => {})));
  setGreeting(); newChat(); maybeTour();
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
const TOP = ["business_elite", "infinity"];
function planLabel() { const u = S.user; return u.trial ? "Free trial" : (S.plans[u.plan]?.name || "Free"); }
async function refreshMe() {
  const d = await api("/api/me"); S.user = d.user; S.usage = d.usage; S.images = d.images; S.plans = d.plans; S.paystack = d.paystack; S.badges = d.badges;
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
const TITLES = { chat: "", images: "Image Studio", plans: "Plans", admin: "Admin" };
function showPage(name) {
  S.page = name;
  ["chat", "images", "plans", "admin"].forEach((p) => $(p + "-page").classList.toggle("hidden", p !== name));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  $("page-heading").textContent = TITLES[name] || document.querySelector(".brand").textContent.trim();
  closeSidebar(); $("notif-panel").classList.add("hidden");
  if (name === "plans") { renderPlans(); loadLeaderboard(); renderReferral(); }
  if (name === "images") loadGallery();
  if (name === "admin") renderAdmin(S.adminTab);
}
document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
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
$("theme-btn").onclick = () => { const t = document.documentElement.dataset.theme === "light" ? "dark" : "light"; document.documentElement.dataset.theme = t; store.set("vyra-theme", t); applyThemeIcon(); };
applyThemeIcon();

/* ---------------------------------------------------------------- notifications */
async function loadNotifs() {
  const d = await api("/api/notifications"); const list = $("notif-list");
  list.innerHTML = d.notifications.length ? d.notifications.map((n) => `<div class="notif-item ${n.is_read ? "read" : ""}">${esc(n.message)}</div>`).join("") : `<div class="empty">Nothing new yet.</div>`;
  $("notif-dot").classList.toggle("hidden", !d.notifications.some((n) => !n.is_read));
}
$("notif-btn").onclick = () => { $("notif-panel").classList.toggle("hidden"); loadNotifs().catch(() => {}); };
$("notif-read").onclick = async () => { await post("/api/notifications/read"); loadNotifs(); };
// Refresh notifications periodically while the app is visible.
setInterval(() => { if (!document.hidden && !$("app-view").classList.contains("hidden")) loadNotifs().catch(() => {}); }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("app-view").classList.contains("hidden")) loadNotifs().catch(() => {}); });
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
  return `<div class="msg-actions">${last && m.truncated ? `<button type="button" data-act="continue" class="chip" aria-label="Continue" title="The reply got cut off">${ico("arrow-up", "sm")}Continue</button>` : ""}<button type="button" data-act="copy" aria-label="Copy" title="Copy">${ico("copy", "sm")}</button><button type="button" data-act="speak" aria-label="Read aloud" title="Read aloud">${ico("volume", "sm")}</button>${last ? `<button type="button" data-act="regen" aria-label="Regenerate" title="Regenerate">${ico("refresh", "sm")}</button>` : ""}<button type="button" data-act="up" class="${m.feedback === 1 ? "on" : ""}" aria-label="Good answer" title="Good answer">${ico("thumb-up", "sm")}</button><button type="button" data-act="down" class="${m.feedback === -1 ? "on" : ""}" aria-label="Bad answer" title="Bad answer">${ico("thumb-down", "sm")}</button></div>`;
}
function msgEl(m) {
  const el = document.createElement("article"); el.className = "msg " + m.role; m.el = el;
  const nickname = S.user && S.user.aiNickname;
  const who = m.role === "user" ? "You" : `<span class="mark"><svg class="ico"><use href="#i-v"/></svg></span>${esc(nickname || document.title)}`;
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
  $("copy-chat-btn").classList.toggle("hidden", S.msgs.length === 0);
}
function refreshActions() { S.msgs.forEach((m) => { if (m.pending || !m.el) return; const old = m.el.querySelector(".msg-actions"); if (old) old.remove(); m.el.insertAdjacentHTML("beforeend", msgActions(m)); }); }
function newChat() {
  if (S.busy && S.abort) S.abort.abort();
  S.conv = null; S.msgs = []; S.editFromId = null; clearFile(); renderMessages(); $("message-input").value = ""; autosize(); markActive(); showPage("chat"); $("message-input").focus();
}
$("new-chat").onclick = newChat;
async function openConversation(id) {
  try {
    const d = await api("/api/conversations/" + id); S.conv = id; S.editFromId = null;
    S.msgs = d.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback, createdAt: m.created_at })); renderMessages(); markActive(); showPage("chat"); toBottom();
  } catch (e) { toast(e.message, "error"); }
}
function autosize() { const t = $("message-input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; }
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
  if (act === "speak") speak(m.content);
  if (act === "edit") { if (!m.id) return toast("Give it a second, this message is still saving."); S.editFromId = m.id; $("message-input").value = m.content; autosize(); $("message-input").focus(); toast("Editing. Send to replace this message and everything after it."); }
  if (act === "regen") { const u = S.msgs[idx - 1]; if (!u || !u.id) return toast("Give it a second, then try again."); send(u.content, { truncateFromId: u.id }); }
  if (act === "continue") send("Continue exactly where you left off. Don't repeat what you already said.");
  if (act === "up" || act === "down") {
    if (!m.id) return; const v = act === "up" ? 1 : -1; const next = m.feedback === v ? 0 : v;
    try { await post(`/api/messages/${m.id}/feedback`, { value: next }); m.feedback = next || null; refreshActions(); if (next) toast("Thanks for the feedback"); } catch (err) { toast(err.message, "error"); }
  }
});

function setBusy(b) {
  S.busy = b; const sb = $("send-btn"); sb.classList.toggle("stop", b);
  $("send-icon").innerHTML = `<use href="#i-${b ? "stop" : "arrow-up"}"/>`; sb.setAttribute("aria-label", b ? "Stop generating" : "Send");
  $("usage-ring").classList.toggle("hidden", b);
}
async function send(text, opts = {}) {
  if (S.busy) return;
  const truncateFromId = opts.truncateFromId || S.editFromId || null; S.editFromId = null;
  if (truncateFromId) { const i = S.msgs.findIndex((m) => m.id === truncateFromId); if (i >= 0) S.msgs = S.msgs.slice(0, i); }
  const userMsg = { role: "user", content: text }; const ai = { role: "assistant", content: "", pending: true };
  S.msgs.push(userMsg, ai); renderMessages(); toBottom();
  $("message-input").value = ""; autosize(); setBusy(true);
  const ctrl = new AbortController(); S.abort = ctrl; let idle = setTimeout(() => ctrl.abort("timeout"), 60000);
  const fileText = S.fileText; clearFile();
  let started = false, failed = null, raf = 0; const body = ai.el.querySelector(".msg-body");
  const paint = () => { raf = 0; const stick = nearBottom(); body.innerHTML = md(ai.content); if (stick) toBottom(); };
  try {
    const res = await fetch("/ask/stream", { method: "POST", credentials: "same-origin", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Requested-With": "vyra" },
      body: JSON.stringify({ question: text, conversationId: S.conv, persona: $("persona-select").value, language: $("lang-select").value, modelType: S.mode, temperature: $("temp-slider").value, truncateFromId, fileText, length: S.length, tone: S.tone, eli5: S.eli5 }) });
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
    if (ctrl.signal.aborted) { if (ctrl.signal.reason === "timeout") failed = "The AI took too long to answer."; else if (!started) { S.msgs = S.msgs.slice(0, -2); } }
    else { failed = e.message; if (e.data && e.data.limitReached) { toast(e.message); refreshMe(); } }
  }
  clearTimeout(idle); cancelAnimationFrame(raf); delete ai.pending; setBusy(false); S.abort = null;
  if (failed && !started) {
    S.msgs = S.msgs.slice(0, -1); renderMessages();
    const last = S.msgs[S.msgs.length - 1]; if (last) last.el.insertAdjacentHTML("beforeend", `<div class="msg-error">${ico("x", "sm")}<span>${esc(failed)}</span><button type="button" class="btn sm" data-retry>Try again</button></div>`);
    S.lastFailed = text; S.msgs = S.msgs.slice(0, -1); // the failed question isn't saved on the server, so retry re-sends it
    if (last) last.el.dataset.failed = "1";
  } else { if (failed) toast(failed, "error"); renderMessages(); if (!ai.id && S.conv) await syncIds(); }
  await Promise.all([refreshMe().catch(() => {}), loadHistory().catch(() => {})]); showFollowups(); toBottom();
}
$("chat-messages").addEventListener("click", (e) => { if (e.target.closest("[data-retry]")) { const t = S.lastFailed; S.msgs = S.msgs.filter((m) => !(m.el && m.el.dataset.failed)); renderMessages(); if (t) send(t); } });
async function syncIds() { // after Stop: learn the saved ids so edit/regenerate/feedback work
  try { const d = await api("/api/conversations/" + S.conv); S.msgs = d.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback })); renderMessages(); } catch (e) {}
}

/* PDF attach */
$("attach-btn").onclick = () => $("file-input").click();
$("file-input").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (f.size > 8 * 1024 * 1024) return toast("That PDF is over 8 MB.", "error");
  const fd = new FormData(); fd.append("file", f); toast("Reading your PDF...");
  try { const d = await api("/api/extract-text", { method: "POST", body: fd }); S.fileText = d.text; S.fileName = d.filename;
    $("file-chip").innerHTML = `${ico("paperclip", "sm")}<span>${esc(d.filename)}${d.truncated ? " (first part)" : ""}</span><button type="button" aria-label="Remove file" id="file-x">${ico("x", "sm")}</button>`; $("file-chip").classList.remove("hidden"); $("file-x").onclick = clearFile;
    if (!$("message-input").value) $("message-input").value = "Summarise this document for me."; autosize();
  } catch (err) { toast(err.message, "error"); }
};
function clearFile() { S.fileText = ""; S.fileName = ""; $("file-chip").classList.add("hidden"); $("file-chip").innerHTML = ""; }

/* ---------------------------------------------------------------- history sidebar */
let searchTimer = 0;
async function loadHistory() { const d = await api("/api/conversations" + (S.historyView === "archived" ? "?archived=1" : "")); S.chats = d.conversations; renderHistory(); }
function markActive() { document.querySelectorAll(".h-row").forEach((r) => r.classList.toggle("active", r.dataset.id === S.conv)); }
function tagChips(c) { return c.tags ? c.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => `<span class="h-tag">${esc(t)}</span>`).join("") : ""; }
function renderHistory(results = null) {
  const box = $("history-list");
  if (results) { box.innerHTML = results.length ? results.map((r) => `<div class="h-row" data-id="${esc(r.id)}"><button class="h-title" data-open="${esc(r.id)}" title="${esc(r.snippet || r.title)}">${esc(r.title)}</button></div>`).join("") : `<div class="empty">No chats match that.</div>`; markActive(); return; }
  if (!S.chats.length) { box.innerHTML = `<div class="empty tiny">${S.historyView === "archived" ? "No archived chats yet." : "Your chats will show up here."}</div>`; return; }
  const row = (c) => `<div class="h-row" data-id="${esc(c.id)}"><button class="h-title" data-open="${esc(c.id)}">${c.shared ? ico("link", "sm") : ""}${esc(c.title)}${tagChips(c)}</button><button class="h-more" data-more="${esc(c.id)}" aria-label="Chat options">${ico("more", "sm")}</button></div>`;
  const pinned = S.chats.filter((c) => c.pinned), rest = S.chats.filter((c) => !c.pinned);
  box.innerHTML = (pinned.length ? `<div class="history-group">Pinned</div>` + pinned.map(row).join("") : "") + (rest.length ? `<div class="history-group">${pinned.length ? "Recent" : "Chats"}</div>` + rest.map(row).join("") : ""); markActive();
}
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
  row.insertAdjacentHTML("beforeend", `<div class="menu" role="menu"><button data-m="rename">${ico("edit", "sm")}Rename</button><button data-m="pin">${ico("pin", "sm")}${c.pinned ? "Unpin" : "Pin"}</button><button data-m="tags">${ico("tag", "sm")}Tags</button><button data-m="archive">${ico("archive", "sm")}${c.archived ? "Unarchive" : "Archive"}</button><button data-m="share">${ico("share", "sm")}${c.shared ? "Stop sharing" : "Share link"}</button><button data-m="export">${ico("download", "sm")}Export</button><button data-m="delete" class="danger">${ico("trash", "sm")}Delete</button></div>`);
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
    const d = await post("/api/generate-image", { prompt }); const box = $("img-result"), img = $("img-result-img");
    box.classList.remove("hidden"); box.querySelector(".skeleton").classList.remove("hidden"); img.style.opacity = "0";
    img.onload = () => { box.querySelector(".skeleton").classList.add("hidden"); img.style.opacity = "1"; loadGallery(); };
    img.onerror = () => { box.querySelector(".skeleton").classList.add("hidden"); toast("The image service is busy. Try again in a moment.", "error"); };
    img.src = d.image_url; $("img-download").href = d.image_url; refreshMe();
  } catch (e) { toast(e.message, "error"); } finally { setBtn(btn, false, ico("zap") + "Generate image"); }
};
async function loadGallery() {
  try { const d = await api("/api/images"); $("gallery").innerHTML = d.images.length ? d.images.map((i) => `<div class="g-item"><img loading="lazy" src="${esc(i.display_url)}" alt="${esc(i.prompt)}"><div class="g-actions"><a href="${esc(i.display_url)}" download target="_blank" rel="noopener" aria-label="Download">${ico("download", "sm")}</a><button type="button" data-del-img="${i.id}" aria-label="Delete">${ico("trash", "sm")}</button></div></div>`).join("") : `<div class="empty" style="grid-column:1/-1">Images you make will be saved here.</div>`; } catch (e) {}
}
$("gallery").onclick = async (e) => { const b = e.target.closest("[data-del-img]"); if (!b) return; try { await post(`/api/images/${b.dataset.delImg}/delete`); loadGallery(); } catch (err) { toast(err.message, "error"); } };

/* ---------------------------------------------------------------- Plans, checkout, referral, leaderboard */
function renderPlans() {
  const grid = $("plans-grid");
  const u = S.user || {};
  const plans = (S.plans && typeof S.plans === "object") ? S.plans : {};
  const entries = Object.entries(plans).filter(([k, p]) => p && typeof p === "object" && p.name);
  // Keep the Plans page usable if /api/me temporarily omits plan metadata.
  const fallbackPlans = {
    free: {name:"Free",price:0,monthly_messages:20,daily_images:5},
    starter: {name:"Starter",price:1500,monthly_messages:100,daily_images:20},
    plus: {name:"Plus",price:3500,monthly_messages:300,daily_images:50},
    pro: {name:"Pro",price:7500,monthly_messages:750,daily_images:100},
    ultra: {name:"Ultra",price:15000,monthly_messages:2000,daily_images:200},
    enterprise: {name:"Enterprise",price:35000,monthly_messages:5000,daily_images:500},
    business_elite: {name:"Business Elite",price:50000,monthly_messages:10000,daily_images:1000},
    infinity: {name:"Infinity",price:100000,monthly_messages:20000,daily_images:2500}
  };
  const catalog = Object.entries(fallbackPlans).map(([key, fallback]) => [key, { ...fallback, ...(plans[key] && typeof plans[key] === "object" ? plans[key] : {}) }]);
  // Merge server plan values with defaults so missing plan entries cannot break checkout.
  S.plans = Object.fromEntries(catalog);
  const cur = u.trial ? "free" : (u.plan || "free");
  grid.innerHTML = catalog.map(([k, p]) => {
    const messages = Number(p.monthly_messages || 0), images = Number(p.daily_images || 0), price = Number(p.price || 0);
    const feats = [`${messages.toLocaleString()} messages a month`, `${images.toLocaleString()} images a day`, "Fast and Deep modes", k === "free" ? "Chat history" : "Custom persona"];
    const isCur = k === cur;
    const btn = k === "free" ? `<button class="btn" disabled>${isCur ? "Your plan" : "Included"}</button>` : isCur ? `<button class="btn" data-plan="${esc(k)}">Renew for 30 days</button>` : `<button class="btn primary" data-plan="${esc(k)}">Choose ${esc(p.name)}</button>`;
    return `<div class="plan ${k === "pro" ? "popular" : ""} ${isCur ? "current" : ""}">${k === "pro" ? `<span class="pill brand tag">Most popular</span>` : ""}<h3>${TOP.includes(k) ? ico("crown", "sm") : ""}${esc(p.name)}</h3><div class="price">${price ? money(price) + "<small> / 30 days</small>" : "Free"}</div><ul>${feats.map((f) => `<li>${ico("check")}${esc(f)}</li>`).join("")}</ul>${btn}</div>`;
  }).join("");
}
$("plans-grid").onclick = (e) => { const b = e.target.closest("[data-plan]"); if (b) openCheckout(b.dataset.plan); };
$("reward-request-send").onclick = async () => {
  const btn = $("reward-request-send"), msg = $("reward-request-message").value.trim(), note = $("reward-request-note");
  if (msg.length < 8) return toast("Please explain your request in at least 8 characters.");
  setBtn(btn, true);
  try { const d = await post("/api/reward-request", { message: msg }); note.textContent = d.message; note.className = "notice success"; $("reward-request-message").value = ""; toast(d.message); }
  catch (err) { note.textContent = err.message; note.className = "notice error"; }
  finally { setBtn(btn, false); }
};
function openCheckout(plan) {
  const p = S.plans[plan];
  $("pay-card").innerHTML = `<div class="modal-head"><h2 id="pay-title">${esc(p.name)} plan</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <p class="muted" style="margin:0">${money(p.price)} for 30 days. ${p.monthly_messages.toLocaleString()} messages and ${p.daily_images.toLocaleString()} images a day.</p>
    ${S.paystack ? `<button class="btn primary block" id="pay-card-btn" style="margin-top:16px">${ico("card")}Pay ${money(p.price)} by card</button><p class="tiny muted center" style="margin:8px 0">Activates instantly. Secured by Paystack.</p>` : ""}
    <button class="btn block" id="pay-bank-btn" style="margin-top:${S.paystack ? 4 : 16}px">Pay by bank transfer</button><div id="bank-box"></div>`;
  openModal("pay-modal");
  if (S.paystack) $("pay-card-btn").onclick = async (e) => { const b = e.currentTarget; setBtn(b, true); try { const d = await post("/api/paystack/init", { plan }); location.href = d.url; } catch (err) { toast(err.message, "error"); setBtn(b, false); } };
  $("pay-bank-btn").onclick = async (e) => {
    const b = e.currentTarget; setBtn(b, true);
    try {
      const up = await post("/api/upgrade", { plan }); const info = (await api("/api/payment-info")).payment;
      if (!info) { $("bank-box").innerHTML = `<p class="notice error">Bank details aren't set up yet. Please contact support.</p>`; return; }
      $("bank-box").innerHTML = `<div class="kv"><div><span>Bank</span><b>${esc(info.bank_name)}</b></div><div><span>Account number</span><b>${esc(info.account_number)} <button class="btn sm" id="copy-acct" style="margin-left:6px">Copy</button></b></div><div><span>Account name</span><b>${esc(info.account_name)}</b></div><div><span>Amount</span><b>${money(up.amount)}</b></div></div>
        <p class="tiny muted" style="margin:0 0 8px">${esc(info.extra_note || "")}</p><label class="field" style="margin-top:0">Payment screenshot<input class="input" type="file" id="proof-file" accept="image/*"></label>
        <button class="btn primary block" id="proof-send" style="margin-top:12px">Send screenshot</button><p class="notice" id="proof-note"></p>`;
      $("copy-acct").onclick = async () => toast((await copyText(info.account_number)) ? "Account number copied" : "Couldn't copy");
      $("proof-send").onclick = async (ev) => {
        const f = $("proof-file").files[0]; if (!f) return toast("Choose your screenshot first."); const sb = ev.currentTarget; setBtn(sb, true); const fd = new FormData(); fd.append("screenshot", f);
        try { const d = await api("/api/payment-proof/" + up.requestId, { method: "POST", body: fd }); $("proof-note").textContent = d.message; $("proof-note").className = "notice success"; sb.classList.add("hidden"); }
        catch (err) { $("proof-note").textContent = err.message; $("proof-note").className = "notice error"; setBtn(sb, false); }
      };
    } catch (err) { toast(err.message, "error"); } finally { b.classList.add("hidden"); }
  };
}
function renderReferral() {
  const url = `${location.origin}/?login=1&ref=${S.user.referralCode}`; $("ref-url").value = url;
  $("ref-count").textContent = S.user.referrals ? `${S.user.referrals} friend${S.user.referrals === 1 ? "" : "s"} joined with your link.` : "No friends yet. Share your link to earn free days.";
}
$("copy-ref").onclick = async () => toast((await copyText($("ref-url").value)) ? "Invite link copied" : "Couldn't copy");
async function loadLeaderboard() {
  $("lb-weekly").classList.toggle("on", S.lbMode === "weekly"); $("lb-streak").classList.toggle("on", S.lbMode === "streak");
  $("leaderboard-list").innerHTML = `<div style="display:grid;gap:12px;padding:8px 0"><span class="skeleton"></span><span class="skeleton w60"></span><span class="skeleton w40"></span></div>`;
  try {
    const d = await api("/api/leaderboard?mode=" + S.lbMode); let html = "";
    if (d.mode === "weekly") { const h = Math.floor(d.resetsInSeconds / 3600), days = Math.floor(h / 24); html += (d.prize ? `<div class="prize">${ico("trophy")}<span>${esc(d.prize)}</span></div>` : "") + `<p class="tiny muted" style="margin:4px 0 0">Most messages this week. Resets in ${days ? days + "d " : ""}${h % 24}h.</p>`; }
    html += d.leaders.length ? d.leaders.map((l, i) => `<div class="board-row"><span class="rank">${i + 1}</span><span>${esc(l.username)}</span><span class="score">${d.mode === "streak" ? ico("flame", "sm") + l.score + " days" : l.score + " messages"}</span></div>`).join("") : `<div class="empty">Nobody yet. Be the first!</div>`;
    $("leaderboard-list").innerHTML = html;
  } catch (e) { $("leaderboard-list").innerHTML = `<div class="empty">Couldn't load the leaderboard.</div>`; }
}
$("lb-weekly").onclick = () => { S.lbMode = "weekly"; loadLeaderboard(); }; $("lb-streak").onclick = () => { S.lbMode = "streak"; loadLeaderboard(); };

/* ---------------------------------------------------------------- Settings */
const BADGE_ICONS = { chat: "chat", zap: "zap", flame: "flame", image: "image", share: "share", link: "link" };
$("open-settings").onclick = async () => {
  const u = S.user; $("set-username").textContent = u.username; $("set-email").textContent = u.email.endsWith(".invalid") ? "Admin account" : u.email; $("set-plan").textContent = planLabel();
  $("persona-text").value = u.customPersona || ""; $("persona-text").disabled = !u.canUsePersona; $("save-persona").disabled = !u.canUsePersona;
  $("persona-lock").textContent = u.canUsePersona ? "" : "Custom personas come with any paid plan. Upgrade to unlock.";
  $("about-me-text").value = u.aboutMe || ""; $("ai-nickname").value = u.aiNickname || "";
  $("install-btn").parentElement.classList.toggle("hidden", !window.vyraInstall && !/iphone|ipad/i.test(navigator.userAgent));
  $("delete-account").classList.toggle("hidden", u.isAdmin); openModal("settings-modal");
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
$("logout").onclick = async () => { try { await post("/logout"); } catch (e) {} location.href = "/?login=1"; };
$("delete-account").onclick = () => {
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Delete your account?</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><p class="muted">This permanently deletes your account, chats and images. Enter your password to confirm.</p><input class="input" id="del-pw" type="password" autocomplete="current-password" placeholder="Your password"><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button class="btn" data-close>Cancel</button><button class="btn danger" id="del-go">Delete my account</button></div>`;
  openModal("generic-modal"); $("del-go").onclick = async () => { try { await post("/api/user/delete", { password: $("del-pw").value }); location.href = "/"; } catch (e) { toast(e.message, "error"); } };
};

/* ---------------------------------------------------------------- Admin */
const ADMIN_TABS = [["overview", "Overview"], ["tools", "Admin tools"], ["users", "Users"], ["payments", "Payments"], ["codes", "Codes"], ["broadcast", "Broadcast"], ["rewards", "Rewards"], ["gifts", "Gifts & reward requests"], ["logs", "Logs & backup"]];
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
        ["Gifts & reward requests", "gifts", "Gift paid plans, review reward requests, and grant complimentary access."],
        ["Security, logs & backup", "logs", "Review failed sign-ins and audit events; download a user/payment backup."],
        ["Analytics overview", "overview", "View signups, usage, revenue, active users and plan distribution."]
      ];
      body.innerHTML = `<div class="admin-tool-grid">${groups.map(([title, key, desc]) => `<button class="card admin-tool" type="button" data-tool="${key}"><strong>${esc(title)}</strong><span class="muted">${esc(desc)}</span><span class="admin-tool-link">Open section ${ico("arrow-right")}</span></button>`).join("")}</div><div class="notice" style="margin-top:14px">Admin actions are available only to verified administrator accounts. Changes such as plan updates, payment approvals and broadcasts are logged where applicable.</div>`;
    }
    if (tab === "overview") {
      const d = await api("/api/admin/stats"), t = d.totals, sum = (a) => a.reduce((x, y) => x + Number(y.n), 0);
      const tile = (l, v) => `<div class="tile"><span>${l}</span><b>${v}</b></div>`;
      body.innerHTML = `<div class="tiles">${tile("Users", t.users)}${tile("Paying now", t.paying)}${tile("Active today", t.dau)}${tile("Active this week", t.wau)}${tile("Messages sent", Number(t.messages).toLocaleString())}${tile("Revenue", money(t.revenue))}${tile("Payments to review", t.pending_payments)}${tile("Codes to approve", t.pending_otps)}</div>
      <div class="charts"><div class="card chart"><h3>New signups, last 30 days</h3><div class="total">${sum(d.signups)}</div>${bars(d.signups)}</div><div class="card chart"><h3>Active users per day</h3><div class="total">${t.wau} this week</div>${bars(d.active)}</div><div class="card chart money"><h3>Revenue, last 30 days</h3><div class="total">${money(sum(d.revenue))}</div>${bars(d.revenue, true)}</div></div>
      <div class="card" style="margin-top:14px"><h3>Users by plan</h3><div class="chips" style="margin-top:10px">${d.plans.map((p) => `<span class="pill">${esc(S.plans[p.plan]?.name || p.plan)}: ${p.n}</span>`).join("") || "<span class=muted>No users yet</span>"}</div></div>`;
    }
    if (tab === "users") {
      const d = await api("/api/admin/users");
      body.innerHTML = `<div class="card">${d.users.length ? d.users.map((u) => `<div class="row"><div class="grow"><b>${esc(u.username)} ${u.is_suspended ? '<span class="status rejected">Suspended</span>' : ""}${u.trial ? '<span class="status pending">Trial</span>' : ""}</b><small>${esc(u.email)} · joined ${fmtDate(u.created_at)}${u.plan_expires_at ? " · plan until " + fmtDate(u.plan_expires_at) : ""}</small></div><select data-setplan="${u.id}" aria-label="Plan for ${esc(u.username)}">${Object.entries(S.plans).map(([k, p]) => `<option value="${k}" ${k === u.plan ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select><button class="btn sm ${u.is_suspended ? "" : "danger"}" data-suspend="${u.id}" data-on="${u.is_suspended ? 0 : 1}">${u.is_suspended ? "Restore" : "Suspend"}</button></div>`).join("") : `<div class="empty">No users yet.</div>`}</div>`;
    }
    if (tab === "payments") {
      const d = await api("/api/admin/payment-requests");
      body.innerHTML = `<div class="card">${d.requests.length ? d.requests.map((r) => `<div class="row"><div class="grow"><b>${esc(r.username)} · ${esc(S.plans[r.plan]?.name || r.plan)} · ${money(r.amount_ngn)}</b><small>${r.provider === "paystack" ? "Card" : "Bank transfer"} · ${fmtDate(r.created_at)}</small></div><span class="status ${esc(r.status)}">${esc(r.status)}</span>${r.proof_id ? `<button class="btn sm" data-proof="${r.proof_id}">View proof</button>` : ""}${r.status === "pending" ? `<button class="btn sm primary" data-pay="approve" data-id="${r.id}">Approve</button><button class="btn sm danger" data-pay="reject" data-id="${r.id}">Reject</button>` : ""}</div>`).join("") : `<div class="empty">No payments yet.</div>`}</div>`;
    }
    if (tab === "codes") {
      const d = await api("/api/admin/otp-requests");
      body.innerHTML = `<div class="card"><p class="muted tiny" style="margin:0 0 6px">These appear when email isn't set up, or when sending failed. Approve one and send the code to the person.</p>${d.requests.length ? d.requests.map((r) => `<div class="row"><div class="grow"><b>${esc(r.email)}</b><small>${r.purpose === "reset" ? "Password reset" : "Sign-up"} · code ${esc(r.code)}</small></div><span class="status ${r.status === "approved" ? "approved" : "pending"}">${esc(r.status)}</span>${r.status === "pending" ? `<button class="btn sm primary" data-otp="${r.id}">Approve</button>` : ""}</div>`).join("") : `<div class="empty">No codes waiting.</div>`}</div>`;
    }
    if (tab === "broadcast") body.innerHTML = `<div class="card"><h3>Message every user</h3><textarea class="input" id="bc-msg" rows="3" maxlength="1000" placeholder="Write a short update"></textarea><button class="btn primary" id="bc-send" style="margin-top:10px">Send to all users</button></div>`;
    if (tab === "rewards") body.innerHTML = `<div class="card"><h3>Weekly prize note</h3><p class="muted tiny" style="margin:4px 0 0">Shown above the weekly leaderboard.</p><input class="input" id="prize-text" maxlength="140" placeholder="Top 3 this week win bonus messages"><button class="btn" id="prize-save" style="margin-top:10px">Save note</button></div><div class="card" style="margin-top:14px"><h3>Award last week's winners</h3><p class="muted tiny" style="margin:4px 0 10px">Gives the top 3 chatters +100, +50 and +25 bonus messages. Works once per week.</p><button class="btn primary" id="award-go">Award last week's top 3</button></div>`;
    if (tab === "gifts") {
      const d = await api("/api/admin/reward-requests");
      const opts = Object.entries(S.plans).filter(([k]) => k !== "free").map(([k,p]) => `<option value="${esc(k)}">${esc(p.name)}</option>`).join("");
      body.innerHTML = `<div class="card"><h3>Gift a plan</h3><p class="muted tiny" style="margin:4px 0 12px">Give a customer complimentary plan access. Gifts are logged and the recipient receives a notification.</p><label class="field">Username or email<input class="input" id="gift-user" maxlength="254" placeholder="customer username or email"></label><label class="field">Plan<select class="input" id="gift-plan">${opts}</select></label><label class="field">Duration (days)<input class="input" type="number" id="gift-days" min="1" max="365" value="30"></label><label class="field">Reason (optional)<input class="input" id="gift-reason" maxlength="300" placeholder="Welcome gift, contest prize, etc."></label><button class="btn primary" id="gift-send">Send plan gift</button><p id="gift-note" class="notice hidden"></p></div><div class="card" style="margin-top:14px"><h3>Customer reward requests</h3>${d.requests.length ? d.requests.map(r => `<div class="reward-admin-row"><div class="grow"><b>${esc(r.username)} · ${esc(r.email)}</b><small>${fmtDate(r.created_at)} · ${esc(r.message)}</small><span class="status ${esc(r.status)}">${esc(r.status)}</span></div>${r.status === "pending" ? `<div class="reward-admin-controls"><select class="input" data-reward-plan="${r.id}">${opts}</select><input class="input" type="number" data-reward-days="${r.id}" min="1" max="365" value="30" aria-label="Reward duration days"><button class="btn sm primary" data-review-reward="approve" data-id="${r.id}">Approve &amp; gift</button><button class="btn sm danger" data-review-reward="reject" data-id="${r.id}">Reject</button></div>` : `<small>Reviewed${r.admin_note ? `: ${esc(r.admin_note)}` : ""}</small>`}</div>`).join("") : `<div class="empty">No reward requests yet.</div>`}</div>`;
    }
    if (tab === "logs") {
      const d = await api("/api/admin/audit");
      body.innerHTML = `<div class="card"><h3>Backup</h3><p class="muted tiny" style="margin:4px 0 10px">Downloads users and payments as a file. Keep it somewhere private.</p><a class="btn" href="/api/admin/export" download>${ico("download")}Download backup</a></div><div class="card" style="margin-top:14px"><h3>Failed sign-ins</h3>${d.failedLogins.length ? d.failedLogins.map((f) => `<div class="row"><div class="grow"><b>${esc(f.username || "(blank)")}</b><small>${esc(f.ip)} · ${new Date(f.created_at).toLocaleString("en-NG")}</small></div></div>`).join("") : `<div class="empty">None. Nice.</div>`}</div><div class="card" style="margin-top:14px"><h3>Admin actions</h3>${d.audit.length ? d.audit.map((a) => `<div class="row"><div class="grow"><b>${esc(a.action)}</b><small>${esc(a.actor || "")} · ${esc(a.detail || "")} · ${new Date(a.created_at).toLocaleString("en-NG")}</small></div></div>`).join("") : `<div class="empty">Nothing yet.</div>`}</div>`;
    }
  } catch (e) { body.innerHTML = `<div class="card"><p class="notice error">${esc(e.message)}</p></div>`; }
}
$("admin-page").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-atab]"); if (t) return renderAdmin(t.dataset.atab);
  const tool = e.target.closest("[data-tool]"); if (tool) return renderAdmin(tool.dataset.tool);
  try {
    const sp = e.target.closest("[data-suspend]"); if (sp) { await post(`/api/admin/users/${sp.dataset.suspend}/suspend`, { suspended: sp.dataset.on === "1" }); return renderAdmin("users"); }
    const pay = e.target.closest("[data-pay]"); if (pay) { await post(`/api/admin/payment-requests/${pay.dataset.id}/${pay.dataset.pay}`); toast(pay.dataset.pay === "approve" ? "Approved. The plan is active." : "Rejected"); return renderAdmin("payments"); }
    const pr = e.target.closest("[data-proof]"); if (pr) { $("generic-card").innerHTML = `<div class="modal-head"><h2>Payment proof</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div><img class="proof-img" alt="Payment screenshot" src="/api/admin/payment-proof/${pr.dataset.proof}">`; return openModal("generic-modal"); }
    const otp = e.target.closest("[data-otp]"); if (otp) { const d = await post(`/api/admin/approve-otp/${otp.dataset.otp}`); toast(d.message); return renderAdmin("codes"); }
    if (e.target.closest("#gift-send")) {
      const b = e.target.closest("#gift-send"), note = $("gift-note"); setBtn(b,true);
      try { const d = await post("/api/admin/gift-plan", { user: $("gift-user").value.trim(), plan: $("gift-plan").value, days: Number($("gift-days").value), reason: $("gift-reason").value.trim() }); note.textContent = d.message; note.className = "notice success"; toast(d.message); }
      catch (err) { note.textContent = err.message; note.className = "notice error"; }
      finally { setBtn(b,false); }
    }
    const reward = e.target.closest("[data-review-reward]");
    if (reward) { const id = reward.dataset.id, action = reward.dataset.reviewReward, plan = document.querySelector(`[data-reward-plan="${id}"]`)?.value || "pro", days = Number(document.querySelector(`[data-reward-days="${id}"]`)?.value || 30); await post(`/api/admin/reward-requests/${id}/${action}`, { plan, days }); toast(action === "approve" ? "Reward approved and plan gifted." : "Reward request rejected."); return renderAdmin("gifts"); }
    if (e.target.closest("#bc-send")) { const d = await post("/api/admin/broadcast", { message: $("bc-msg").value }); toast(`Sent to ${d.sent} users`); $("bc-msg").value = ""; }
    if (e.target.closest("#prize-save")) { await post("/api/admin/weekly-prize", { prize: $("prize-text").value }); toast("Saved"); }
    if (e.target.closest("#award-go")) { const d = await post("/api/admin/award-weekly"); toast(d.message); }
  } catch (err) { toast(err.message, "error"); }
});
$("admin-page").addEventListener("change", async (e) => {
  const s = e.target.closest("[data-setplan]"); if (!s) return;
  try { await post(`/api/admin/users/${s.dataset.setplan}/plan`, { plan: s.value }); toast("Plan updated"); renderAdmin("users"); } catch (err) { toast(err.message, "error"); }
});

/* ---------------------------------------------------------------- follow-ups, voice, read aloud, tour */
const FOLLOWUPS = ["Explain it simpler", "Give me an example", "Make it shorter"];
function showFollowups() {
  document.querySelectorAll(".followups").forEach((x) => x.remove());
  const last = S.msgs[S.msgs.length - 1];
  if (!last || last.role !== "assistant" || !last.el || last.el.querySelector(".msg-error") || !last.content) return;
  last.el.insertAdjacentHTML("beforeend", `<div class="followups">${FOLLOWUPS.map((f) => `<button type="button" class="chip" data-followup="${esc(f)}">${esc(f)}</button>`).join("")}</div>`);
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
function maybeTour() {
  if (store.get("vyra-tour")) return; store.set("vyra-tour", "1");
  $("generic-card").innerHTML = `<div class="modal-head"><h2>Welcome to Vyra AI</h2><button class="icon-btn" data-close aria-label="Close">${ico("x")}</button></div>
    <div class="kv"><div><span>Deep and Fast</span><b>Deep for hard questions</b></div><div><span>Languages</span><b>Reply in Pidgin, Yoruba, Hausa or Igbo</b></div><div><span>Mic</span><b>Tap to speak your message</b></div><div><span>Check in daily</span><b>Earn bonus messages</b></div></div>
    <button class="btn primary block" data-close>Start chatting</button>`;
  openModal("generic-modal");
}

/* ---------------------------------------------------------------- start */
(async function boot() {
  const ref = document.body.dataset.ref || new URLSearchParams(location.search).get("ref") || "";
  if (ref) { $("reg-ref").value = ref.toUpperCase(); showForm("register"); }
  try { await api("/api/me"); await enterApp(); } catch (e) { /* not signed in: the sign-in form is already showing */ }
})();
