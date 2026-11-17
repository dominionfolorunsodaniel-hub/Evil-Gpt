const $ = (id) => document.getElementById(id);
let currentUser = null, currentConversation = null, usage = {used:0, limit:20, remaining:20}, plans = {}, personas = [];
let lastUserQuestion = "";

async function api(url, options={}) {
  const response = await fetch(url, {credentials:"same-origin", ...options, headers: {"Content-Type":"application/json", ...(options.headers||{})}});
  const data = await response.json().catch(()=>({error:"Unexpected error."}));
  if (!response.ok) throw new Error(data.error || data.message || "Request failed.");
  return data;
}
function escapeHtml(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function renderMarkdown(text){
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_,lang,code)=>`<div class="code-block"><pre><code>${code}</code></pre></div>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n{2,}/g, '</p><p>');
  return `<p>${html}</p>`;
}
function message(text, kind="") { const box=$("auth-message"); box.textContent=text; box.className="notice "+kind; }

function authMode(mode) {
  ["login","otp","register"].forEach(m => {
    $(m+"-form").classList.toggle("hidden", mode!==m);
    $(m+"-tab").classList.toggle("active", mode===m);
  });
  message("");
}
$("login-tab").addEventListener("click",()=>authMode("login"));
$("otp-tab").addEventListener("click",()=>authMode("otp"));
$("register-tab").addEventListener("click",()=>authMode("register"));

$("login-form").addEventListener("submit", async e=>{
  e.preventDefault();
  try { const d=await api("/login",{method:"POST",body:JSON.stringify({username:$("login-username").value,password:$("login-password").value})}); await enterApp(d.user); }
  catch(err){message(err.message,"error");}
});

$("request-otp-btn").addEventListener("click", async () => {
  try { const d=await api("/api/auth/request-otp",{method:"POST",body:JSON.stringify({email:$("otp-email").value})}); message(d.message,"success"); } 
  catch(err){ message(err.message,"error"); }
});
$("verify-otp-btn").addEventListener("click", async () => {
  try { const d=await api("/api/auth/verify-otp",{method:"POST",body:JSON.stringify({email:$("otp-email").value, code:$("otp-code").value})}); await enterApp(d.user); } 
  catch(err){ message(err.message,"error"); }
});

$("register-form").addEventListener("submit",async e=>{
  e.preventDefault(); message("Creating account…");
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const ref = urlParams.get('ref') || "";
    const d=await api("/register",{method:"POST",body:JSON.stringify({username:$("reg-username").value,email:$("reg-email").value,password:$("reg-password").value,referred_by:ref})});
    message(d.message+" You can sign in now.","success"); authMode("login");
  } catch(err){message(err.message,"error");}
});

async function enterApp(user) {
  currentUser=user; $("auth-view").classList.add("hidden"); $("app-view").classList.remove("hidden");
  $("side-username").textContent=user.username; $("avatar").textContent=user.username[0].toUpperCase();
  $("admin-nav").classList.toggle("hidden",!user.isAdmin);
  await refreshMe(); await loadHistory(); await loadPersonas(); newChat();
  
  try { const dp = await api("/api/daily-prompt"); $("daily-prompt-text").textContent = "💡 Today: " + dp.prompt; } catch(_) {}
}

async function refreshMe(){
  const d=await api("/api/me"); currentUser=d.user; usage=d.usage; plans=d.plans;
  if (usage.trial) { $("side-plan").textContent = "🎁 2-Day Infinity Trial"; } 
  else { $("side-plan").textContent = (plans[currentUser.plan]?.name||"Free")+" plan"; }
  $("top-plan").textContent=(plans[currentUser.plan]?.name||"FREE").toUpperCase();
  $("usage-label").textContent = usage.trial ? "Unlimited messages (Trial)" : `${usage.remaining} of ${usage.limit} messages left`;
  $("usage-number").textContent = usage.trial ? "∞ / ∞" : `${usage.used} / ${usage.limit}`;
  $("usage-progress").style.width = usage.trial ? "100%" : Math.min(100,usage.used/usage.limit*100)+"%";
  if($("user-stats-label")) $("user-stats-label").textContent = usage.trial ? "Enjoy your free gift!" : `You've sent ${usage.used} messages this month.`;
}

function addMessage(role, text){
  const wrap=document.createElement("article"); wrap.className="message "+role;
  wrap.innerHTML = `<div class="message-tag">${role==="user"?"YOU":"EVIL GPT"}</div><div class="message-body">${role==="assistant"?renderMarkdown(text):text}</div>`;
  $("chat-messages").append(wrap); wrap.scrollIntoView({behavior:"smooth",block:"end"});
}
function newChat(){currentConversation=null;$("chat-messages").replaceChildren();$("welcome").classList.remove("hidden");$("message-input").value="";showPage("chat");}
$("new-chat").addEventListener("click",newChat);

// LOADING SKELETON ANIMATION
$("chat-form").addEventListener("submit",async e=>{
  e.preventDefault(); const text=$("message-input").value.trim(); if(!text)return;
  $("welcome").classList.add("hidden"); $("message-input").value=""; addMessage("user",text);
  
  const pending=document.createElement("article"); pending.className="message assistant";
  pending.innerHTML = `<div class="skeleton-loader"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`;
  $("chat-messages").append(pending);

  try{
    const res = await fetch("/ask/stream", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({question:text, conversationId:currentConversation, persona:$("persona-select")?.value||"assistant", modelType:$("model-select")?.value||"deep"})
    });
    if (!res.ok) throw new Error("Failed");
    const reader = res.body.getReader(); const dec = new TextDecoder(); let acc="";
    pending.innerHTML = `<div class="message-tag">EVIL GPT</div><div class="message-body"></div>`;
    const body = pending.querySelector(".message-body");
    while (true){
      const {done, value} = await reader.read(); if (done) break;
      const chunk = dec.decode(value); for (const line of chunk.split("\n")){
        if (line.startsWith("data: ")) {
          const p = line.slice(6);
          if (p.startsWith("[DONE:")) currentConversation = p.slice(6,-1);
          else { acc += p; body.innerHTML = renderMarkdown(acc); }
        }
      }
    }
    await refreshMe(); await loadHistory();
  }catch(err){ pending.remove(); addMessage("assistant","⚠ "+err.message); }
});

$("message-input").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("chat-form").requestSubmit();}});

async function loadHistory(){
  const d=await api("/api/conversations"); const list=$("history-list"); list.replaceChildren();
  d.conversations.forEach(c=>{ const b=document.createElement("button"); b.className="history-item"; b.textContent=c.title; b.onclick=()=>openConversation(c.id); list.append(b); });
}
async function openConversation(id){
  try{const d=await api("/api/conversations/"+id);currentConversation=id;$("welcome").classList.add("hidden");$("chat-messages").replaceChildren();d.messages.forEach(m=>addMessage(m.role,m.content));showPage("chat");}catch(e){}
}

function showPage(page){
  ["chat","plans","admin"].forEach(p=>{const el=$(p+"-page"); if(el) el.classList.toggle("hidden",p!==page);});
  if(page==="plans")renderPlans(); 
  if(page==="admin"&&currentUser.isAdmin)switchAdminTab('analytics');
  $("sidebar").classList.remove("open");
}
$("mobile-menu").addEventListener("click",()=>$("sidebar").classList.toggle("open"));

// ADMIN TABS
async function switchAdminTab(tab) {
  ["analytics","users","payments","otps"].forEach(t => $(`admin-${t}`).classList.toggle("hidden", t!==tab));
  document.querySelectorAll(".admin-tabs button").forEach(b => b.classList.remove("active"));
  event.target.classList.add("active");

  if (tab === "analytics") {
    const d = await api("/api/admin/analytics");
    $("stat-users").textContent = d.users;
    $("stat-messages").textContent = d.messages;
  }
  if (tab === "users") {
    const d = await api("/api/admin/users"); const root = $("admin-users-list"); root.innerHTML = "";
    d.users.forEach(u => { root.innerHTML += `<div class="admin-user"><div><strong>${u.username}</strong><small>${u.email} · ${u.plan}</small></div></div>`; });
  }
  if (tab === "payments") {
    const d = await api("/api/admin/payment-requests"); const root = $("admin-payments-list"); root.innerHTML = "";
    if(!d.requests.length) root.innerHTML = "<p>No payments.</p>";
    d.requests.forEach(r => {
      root.innerHTML += `<div class="admin-user"><div><strong>${r.username}</strong><small>₦${r.amount_ngn}</small></div>${r.proof_id ? `<a href="/api/admin/payment-proof/${r.proof_id}" target="_blank" class="secondary" style="padding:4px 8px">Proof</a>` : ''}<button class="secondary" onclick="approvePay(${r.user_id},'${r.plan}')">Approve</button></div>`;
    });
  }
  if (tab === "otps") {
    const d = await api("/api/admin/otp-requests"); const root = $("admin-otps-list"); root.innerHTML = "";
    if(!d.requests.length) root.innerHTML = "<p>No OTPs.</p>";
    d.requests.forEach(r => {
      root.innerHTML += `<div class="admin-user"><div><strong>${r.email}</strong><small>${r.status} · Code: ${r.code}</small></div><button class="secondary" onclick="approveOTP(${r.id})">Approve & Send</button></div>`;
    });
  }
}
async function approvePay(uid, plan) { await api(`/api/admin/approve/${uid}`, {method:"POST",body:JSON.stringify({plan})}); switchAdminTab('payments'); }
async function approveOTP(id) { const d = await api(`/api/admin/approve-otp/${id}`, {method:"POST",body:"{}"}); alert(d.message); switchAdminTab('otps'); }

// PLANS & PAYMENT
function renderPlans(){
  const grid=$("plans-grid"); grid.replaceChildren();
  Object.entries(plans).forEach(([key,p])=>{
    const card=document.createElement("article"); card.className="plan-card";
    card.innerHTML = `<h3>${p.name}</h3><div class="plan-price">${p.price===0?"Free":"₦"+p.price.toLocaleString()}</div><p>${p.monthly_messages} msgs</p><button class="primary" ${key===currentUser.plan?'disabled':''}>${key===currentUser.plan?'Current':'Upgrade'}</button>`;
    card.querySelector("button").onclick=async()=>{ const d=await api("/api/upgrade",{method:"POST",body:JSON.stringify({plan:key})}); showPaymentPanel(d.requestId,key,d.amount); };
    grid.append(card);
  });
}
async function showPaymentPanel(requestId, planKey, amount) {
  const info = await api("/api/payment-info"); const p = info.payment;
  const panel = document.createElement("div"); panel.className = "payment-modal";
  panel.innerHTML = `<div class="payment-card"><h2>Pay ₦${amount.toLocaleString()}</h2><p>${p.bank_name} - ${p.account_number} - ${p.account_name}</p><input type="file" id="proof-file"><button class="primary" id="proof-upload">Upload</button><button class="secondary" onclick="this.parentElement.parentElement.remove()">Close</button></div>`;
  document.body.append(panel);
  panel.querySelector("#proof-upload").onclick = async () => {
    const fd = new FormData(); fd.append("screenshot", panel.querySelector("#proof-file").files[0]);
    await fetch("/api/payment-proof/" + requestId, {method: "POST", body: fd}); panel.remove(); alert("Sent!");
  };
}

async function loadPersonas(){
  try{ const d=await api("/api/personas"); const sel=$("persona-select"); sel.innerHTML="";
    d.personas.forEach(p=>{ const o=document.createElement("option"); o.value=p.key; o.textContent=p.name; sel.append(o); });
  }catch(_){}
}

$("logout").addEventListener("click",async()=>{try{await api("/logout",{method:"POST"});}finally{location.reload();}});
(async()=>{try{const d=await api("/api/me");await enterApp(d.user);}catch(e){}})();