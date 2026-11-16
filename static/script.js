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

window.onload = function() {
    if(sessionStorage.getItem('tg_joined')) {
        closeTgOverlay();
    }
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
    } else if (userPlan === 'pending') {
        badge.innerText = 'PENDING APPROVAL';
        badge.style.color = '#ffff00';
        lockMsg.style.display = 'block';
        userInput.disabled = true;
        sendBtn.disabled = true;
    } else {
        badge.innerText = 'FREE';
        badge.style.color = '#ff003c';
        lockMsg.style.display = 'block';
        userInput.disabled = true;
        sendBtn.disabled = true;
    }
}

function showSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId + '-section').classList.add('active');
    
    document.querySelectorAll('.sidebar li').forEach(li => li.classList.remove('active'));
    event.target.classList.add('active');

    if(sectionId === 'admin' && isAdmin) {
        loadPendingUsers();
    }
}

async function sendMessage() {
    const text = userInput.value;
    if(!text) return;

    addMessage(text, 'user');
    userInput.value = '';
    sendBtn.innerText = "THINKING...";
    sendBtn.disabled = true;

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
}

function addMessage(text, sender) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.innerHTML = `<p>${text}</p>`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function initiatePayment(amount) {
    document.getElementById('payment-modal').style.display = 'block';
    window.currentPaymentAmount = amount;
}

function closePaymentModal() {
    document.getElementById('payment-modal').style.display = 'none';
}

async function submitPaymentWithProof() {
    const fileInput = document.getElementById('proof-upload');
    if(fileInput.files.length === 0) {
        alert("Please upload a screenshot of your payment!");
        return;
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
        const res = await fetch('/upload_payment', {
            method: 'POST',
            body: formData // Don't set Content-Type header manually when sending FormData
        });
        const data = await res.json();
        if(data.success) {
            alert("Proof sent! Wait for Admin approval.");
            userPlan = 'pending';
            updatePlanUI();
            closePaymentModal();
        } else {
            alert("Error: " + data.message);
        }
    } catch(e) {
        alert("Connection Error");
    }
}

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
            
            let proofLink = '';
            if(user.proof) {
                proofLink = `<br><small><a href="/static/uploads/${user.proof}" target="_blank">View Proof</a></small>`;
            }

            div.innerHTML = `
                <div>
                    <strong>${user.username}</strong> (${user.plan})
                    ${proofLink}
                </div>
                <button onclick="approveUser('${user.username}')">Approve</button>
            `;
            pendingList.appendChild(div);
        });
    } catch(e) {
        console.error("Failed to load users");
    }
}

function approveUser(username) {
    fetch(`/admin/approve/${username}`, { method: 'POST' })
        .then(() => loadPendingUsers())
        .catch(err => alert("Error approving user"));
}

function logout() {
    location.reload();
}
