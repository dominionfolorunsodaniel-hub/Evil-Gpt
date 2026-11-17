const $ = (id) => document.getElementById(id);
let currentUser = null, currentConversation = null, usage = {}, plans = {}, allChats = [], pendingFile = null;

async function api(url, options={}) {
  const res = await fetch(url, {credentials:"same-origin", ...options, headers: {"Content-Type":"application/json", ...(options.headers||{})}});
  const data = await res.json().catch(()=>({error:"Error"}));
  if (!res.ok) throw new Error(data.error || data.message || "Failed");
  return data;
}

function escapeHtml(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function renderMarkdown(text){
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_,lang,code)=>`<div class="code-block" style="position:relative;"><button class="copy-code-btn" onclick="navigator.clipboard.writeText(\`${code}\`)" style="position:absolute; top:5px; right:5px; font-size:10px; padding:2px 5px;">Copy</button><pre><code>${code}</code></pre></div>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n{2,}/g, '</p><p>');
  return `<p>${html}</p>`;
}

// --- AUTH ---
$("login-tab").addEventListener("click", () => { $("login-tab").classList.add("active"); $("register-tab").classList.remove("active"); $("login-form").classList.remove("hidden"); $("register-form").classList.add("hidden"); $("otp-form").classList.add("hidden"); });
$("register-tab").addEventListener("click", () => { $("register-tab").classList.add("active"); $("login-tab").classList.remove("active"); $("register-form").classList.remove("hidden"); $("login-form").classList.add("hidden"); $("otp-form").classList.add("hidden"); });

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { const d = await api("/login", {method:"POST", body:JSON.stringify({username:$("login-username").value, password:$("login-password").value})}); await enterApp(d.user); }
  catch(err) { $("auth-message").textContent = err.message; $("auth-message").className="notice error"; }
});

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const d = await api("/register", {method:"POST", body:JSON.stringify({username:$("reg-username").value, email:$("reg-email").value, password:$("reg-password").value})});
    $("auth-message").textContent = d.message; $("auth-message").className="notice success";
    $("register-form").classList.add("hidden"); $("otp-form").classList.remove("hidden");
    $("otp-form").dataset.email = $("reg-email").value;
  } catch(err) { $("auth-message").textContent = err.message; $("auth-message").className="notice error"; }
});

$("verify-otp-btn").addEventListener("click", async () => {
  const email = $("otp-form").dataset.email;
  try { await api("/api/auth/verify-otp", {method:"POST", body:JSON.stringify({email, code:$("otp-code").value})}); alert("Verified! Log in now."); location.reload(); }
  catch(err) { $("auth-message").textContent = err.message; $("auth-message").className="notice error"; }
});

async function enterApp(user) {
  currentUser = user; $("auth-view").classList.add("hidden"); $("app-view").classList.remove("hidden");
  $("side-username").textContent = user.username; $("avatar").textContent = user.username[0].toUpperCase();
  $("admin-nav").classList.toggle("hidden", !user.isAdmin);
  await refreshMe(); await loadHistory(); await loadNotifs(); await loadLeaderboard();
  newChat();
  const dp = await api("/api/daily-prompt"); $("daily-prompt-text").textContent = "💡 Today: " + dp.prompt;
}

async function refreshMe(){
  const d = await api("/api/me"); currentUser = d.user; usage = d.usage; plans = d.plans;
  $("side-plan").textContent = usage.trial ? "🎁 Trial" : (plans[currentUser.plan]?.name || "Free");
  $("top-plan").textContent = (plans[currentUser.plan]?.name || "FREE").toUpperCase();
  $("usage-label").textContent = usage.trial ? "Unlimited" : `${usage.remaining} msgs left`;
  $("usage-number").textContent = usage.trial ? "∞ / ∞" : `${usage.used} / ${usage.limit}`;
  $("usage-progress").style.width = usage.trial ? "100%" : Math.min(100,usage.used/usage.limit*100)+"%";
  $("streak-label").textContent = currentUser.streak || 0;
}

// --- CHECKIN & LEADERBOARD ---
$("checkin-btn").addEventListener("click", async () => {
  try { const d = await api("/api/checkin", {method:"POST"}); alert(`Checked in! +${d.bonus} bonus messages. Streak: ${d.streak}`); await refreshMe(); }
  catch(err) { alert(err.message); }
});
async function loadLeaderboard() {
  const d = await api("/api/leaderboard");
  $("leaderboard-list").innerHTML = d.leaders.map((l,i)=>`<div class="admin-user"><strong>#${i+1} ${l.username}</strong><small>🔥 ${l.streak_count} day streak</small></div>`).join("");
}

// --- NOTIFICATIONS ---
async function loadNotifs() {
  const d = await api("/api/notifications");
  const list = $("notif-list"); list.innerHTML = d.notifications.length ? "" : "No notifications.";
  let hasUnread = false;
  d.notifications.forEach(n => { if (!n.is_read) hasUnread = true; list.innerHTML += `<div style="padding:8px 0; border-bottom:1px solid var(--line); opacity:${n.is_read?0.6:1}">${n.message}</div>`; });
  $("notif-dot").classList.toggle("hidden", !hasUnread);
}
$("notif-btn").addEventListener("click", () => $("notif-panel").classList.toggle("hidden"));
async function markNotifsRead() { await api("/api/notifications/read",{method:"POST"}); loadNotifs(); }

// --- ATTACHMENT ---
$("attach-btn").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  pendingFile = e.target.files[0];
  $("attachment-preview").classList.toggle("hidden", !pendingFile);
  $("attachment-preview").textContent = pendingFile ? `📎 ${pendingFile.name}` : "";
});

// --- CHAT & IMAGE ---
function addMessage(role, text, attachmentUrl = null, attachmentType = null){
  const wrap = document.createElement("article"); wrap.className = "message " + role;
  let content = `<div class="message-tag">${role==="user"?"YOU":"EVIL GPT"}</div><div class="message-body">${role==="assistant"?renderMarkdown(text):text}</div>`;
  if (attachmentType === "image" && attachmentUrl) content += `<img src="${attachmentUrl}" style="max-width:100%; border-radius:10px; margin-top:10px;">`;
  wrap.innerHTML = content;
  $("chat-messages").append(wrap); wrap.scrollIntoView({behavior:"smooth"});
}
function newChat(){currentConversation=null;$("chat-messages").replaceChildren();$("welcome").classList.remove("hidden");$("message-input").value="";pendingFile=null;$("attachment-preview").classList.add("hidden");}
$("new-chat").addEventListener("click",newChat);

$("chat-form").addEventListener("submit", async e => {
  e.preventDefault();
  const mode = $("mode-select").value;
  let text = $("message-input").value.trim();
  if (!text && !pendingFile) return;
  $("welcome").classList.add("hidden"); $("message-input").value="";
  
  if (mode === "text") {
    if (pendingFile) {
      text += "\n\n[User uploaded a PDF document for context. Summarize the following text:]\n\n";
      const fd = new FormData(); fd.append("file", pendingFile);
      try {
        const res = await fetch("/api/extract-text", {method:"POST", body:fd});
        const d = await res.json();
        if (d.text) { text += d.text; } else { alert(d.error); }
      } catch(e) { alert("Failed to read PDF."); }
      pendingFile = null; $("attachment-preview").classList.add("hidden");
    }
    
    addMessage("user", text);
    const pending = document.createElement("article"); pending.className="message assistant";
    pending.innerHTML = `<div class="skeleton-loader"><div class="skeleton-line"></div></div>`; $("chat-messages").append(pending);
    try {
      const res = await fetch("/ask/stream", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({question:text, conversationId:currentConversation, persona:$("persona-select")?.value, modelType:$("model-select")?.value, temperature:$("temp-slider")?.value})});
      if (!res.ok) throw new Error("Failed");
      const reader = res.body.getReader(); const dec = new TextDecoder(); let acc="";
      pending.innerHTML = `<div class="message-tag">EVIL GPT</div><div class="message-body"></div>`;
      const body = pending.querySelector(".message-body");
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        dec.decode(value).split("\n").forEach(line => { if (line.startsWith("data: ")) { const p = line.slice(6); if (p.startsWith("[DONE:")) currentConversation = p.slice(6,-1); else { acc += p; body.innerHTML = renderMarkdown(acc); } } });
      }
      await refreshMe(); await loadHistory();
    } catch(err) { pending.remove(); addMessage("assistant","⚠ "+err.message); }
  } else if (mode === "image") {
    addMessage("user", `Generate image: ${text}`);
    const pending = document.createElement("article"); pending.className="message assistant";
    pending.innerHTML = `<div class="skeleton-loader"><div class="skeleton-line"></div></div>`; $("chat-messages").append(pending);
    try { const d = await api("/api/generate-image", {method:"POST", body:JSON.stringify({prompt:text})}); pending.remove(); addMessage("assistant", `Here is your image for "${text}"`, d.image_url, "image"); }
    catch(err) { pending.remove(); addMessage("assistant", "⚠ " + err.message); }
  }
});

// --- HISTORY & SEARCH ---
async function loadHistory(){
  const d = await api("/api/conversations"); allChats = d.conversations; renderHistory(allChats);
}
function renderHistory(chats) {
  const list = $("history-list"); list.replaceChildren();
  chats.forEach(c => { const b = document.createElement("button"); b.className="history-item"; b.textContent=c.title; b.onclick=()=>openConversation(c.id); list.append(b); });
}
$("search-chats").addEventListener("input", (e) => { const val = e.target.value.toLowerCase(); renderHistory(allChats.filter(c => c.title.toLowerCase().includes(val))); });

async function openConversation(id){
  const d=await api("/api/conversations/"+id); currentConversation=id;
  $("welcome").classList.add("hidden"); $("chat-messages").replaceChildren();
  d.messages.forEach(m=>addMessage(m.role,m.content,m.attachment_url,m.attachment_type));
}

// --- ADMIN ---
function showPage(page){
  ["chat","plans","admin"].forEach(p=>{ $(p+"-page").classList.toggle("hidden",p!==page); });
  if(page==="plans") { renderPlans(); loadLeaderboard(); } if(page==="admin") switchAdminTab('users');
  $("sidebar").classList.remove("open");
}
$("mobile-menu").addEventListener("click",()=>$("sidebar").classList.toggle("open"));

async function switchAdminTab(tab) {
  ["users","payments","otps","broadcast"].forEach(t => $("admin-"+t).classList.toggle("hidden", t!==tab));
  if(tab==="users") { const d = await api("/api/admin/users"); $("admin-users-list").innerHTML = d.users.map(u=>`<div class="admin-user"><strong>${u.username}</strong><small>${u.email}</small></div>`).join(""); }
  if(tab==="payments") { const d = await api("/api/admin/payment-requests"); $("admin-payments-list").innerHTML = d.requests.map(r=>`<div class="admin-user"><strong>${r.username}</strong><small>${r.plan}</small></div>`).join(""); }
  if(tab==="otps") { const d = await api("/api/admin/otp-requests"); $("admin-otps-list").innerHTML = d.requests.map(r=>`<div class="admin-user"><strong>${r.email}</strong><small>Code: ${r.code}</small><button class="primary" onclick="approveOTP(${r.id})">Approve</button></div>`).join(""); }
}
async function approveOTP(id) { const d = await api(`/api/admin/approve-otp/${id}`, {method:"POST"}); alert(d.message); switchAdminTab('otps'); }
async function sendBroadcast() { await api("/api/admin/broadcast", {method:"POST", body:JSON.stringify({message:$("broadcast-msg").value})}); alert("Sent!"); }

// --- PROFILE & PERSONA ---
function openProfile() { $("persona-modal").classList.remove("hidden"); }
async function savePersona() { await api("/api/user/update-persona", {method:"POST", body:JSON.stringify({persona:$("persona-text").value})}); alert("Saved!"); $("persona-modal").classList.add("hidden"); }

function renderPlans(){
  $("plans-grid").innerHTML = Object.entries(plans).map(([k,p])=>`<div class="plan-card"><h3>${p.name}</h3><p>₦${p.price}</p><small>${p.monthly_messages} msgs • ${p.daily_images} imgs/day</small><button class="primary" style="margin-top:10px;" onclick="upgrade('${k}')">Upgrade</button></div>`).join("");
}
async function upgrade(plan) {
  const d = await api("/api/upgrade",{method:"POST",body:JSON.stringify({plan})});
  const p = (await api("/api/payment-info")).payment;
  alert(`Pay ₦${d.amount} to ${p.bank_name} - ${p.account_number} (${p.account_name})`);
}

$("logout").addEventListener("click",async()=>{await api("/api/logout",{method:"POST"}).catch(()=>{}); location.reload();});
(async()=>{try{const d=await api("/api/me"); await enterApp(d.user);}catch(e){}})();