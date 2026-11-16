const $ = (id) => document.getElementById(id);
let currentUser = null;
let currentConversation = null;
let usage = {used:0, limit:20, remaining:20};
let plans = {};

async function api(url, options={}) {
  const response = await fetch(url, {credentials:"same-origin", ...options,
    headers: {"Content-Type":"application/json", ...(options.headers||{})}});
  const data = await response.json().catch(()=>({error:"Unexpected server response."}));
  if (!response.ok) throw new Error(data.error || data.message || "Request failed.");
  return data;
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
  await refreshMe(); await loadHistory(); await loadAnnouncements();
  newChat();
}
async function refreshMe(){
  const d=await api("/api/me"); currentUser=d.user; usage=d.usage; plans=d.plans;
  $("side-plan").textContent=(plans[currentUser.plan]?.name||"Free")+" plan";
  $("top-plan").textContent=(plans[currentUser.plan]?.name||"FREE").toUpperCase();
  $("usage-label").textContent=`${usage.remaining} of ${usage.limit} messages left`;
  $("usage-number").textContent=`${usage.used} / ${usage.limit}`;
  $("usage-progress").style.width=Math.min(100,usage.used/usage.limit*100)+"%";
}
function addMessage(role,text){
  const wrap=document.createElement("article"); wrap.className="message "+role;
  const tag=document.createElement("div"); tag.className="message-tag"; tag.textContent=role==="user"?"YOU":"EVIL GPT";
  const body=document.createElement("div"); body.className="message-body"; body.textContent=text;
  wrap.append(tag,body); $("chat-messages").append(wrap); wrap.scrollIntoView({behavior:"smooth",block:"end"});
}
function newChat(){currentConversation=null;$("chat-messages").replaceChildren();$("welcome").classList.remove("hidden");$("message-input").value="";showPage("chat");}
$("new-chat").addEventListener("click",newChat);
$("chat-form").addEventListener("submit",async e=>{
  e.preventDefault(); const input=$("message-input"); const text=input.value.trim(); if(!text)return;
  $("welcome").classList.add("hidden"); input.value=""; addMessage("user",text);
  const send=$("chat-form").querySelector("button"); send.disabled=true; send.textContent="…";
  const pending=document.createElement("article"); pending.className="message assistant"; pending.textContent="Evil GPT is thinking…"; $("chat-messages").append(pending);
  try{
    const d=await api("/ask",{method:"POST",body:JSON.stringify({question:text,conversationId:currentConversation,webSearch:$("web-search").checked})});
    pending.remove(); currentConversation=d.conversationId; addMessage("assistant",d.answer); usage=d.usage;
    $("usage-label").textContent=`${usage.remaining} of ${usage.limit} messages left`; await loadHistory();
  }catch(err){pending.remove();addMessage("assistant",err.message);}
  finally{send.disabled=false;send.textContent="↑";}
});
$("message-input").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("chat-form").requestSubmit();}});
document.querySelectorAll("[data-prompt]").forEach(b=>b.addEventListener("click",()=>{$("message-input").value=b.dataset.prompt;$("message-input").focus();}));
async function loadHistory(){
  const d=await api("/api/conversations"); const list=$("history-list"); list.replaceChildren();
  d.conversations.forEach(c=>{const b=document.createElement("button");b.className="history-item";b.textContent=c.title;b.addEventListener("click",()=>openConversation(c.id));list.append(b);});
}
async function openConversation(id){
  try{const d=await api("/api/conversations/"+id);currentConversation=id;$("welcome").classList.add("hidden");$("chat-messages").replaceChildren();d.messages.forEach(m=>addMessage(m.role,m.content));showPage("chat");}
  catch(e){addMessage("assistant",e.message);}
}
function showPage(page){
  ["chat","plans","admin"].forEach(p=>$(p+"-page").classList.toggle("hidden",p!==page));
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  $("page-heading").textContent=page==="chat"?"Your thinking partner":page==="plans"?"Plans & usage":"Admin console";
  if(page==="plans")renderPlans(); if(page==="admin"&&currentUser.isAdmin)loadAdmin();
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
    btn.addEventListener("click",async()=>{try{const d=await api("/api/upgrade",{method:"POST",body:JSON.stringify({plan:key})});alert(d.message);}catch(e){alert(e.message);}});
    card.append(name,price,limit,btn);grid.append(card);
  });
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
$("logout").addEventListener("click",async()=>{try{await api("/logout",{method:"POST",body:"{}"});}finally{location.reload();}});
(async()=>{try{const d=await api("/api/me");await enterApp(d.user);}catch(e){}})();
