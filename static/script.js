const $ = (id) => document.getElementById(id);
let currentUser = null, currentConversation = null, usage = {used:0, limit:20, remaining:20}, plans = {}, personas = [];
let lastUserQuestion = "", lastPersona = "assistant", recognition = null;

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
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n{2,}/g, '</p><p>');
  return `<p>${html}</p>`;
}

function authMode(mode) {
  $("login-form").classList.toggle("hidden",mode!=="login"); $("register-form").classList.toggle("hidden",mode!=="register");
  $("login-tab").classList.toggle("active",mode==="login"); $("register-tab").classList.toggle("active",mode==="register");
}
$("login-tab").addEventListener("click",()=>authMode("login")); $("register-tab").addEventListener("click",()=>authMode("register"));

$("login-form").addEventListener("submit", async e=>{
  e.preventDefault();
  try { const d=await api("/login",{method:"POST",body:JSON.stringify({username:$("login-username").value,password:$("login-password").value})}); await enterApp(d.user); }
  catch(err){ $("auth-message").textContent=err.message; $("auth-message").className="notice error"; }
});
$("register-form").addEventListener("submit",async e=>{
  e.preventDefault();
  try {
    const d=await api("/register",{method:"POST",body:JSON.stringify({username:$("reg-username").value,email:$("reg-email").value,password:$("reg-password").value})});
    $("auth-message").textContent=d.message; $("auth-message").className="notice success"; authMode("login");
  } catch(err){ $("auth-message").textContent=err.message; $("auth-message").className="notice error"; }
});

async function enterApp(user) {
  currentUser=user; $("auth-view").classList.add("hidden"); $("app-view").classList.remove("hidden");
  $("side-username").textContent=user.username; $("avatar").textContent=user.username[0].toUpperCase();
  $("admin-nav").classList.toggle("hidden",!user.isAdmin);
  await refreshMe(); await loadHistory(); await loadPersonas(); newChat();
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

function addMessage(role, text, opts={}){
  const wrap=document.createElement("article"); wrap.className="message "+role;
  wrap.innerHTML = `<div class="message-tag">${role==="user"?"YOU":"EVIL GPT"}</div><div class="message-body">${role==="assistant"?renderMarkdown(text):text}</div>`;
  if (role==="assistant") {
     const actions = document.createElement("div"); actions.className="message-actions";
     actions.innerHTML = `<button class="msg-btn copy-btn">⧉</button><button class="msg-btn report-btn">⚑</button>`;
     actions.querySelector(".copy-btn").onclick = ()=> navigator.clipboard.writeText(text);
     actions.querySelector(".report-btn").onclick = ()=> reportMessage(text);
     wrap.append(actions);
  }
  $("chat-messages").append(wrap); wrap.scrollIntoView({behavior:"smooth",block:"end"});
}
async function reportMessage(text) {
  try { await api("/api/report",{method:"POST",body:JSON.stringify({message:text, reason:"reported", conversationId:currentConversation})}); alert("Logged."); } catch(e){}
}
function newChat(){currentConversation=null;$("chat-messages").replaceChildren();$("welcome").classList.remove("hidden");$("message-input").value="";showPage("chat");}
$("new-chat").addEventListener("click",newChat);

$("chat-form").addEventListener("submit",async e=>{
  e.preventDefault(); const text=$("message-input").value.trim(); if(!text)return;
  $("welcome").classList.add("hidden"); $("message-input").value=""; addMessage("user",text);
  lastUserQuestion = text;
  const pending=document.createElement("article"); pending.className="message assistant";
  pending.innerHTML = `<div class="message-body">Thinking…</div>`; $("chat-messages").append(pending);

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
  d.conversations.forEach(c=>{
    const b=document.createElement("button"); b.className="history-item"; b.textContent=(c.pinned?"★ ":"")+c.title; b.onclick=()=>openConversation(c.id); list.append(b);
  });
}
async function openConversation(id){
  try{const d=await api("/api/conversations/"+id);currentConversation=id;$("welcome").classList.add("hidden");$("chat-messages").replaceChildren();d.messages.forEach(m=>addMessage(m.role,m.content));showPage("chat");}catch(e){}
}

function showPage(page){
  ["chat","plans","admin"].forEach(p=>{const el=$(p+"-page"); if(el) el.classList.toggle("hidden",p!==page);});
  if(page==="plans")renderPlans(); if(page==="admin"&&currentUser.isAdmin)loadAdmin();
  $("sidebar").classList.remove("open");
}
async function loadPersonas(){
  try{ const d=await api("/api/personas"); const sel=$("persona-select"); sel.innerHTML="";
    d.personas.forEach(p=>{ const o=document.createElement("option"); o.value=p.key; o.textContent=p.name; sel.append(o); });
  }catch(_){}
}

function renderPlans(){
  const grid=$("plans-grid"); grid.replaceChildren();
  Object.entries(plans).forEach(([key,p])=>{
    const card=document.createElement("article"); card.className="plan-card";
    card.innerHTML = `<h3>${p.name}</h3><div class="plan-price">${p.price===0?"Free":"₦"+p.price.toLocaleString()}</div><p>${p.monthly_messages} msgs</p><button class="primary" ${key===currentUser.plan?'disabled':' '}>${key===currentUser.plan?'Current':'Upgrade'}</button>`;
    card.querySelector("button").onclick=async()=>{
      const d=await api("/api/upgrade",{method:"POST",body:JSON.stringify({plan:key})}); showPaymentPanel(d.requestId,key,d.amount);
    };
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

async function loadAdmin(){
  const root=$("admin-users"); root.textContent="Loading..."; const d=await api("/api/admin/users"); root.innerHTML="";
  d.users.forEach(u=>{ root.innerHTML += `<div class="admin-user"><div><strong>${u.username}</strong><small>${u.plan}</small></div></div>`; });
}

$("logout").addEventListener("click",async()=>{try{await api("/logout",{method:"POST"});}finally{location.reload();}});
(async()=>{try{const d=await api("/api/me");await enterApp(d.user);}catch(e){}})();