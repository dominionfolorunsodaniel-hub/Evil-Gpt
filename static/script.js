const $ = (id) => document.getElementById(id);
let currentUser = null;
let currentConversation = null;
let usage = {used:0, limit:20, remaining:20};
let plans = {};
let personas = [];
let lastAssistantMessage = "";
let lastUserQuestion = "";
let lastPersona = "assistant";
let recognition = null;

async function api(url, options={}) {
  const response = await fetch(url, {credentials:"same-origin", ...options,
    headers: {"Content-Type":"application/json", ...(options.headers||{})}});
  const data = await response.json().catch(()=>({error:"Unexpected server response."}));
  if (!response.ok) throw new Error(data.error || data.message || "Request failed.");
  return data;
}

function escapeHtml(s){
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function renderMarkdown(text){
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_,lang,code)=>{
    const l = lang ? `<span class="code-lang">${lang}</span>` : "";
    return `<div class="code-block">${l}<button class="copy-code">Copy</button><pre><code>${code}</code></pre></div>`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(^|\n)[-*] (.+)/g, '$1<li>$2</li>');
  html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
  html = html.replace(/\n{2,}/g, '</p><p>');
  return `<p>${html}</p>`;
}

function message(text, kind="") {
  const box=$("auth-message"); box.textContent=text; box.className="notice "+kind;
}
function authMode(mode) {
  $("login-form").classList.toggle("hidden",mode!=="login");
  $("register-form").classList.toggle("hidden",mode!=="register");
  $("login-tab").classList.toggle("active",mode==="login");
  $("register-tab").classList.toggle("active",mode==="register");
  message("");
}
$("login-tab").addEventListener("click",()=>authMode("login"));
$("register-tab").addEventListener("click",()=>authMode("register"));
$("login-form").addEventListener("submit", async e=>{
  e.preventDefault(); message("Signing in…");
  try { const d=await api("/login",{method:"POST",body:JSON.stringify({username:$("login-username").value,password:$("login-password").value})}); await enterApp(d.user); }
  catch(err){message(err.message,"error");}
});
$("register-form").addEventListener("submit",async e=>{
  e.preventDefault(); message("Creating account…");
  try {
    const d=await api("/register",{method:"POST",body:JSON.stringify({username:$("reg-username").value,email:$("reg-email").value,password:$("reg-password").value})});
    message(d.message+" You can sign in now.","success"); authMode("login");
  } catch(err){message(err.message,"error");}
});

async function enterApp(user) {
  currentUser=user;
  $("auth-view").classList.add("hidden"); $("app-view").classList.remove("hidden");
  $("side-username").textContent=user.username; $("avatar").textContent=user.username.slice(0,1).toUpperCase();
  $("admin-nav").classList.toggle("hidden",!user.isAdmin);
  await refreshMe(); await loadHistory(); await loadAnnouncements(); await loadPrompts(); await loadPersonas();
  newChat();
  applyTheme(localStorage.getItem("theme")||"dark");
  startKeepAlive();
}

async function refreshMe(){
  const d=await api("/api/me"); currentUser=d.user; usage=d.usage; plans=d.plans;
  $("side-plan").textContent=(plans[currentUser.plan]?.name||"Free")+" plan";
  $("top-plan").textContent=(plans[currentUser.plan]?.name||"FREE").toUpperCase();
  $("usage-label").textContent=`${usage.remaining} of ${usage.limit} messages left`;
  $("usage-number").textContent=`${usage.used} / ${usage.limit}`;
  $("usage-progress").style.width=Math.min(100,usage.used/usage.limit*100)+"%";
}

function applyTheme(mode){
  document.documentElement.dataset.theme = mode;
  const btn = $("theme-toggle");
  if (btn) btn.textContent = mode === "dark" ? "☀" : "☾";
  localStorage.setItem("theme", mode);
}
document.addEventListener("click", e=>{
  if (e.target.id === "theme-toggle"){
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  }
});

function addMessage(role, text, opts={}){
  const wrap=document.createElement("article"); wrap.className="message "+role;
  const tag=document.createElement("div"); tag.className="message-tag"; tag.textContent=role==="user"?"YOU":"EVIL GPT";
  const body=document.createElement("div"); body.className="message-body";
  if (role === "assistant") body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  wrap.append(tag, body);

  if (role === "assistant" && !opts.noActions){
    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.innerHTML = `
      <button class="msg-btn copy-btn" title="Copy">⧉</button>
      <button class="msg-btn speak-btn" title="Read aloud">🔊</button>
      <button class="msg-btn regen-btn" title="Regenerate">↻</button>
      <button class="msg-btn report-btn" title="Report">⚑</button>
      <button class="msg-btn up-btn" title="Good">👍</button>
      <button class="msg-btn down-btn" title="Bad">👎</button>
    `;
    wrap.append(actions);
    actions.querySelector(".copy-btn").onclick = ()=>{ navigator.clipboard.writeText(body.innerText); flash(actions.querySelector(".copy-btn"), "✓"); };
    actions.querySelector(".speak-btn").onclick = ()=> speak(body.innerText);
    actions.querySelector(".regen-btn").onclick = ()=> regenerate();
    actions.querySelector(".report-btn").onclick = ()=> reportMessage(body.innerText, "reported");
    actions.querySelector(".up-btn").onclick = ()=> reportMessage(body.innerText, "positive");
    actions.querySelector(".down-btn").onclick = ()=> reportMessage(body.innerText, "negative");
  }
  $("chat-messages").append(wrap);
  wrap.scrollIntoView({behavior:"smooth",block:"end"});
  return body;
}
function flash(btn, txt){ const old = btn.textContent; btn.textContent = txt; setTimeout(()=>btn.textContent = old, 900); }
function speak(text){
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text.slice(0, 2000));
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
async function reportMessage(text, reason){
  try { await api("/api/report",{method:"POST",body:JSON.stringify({message:text, reason, conversationId:currentConversation})}); alert("Thanks — logged."); }
  catch(e){ alert(e.message); }
}

function newChat(){
  currentConversation=null;
  $("chat-messages").replaceChildren();
  $("welcome").classList.remove("hidden");
  $("message-input").value="";
  showPage("chat");
}
$("new-chat").addEventListener("click",newChat);

$("chat-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const input=$("message-input"); const text=input.value.trim(); if(!text)return;
  $("welcome").classList.add("hidden"); input.value=""; addMessage("user",text);
  lastUserQuestion = text;
  const send=$("chat-form").querySelector(".send-btn"); send.disabled=true; send.textContent="…";
  const pending=document.createElement("article"); pending.className="message assistant";
  const body=document.createElement("div"); body.className="message-body"; body.textContent="Evil GPT is thinking…";
  pending.append(body); $("chat-messages").append(pending);

  try{
    const ok = await streamAnswer(text, body, pending, $("persona-select")?.value || "assistant");
    if (!ok) {
      const d=await api("/ask",{method:"POST",body:JSON.stringify({question:text,conversationId:currentConversation,persona:$("persona-select")?.value||"assistant"})});
      body.innerHTML = renderMarkdown(d.answer);
      currentConversation=d.conversationId;
      attachActions(pending, d.answer);
    }
    await refreshMe(); await loadHistory();
  }catch(err){
    pending.remove(); addMessage("assistant", "⚠ " + err.message);
  }
  finally{send.disabled=false;send.textContent="↑";}
});

async function streamAnswer(question, body, wrapper, persona){
  try {
    const res = await fetch("/ask/stream", {
      method:"POST", credentials:"same-origin",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({question, conversationId: currentConversation, persona})
    });
    if (!res.ok || !res.body) return false;
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let acc = "";
    while (true){
      const {done, value} = await reader.read(); if (done) break;
      const chunk = dec.decode(value, {stream:true});
      for (const line of chunk.split("\n")){
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[ERROR]") throw new Error("Stream failed.");
        if (payload.startsWith("[DONE:")) currentConversation = payload.slice(6, -1);
        else { acc += payload; body.innerHTML = renderMarkdown(acc); }
      }
    }
    if (!acc) return false;
    lastAssistantMessage = acc;
    attachActions(wrapper, acc);
    return true;
  } catch(e){ return false; }
}

function attachActions(wrapper, text){
  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.innerHTML = `
    <button class="msg-btn copy-btn" title="Copy">⧉</button>
    <button class="msg-btn speak-btn" title="Read aloud">🔊</button>
    <button class="msg-btn regen-btn" title="Regenerate">↻</button>
    <button class="msg-btn continue-btn" title="Continue">⋯</button>
    <button class="msg-btn report-btn" title="Report">⚑</button>
    <button class="msg-btn up-btn" title="Good">👍</button>
    <button class="msg-btn down-btn" title="Bad">👎</button>
  `;
  wrapper.append(actions);
  actions.querySelector(".copy-btn").onclick = ()=> navigator.clipboard.writeText(text);
  actions.querySelector(".speak-btn").onclick = ()=> speak(text);
  actions.querySelector(".regen-btn").onclick = ()=> regenerate();
  actions.querySelector(".continue-btn").onclick = ()=> continueAnswer();
  actions.querySelector(".report-btn").onclick = ()=> reportMessage(text, "reported");
  actions.querySelector(".up-btn").onclick = ()=> reportMessage(text, "positive");
  actions.querySelector(".down-btn").onclick = ()=> reportMessage(text, "negative");
}

function regenerate(){
  if (!lastUserQuestion) return;
  $("message-input").value = lastUserQuestion;
  $("chat-form").requestSubmit();
}

async function continueAnswer(){
  if (!currentConversation) return;
  try {
    const d = await api("/ask",{method:"POST",body:JSON.stringify({continue:true, conversationId:currentConversation, persona:$("persona-select")?.value||"assistant"})});
    addMessage("assistant", d.answer);
    await refreshMe();
  } catch(e){ alert(e.message); }
}

document.addEventListener("keydown", e=>{
  if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase() === "k"){ e.preventDefault(); newChat(); }
});

$("message-input").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("chat-form").requestSubmit();}});
document.querySelectorAll("[data-prompt]").forEach(b=>b.addEventListener("click",()=>{$("message-input").value=b.dataset.prompt;$("message-input").focus();}));

async function loadHistory(){
  const d=await api("/api/conversations"); const list=$("history-list"); list.replaceChildren();
  d.conversations.forEach(c=>{
    const wrap = document.createElement("div"); wrap.className = "history-row";
    const pin = document.createElement("button");
    pin.className = "history-pin" + (c.pinned ? " pinned" : "");
    pin.textContent = c.pinned ? "★" : "☆";
    pin.onclick = async (e)=>{ e.stopPropagation(); await api("/api/conversations/"+c.id+"/pin",{method:"POST",body:JSON.stringify({pinned: !c.pinned})}); loadHistory(); };
    const b=document.createElement("button");b.className="history-item";b.textContent=c.title;b.addEventListener("click",()=>openConversation(c.id));
    const menu = document.createElement("div"); menu.className = "history-menu";
    menu.innerHTML = `<button title="Export">⤓</button><button title="Share">⧉</button><button title="Delete">✕</button>`;
    const [exp,share,del] = menu.querySelectorAll("button");
    exp.onclick = async (e)=>{ e.stopPropagation();
      const r = await fetch("/api/conversations/"+c.id+"/export",{credentials:"same-origin"});
      const text = await r.text(); const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text],{type:"text/markdown"}));
      a.download = c.title.replace(/[^\w]+/g,"_")+".md"; a.click();
    };
    share.onclick = async (e)=>{ e.stopPropagation();
      const r = await api("/api/conversations/"+c.id+"/share",{method:"POST",body:"{}"});
      navigator.clipboard.writeText(location.origin + "/share/" + r.token);
      alert("Share link copied to clipboard.");
    };
    del.onclick = async (e)=>{ e.stopPropagation();
      if (!confirm("Delete this conversation?")) return;
      await api("/api/conversations/"+c.id+"/delete",{method:"POST",body:"{}"});
      if (currentConversation === c.id) newChat();
      loadHistory();
    };
    wrap.append(pin, b, menu); list.append(wrap);
  });
}
async function openConversation(id){
  try{const d=await api("/api/conversations/"+id);currentConversation=id;$("welcome").classList.add("hidden");$("chat-messages").replaceChildren();d.messages.forEach(m=>addMessage(m.role,m.content,{noActions:m.role!=="assistant"}));showPage("chat");}
  catch(e){addMessage("assistant",e.message);}
}

function showPage(page){
  ["chat","plans","admin","prompts"].forEach(p=>{const el=$(p+"-page"); if(el) el.classList.toggle("hidden",p!==page);});
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  $("page-heading").textContent = page==="chat"?"Your thinking partner":page==="plans"?"Plans & usage":page==="admin"?"Admin console":"Prompt library";
  if(page==="plans")renderPlans();
  if(page==="admin"&&currentUser.isAdmin){loadAdmin();loadPaymentRequests();}
  if(page==="prompts")renderPrompts();
  $("sidebar").classList.remove("open");
}
document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.page)));
$("mobile-menu").addEventListener("click",()=>$("sidebar").classList.toggle("open"));

function renderPlans(){
  const grid=$("plans-grid");grid.replaceChildren();
  Object.entries(plans).forEach(([key,p])=>{
    const card=document.createElement("article");card.className="plan-card"+(key==="pro"?" featured":"");
    const name=document.createElement("h3");name.textContent=p.name;
    const price=document.createElement("div");price.className="plan-price";price.textContent=p.price===0?"Free":`₦${p.price.toLocaleString("en-NG")} / month`;
    const limit=document.createElement("p");limit.textContent=`${p.monthly_messages.toLocaleString()} messages each month`;
    const btn=document.createElement("button");btn.className=key===currentUser.plan?"secondary":"primary";btn.textContent=key===currentUser.plan?"Current plan":key==="free"?"Included":"Request upgrade";btn.disabled=key===currentUser.plan||key==="free";
    btn.addEventListener("click",async()=>{
      try{ const d=await api("/api/upgrade",{method:"POST",body:JSON.stringify({plan:key})}); await showPaymentPanel(d.requestId,key,d.amount); }
      catch(e){ alert(e.message); }
    });
    card.append(name,price,limit,btn);grid.append(card);
  });
}

async function showPaymentPanel(requestId, planKey, amount) {
  const info = await api("/api/payment-info");
  const p = info.payment;
  const panel = document.createElement("div");
  panel.className = "payment-modal";
  panel.innerHTML = `
    <div class="payment-card">
      <h2>Complete your payment</h2>
      <p>Pay <strong>₦${amount.toLocaleString("en-NG")}</strong> for <strong>${plans[planKey].name}</strong>.</p>
      <div class="pay-details">
        <div><span>Bank</span><strong>${p.bank_name}</strong></div>
        <div><span>Account number</span><strong>${p.account_number}</strong></div>
        <div><span>Account name</span><strong>${p.account_name}</strong></div>
      </div>
      <p class="muted tiny">${p.extra_note || ""}</p>
      <label>Upload payment screenshot
        <input type="file" id="proof-file" accept="image/png,image/jpeg,image/webp">
      </label>
      <button class="primary full" id="proof-upload">Upload screenshot</button>
      <button class="secondary full" id="proof-close">Close</button>
      <p id="proof-msg" class="notice"></p>
    </div>`;
  document.body.append(panel);
  panel.querySelector("#proof-close").onclick = () => panel.remove();
  panel.querySelector("#proof-upload").onclick = async () => {
    const file = panel.querySelector("#proof-file").files[0];
    const msg = panel.querySelector("#proof-msg");
    if (!file) { msg.textContent = "Choose a screenshot first."; msg.className = "notice error"; return; }
    const fd = new FormData(); fd.append("screenshot", file);
    msg.textContent = "Uploading…"; msg.className = "notice";
    try {
      const r = await fetch("/api/payment-proof/" + requestId, { method: "POST", credentials: "same-origin", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Upload failed");
      msg.textContent = d.message; msg.className = "notice success";
      setTimeout(() => panel.remove(), 1500);
    } catch (e) { msg.textContent = e.message; msg.className = "notice error"; }
  };
}

async function loadPaymentRequests() {
  const root = $("admin-payments"); if (!root) return;
  try {
    const d = await api("/api/admin/payment-requests");
    root.replaceChildren();
    if (!d.requests.length) { root.textContent = "No payment requests yet."; return; }
    d.requests.forEach(r => {
      const row = document.createElement("div"); row.className = "admin-user";
      row.innerHTML = `
        <div><strong>${r.username}</strong>
          <small>${r.email} · ${r.plan} · ₦${r.amount_ngn.toLocaleString("en-NG")} · ${r.status}</small>
        </div>
        ${r.proof_id ? `<a href="/api/admin/payment-proof/${r.proof_id}" target="_blank" class="secondary" style="padding:8px 12px">View proof</a>` : `<span class="muted tiny">No proof</span>`}
        <button class="secondary approve-btn">Approve</button>
        <button class="secondary reject-btn">Reject</button>
      `;
      row.querySelector(".approve-btn").onclick = async () => {
        await api(`/api/admin/approve/${r.user_id}`, { method: "POST", body: JSON.stringify({ plan: r.plan }) });
        loadPaymentRequests();
      };
      row.querySelector(".reject-btn").onclick = async () => {
        await api(`/api/admin/reject/${r.id}`, { method: "POST", body: "{}" });
        loadPaymentRequests();
      };
      root.append(row);
    });
  } catch(e){ root.textContent = e.message; }
}

async function loadAdmin(){
  try{const d=await api("/api/admin/users");const root=$("admin-users");root.replaceChildren();
    if(!d.users.length){root.textContent="No registered users yet.";return;}
    d.users.forEach(u=>{const row=document.createElement("div");row.className="admin-user";
      const info=document.createElement("div");const title=document.createElement("strong");title.textContent=u.username;const detail=document.createElement("small");detail.textContent=`${u.email} · Current: ${u.plan} · Requested: ${u.requested_plan||"None"}`;info.append(title,detail);
      const select=document.createElement("select");Object.entries(plans).filter(([k])=>k!=="free").forEach(([k,p])=>{const o=document.createElement("option");o.value=k;o.textContent=p.name;select.append(o);});if(u.requested_plan)select.value=u.requested_plan;
      const btn=document.createElement("button");btn.className="secondary";btn.textContent="Approve";btn.addEventListener("click",async()=>{try{await api(`/api/admin/approve/${u.id}`,{method:"POST",body:JSON.stringify({plan:select.value})});loadAdmin();}catch(e){alert(e.message);}});
      row.append(info,select,btn);root.append(row);
    });
  }catch(e){$("admin-users").textContent=e.message;}
}
$("send-announcement").addEventListener("click",async()=>{try{const msg=$("announcement-text").value.trim();await api("/api/admin/announcement",{method:"POST",body:JSON.stringify({message:msg})});$("announcement-text").value="";alert("Announcement published.");}catch(e){alert(e.message);}});

async function loadAnnouncements(){
  try{const d=await api("/api/announcements");if(d.announcements.length){const latest=d.announcements[0];const bar=document.createElement("div");bar.className="announcement";bar.textContent="Announcement: "+latest.message;$("chat-page").prepend(bar);}}catch(e){}
}

let promptCache = null;
async function loadPrompts(){
  try { const d = await api("/api/prompts"); promptCache = d.prompts || []; }
  catch(_) { promptCache = []; }
}
function renderPrompts(){
  const root = $("prompts-grid"); if (!root) return;
  if (!promptCache || !promptCache.length){ root.textContent = "No prompts yet."; return; }
  const byCat = {};
  promptCache.forEach(p => { (byCat[p.category] = byCat[p.category] || []).push(p); });
  root.replaceChildren();
  Object.entries(byCat).forEach(([cat, items]) => {
    const col = document.createElement("div"); col.className = "prompt-col";
    const h = document.createElement("h3"); h.textContent = cat; col.append(h);
    items.forEach(p => {
      const b = document.createElement("button"); b.className = "prompt-chip"; b.textContent = p.text;
      b.onclick = () => { showPage("chat"); $("message-input").value = p.text + " "; $("message-input").focus(); };
      col.append(b);
    });
    root.append(col);
  });
}

async function loadPersonas(){
  try {
    const d = await api("/api/personas");
    personas = d.personas || [];
    const sel = $("persona-select");
    if (!sel) return;
    sel.replaceChildren();
    personas.forEach(p => {
      const o = document.createElement("option"); o.value = p.key; o.textContent = p.name; sel.append(o);
    });
    sel.value = lastPersona;
    sel.onchange = () => { lastPersona = sel.value; };
  } catch(_) {}
}

document.addEventListener("click", async e => {
  if (e.target.id === "surprise-btn"){
    try { const d = await api("/api/surprise"); $("message-input").value = d.prompt; $("message-input").focus(); }
    catch(_) {}
  }
});

document.addEventListener("click", e => {
  if (e.target.id === "mic-btn"){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR){ alert("Voice input isn't supported in this browser."); return; }
    if (!recognition){
      recognition = new SR(); recognition.lang = "en-US"; recognition.interimResults = false;
      recognition.onresult = ev => { $("message-input").value += ev.results[0][0].transcript; };
    }
    recognition.start();
  }
});

function startKeepAlive(){
  setInterval(()=> fetch("/api/health").catch(()=>{}), 5 * 60 * 1000);
}

$("logout").addEventListener("click",async()=>{try{await api("/logout",{method:"POST",body:"{}"});}finally{location.reload();}});
(async()=>{try{const d=await api("/api/me");await enterApp(d.user);}catch(e){}})();