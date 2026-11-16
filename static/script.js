// State
let currentUser = null;
let isAdmin = false;
let userPlan = 'free'; 
let premiumDays = 0;

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
const sidebar = document.getElementById('sidebar');

// Initialization
window.onload = function() {
    if(sessionStorage.getItem('tg_joined')) {
        closeTgOverlay();
    }
    updateStats();
};

function closeTgOverlay() {
    sessionStorage.setItem('tg_joined', 'true');
    tgOverlay.style.display = 'none';
}

// --- AUTH LOGIC ---
function toggleAuth(type) {
    const loginForm = document.getElementById('login-form');
    const regForm = document.getElementById('register-form');
    const loginBtn = document.getElementById('show-login-btn');
    const regBtn = document.getElementById('show-reg-btn');
    const errorMsg = document.getElementById('error-msg');
    const successMsg = document.getElementById('success-msg');
    
    errorMsg.innerText = "";
    successMsg.innerText = "";

    if (type === 'login') {
        loginForm.classList.remove('hidden');
        regForm.classList.add('hidden');
        loginBtn.classList.add('active-tab');
        regBtn.classList.remove('active-tab');
    } else {
        loginForm.classList.add('hidden');
        regForm.classList.remove('hidden');
        regBtn.classList.add('active-tab');
        loginBtn.classList.remove('active-tab');
    }
}

// Initialize default view
document.addEventListener('DOMContentLoaded', () => {
    toggleAuth('login');
});

// Register
document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    const successMsg = document.getElementById('success-msg');

    try {
        const res = await fetch('/register', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username, email, password})
        });
        const data = await res.json();
        
        if(data.success) {
            successMsg.innerText = "Account created! Please wait for Admin approval.";
            document.getElementById('register-form').reset();
            setTimeout(() => {
                toggleAuth('login');
                successMsg.innerText = "";
            }, 2000);
        } else {
            document.getElementById('error-msg').innerText = data.message || "Registration failed";
        }
    } catch (err) {
        document.getElementById('error-msg').innerText = "Connection Error";
    }
});

// Login
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

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
        adminLink.style.display = 'flex';
    }

    updatePlanUI();
}

function updatePlanUI() {
    const badge = document.getElementById('plan-badge');
    
    if(userPlan === 'paid') {
        badge.innerText = `PREMIUM (${premiumDays}d)`;
        badge.style.background = '#00ff41';
        badge.style.color = 'black';
        premiumLock.style.display = 'none';
        userInput.disabled = false;
        sendBtn.disabled = false;
    } else if (userPlan === 'pending') {
        badge.innerText = 'PENDING';
        badge.style.background = '#ffff00';
        badge.style.color = 'black';
        premiumLock.style.display = 'block';
        userInput.disabled = true;
        sendBtn.disabled = true;
    } else {
        badge.innerText = 'FREE';
        badge.style.background = '#333';
        badge.style.color = '#fff';
        premiumLock.style.display = 'block';
        userInput.disabled = true;
        sendBtn.disabled = true;
    }
}

// Navigation
function showSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId + '-section').classList.add('active');
    
    // Update sidebar active state
    document.querySelectorAll('.sidebar li').forEach(li => li.classList.remove('active'));
    event.currentTarget.classList.add('active');
    
    // Close sidebar on mobile after selection
    if(window.innerWidth <= 768) {
        sidebar.classList.remove('open');
    }

    if(sectionId === 'admin' && isAdmin) {
        loadPendingUsers();
    }
}

function toggleSidebar() {
    sidebar.classList.toggle('open');
}

// Chat Logic
async function sendMessage() {
    const text = userInput.value;
    if(!text) return;

    addMessage(text, 'user');
    userInput.value = '';

    sendBtn.innerText = "THINKING...";
    sendBtn.disabled = true;
    
    setTimeout(async () => {
        try {
            const res = await fetch('/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: text, user: currentUser})
            });
            const data = await res.json();
            addMessage(data.answer, 'ai');
        } catch (e) {
            addMessage("The void remains silent...", 'ai');
        }
        sendBtn.innerText = "SPEAK";
        sendBtn.disabled = false;
    }, 1000);
}

function addMessage(text, sender) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.innerHTML = `<p>${text}</p>`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
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
        
        if(data.users.length === 0) {
            pendingList.innerHTML = '<p>No pending users.</p>';
            return;
        }

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

// Fake Stats
function updateStats() {
    setInterval(() => {
        const online = Math.floor(Math.random() * (1500 - 1000) + 1000);
        document.getElementById('online-count').innerText = online.toLocaleString();
    }, 5000);
}
