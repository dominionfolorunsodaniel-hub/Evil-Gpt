// State
let currentUser = null;
let isAdmin = false;
let userPlan = 'free'; // free, pending, paid
let premiumDays = 0;
let freeMessagesUsed = 0;
const MAX_FREE_MESSAGES = 3;

// DOM Elements
const tgOverlay = document.getElementById('tg-overlay');
const loginScreen = document.getElementById('login-screen');
const dashboard = document.getElementById('dashboard');
const chatBox = document.getElementById('chat-box');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const premiumLock = document.getElementById('premium-lock');
const adminLink = document.getElementById('admin-link');
const pendingList = document.getElementById('pending-users-list');
const messageCounter = document.getElementById('message-counter');

// Initialization
window.onload = function() {
    if(sessionStorage.getItem('tg_joined')) {
        closeTgOverlay();
    }
    startScarcityTimer();
};

function closeTgOverlay() {
    sessionStorage.setItem('tg_joined', 'true');
    tgOverlay.style.display = 'none';
}

// Login Logic
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
        const res = await fetch('/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username, password})
        });
        const data = await res.json();
        
        if(data.success) {
            currentUser = data.user.username;
            isAdmin = data.user.isAdmin;
            userPlan = data.user.plan;
            premiumDays = data.user.premiumDays || 0;
            
            setupDashboard();
        } else {
            document.getElementById('error-msg').innerText = "ACCESS DENIED";
        }
    } catch (err) {
        document.getElementById('error-msg').innerText = "CONNECTION ERROR";
    }
});

function setupDashboard() {
    loginScreen.classList.add('hidden');
    dashboard.classList.remove('hidden');
    document.getElementById('current-user').innerText = currentUser;
    
    if(isAdmin) {
        adminLink.style.display = 'block';
    }

    updatePlanUI();
}

function updatePlanUI() {
    const badge = document.getElementById('plan-badge');
    const lockMsg = document.getElementById('premium-lock');
    
    if(userPlan === 'paid') {
        badge.innerText = `PREMIUM (${premiumDays}d)`;
        badge.style.color = '#00ff41';
        lockMsg.style.display = 'none';
        userInput.disabled = false;
        sendBtn.disabled = false;
        messageCounter.innerText = "∞ Messages Available";
    } else if (userPlan === 'pending') {
        badge.innerText = 'PENDING APPROVAL';
        badge.style.color = '#ffff00';
        lockMsg.style.display = 'block';
        lockMsg.innerHTML = "🔒 Awaiting Admin Approval...";
        userInput.disabled = true;
        sendBtn.disabled = true;
        messageCounter.innerText = "";
    } else {
        badge.innerText = 'FREE';
        badge.style.color = '#ff003c';
        lockMsg.style.display = 'none'; // We handle locking via counter instead
        userInput.disabled = false;
        sendBtn.disabled = false;
        messageCounter.innerText = `Messages Used: ${freeMessagesUsed}/${MAX_FREE_MESSAGES}`;
    }
}

// Navigation
function showSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId + '-section').classList.add('active');
    
    document.querySelectorAll('.sidebar li').forEach(li => li.classList.remove('active'));
    event.target.classList.add('active');

    if(sectionId === 'admin' && isAdmin) {
        loadPendingUsers();
    }
}

// Chat Logic
async function sendMessage() {
    const text = userInput.value;
    if(!text) return;

    // Check Free User Limits
    if (userPlan === 'free' && freeMessagesUsed >= MAX_FREE_MESSAGES) {
        lockChat();
        return;
    }

    addMessage(text, 'user');
    userInput.value = '';

    sendBtn.innerText = "THINKING...";
    setTimeout(async () => {
        try {
            const res = await fetch('/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: text, user: currentUser})
            });
            const data = await res.json();
            addMessage(data.answer, 'ai');
            
            // Increment counter for free users
            if (userPlan === 'free') {
                freeMessagesUsed++;
                messageCounter.innerText = `Messages Used: ${freeMessagesUsed}/${MAX_FREE_MESSAGES}`;
                if (freeMessagesUsed >= MAX_FREE_MESSAGES) {
                    setTimeout(() => lockChat(), 1000);
                }
            }
        } catch (e) {
            addMessage("The void remains silent...", 'ai');
        }
        sendBtn.innerText = "SPEAK";
    }, 1000);
}

function addMessage(text, sender) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.innerHTML = `<p>${text}</p>`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function lockChat() {
    userInput.disabled = true;
    sendBtn.disabled = true;
    document.getElementById('chat-section').classList.add('locked');
    premiumLock.style.display = 'block';
    premiumLock.innerHTML = "🔒 YOUR VOICE IS SILENCED. UPGRADE TO SPEAK AGAIN.";
}

// Premium Logic
function initiatePayment(amount) {
    document.getElementById('payment-modal').style.display = 'block';
    window.currentPaymentAmount = amount;
}

function closePaymentModal() {
    document.getElementById('payment-modal').style.display = 'none';
}

async function requestUpgrade() {
    try {
        const res = await fetch('/upgrade_request', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({amount: window.currentPaymentAmount})
        });
        const data = await res.json();
        if(data.success) {
            alert("Request sent! Wait for Admin approval.");
            userPlan = 'pending';
            updatePlanUI();
            closePaymentModal();
        }
    } catch(e) {
        alert("Error sending request.");
    }
}

// Admin Logic
async function broadcastMessage() {
    const text = document.getElementById('broadcast-text').value;
    if(!text) return;
    
    const res = await fetch('/broadcast', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: text})
    });
    alert("Broadcast Sent!");
    document.getElementById('broadcast-text').value = '';
}

async function loadPendingUsers() {
    try {
        const res = await fetch('/admin/users');
        const data = await res.json();
        pendingList.innerHTML = '';
        
        data.users.forEach(user => {
            const div = document.createElement('div');
            div.className = 'pending-item';
            div.innerHTML = `
                <span>${user.username} (${user.plan})</span>
                <button onclick="approveUser('${user.username}')">Approve</button>
            `;
            pendingList.appendChild(div);
        });
    } catch(e) {
        console.error("Failed to load users");
    }
}

async function approveUser(username) {
    try {
        await fetch(`/admin/approve/${username}`, { method: 'POST' });
        loadPendingUsers();
    } catch(e) {
        alert("Error approving user");
    }
}

function logout() {
    location.reload();
}

// Scarcity Timer
function startScarcityTimer() {
    let timeLeft = 3600; // 1 hour
    const timerElement = document.getElementById('countdown');
    
    setInterval(() => {
        timeLeft--;
        if(timeLeft < 0) timeLeft = 3600;
        
        const hours = Math.floor(timeLeft / 3600);
        const minutes = Math.floor((timeLeft % 3600) / 60);
        const seconds = timeLeft % 60;
        
        timerElement.innerText = `⏳ Special Offer expires in: ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
}