import os, re, uuid, random, smtplib, requests, io
from urllib.parse import quote
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone, date, timedelta
from functools import wraps

import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, render_template, request, jsonify, session, Response, stream_with_context
from werkzeug.security import generate_password_hash, check_password_hash
from openai import OpenAI
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "super-secret-key-change-me")
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SECURE=True, SESSION_COOKIE_SAMESITE="Lax", MAX_CONTENT_LENGTH=16 * 1024 * 1024)

limiter = Limiter(key_func=get_remote_address, app=app, default_limits=[], storage_uri="memory://")

DATABASE_URL = os.environ.get("DATABASE_URL")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_FAST_MODEL = os.environ.get("GROQ_FAST_MODEL", "llama-3.1-8b-instant")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
SMTP_EMAIL = os.environ.get("SMTP_EMAIL")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD")

# ALL 8 PLANS RESTORED with Daily Image Limits
PLANS = {
    "free": {"name": "Free", "price": 0, "monthly_messages": 20, "daily_images": 5},
    "starter": {"name": "Starter", "price": 1500, "monthly_messages": 100, "daily_images": 20},
    "plus": {"name": "Plus", "price": 3500, "monthly_messages": 300, "daily_images": 50},
    "pro": {"name": "Pro", "price": 7500, "monthly_messages": 750, "daily_images": 100},
    "ultra": {"name": "Ultra", "price": 15000, "monthly_messages": 2000, "daily_images": 200},
    "enterprise": {"name": "Enterprise", "price": 35000, "monthly_messages": 5000, "daily_images": 500},
    "business_elite": {"name": "Business Elite", "price": 50000, "monthly_messages": 10000, "daily_images": 1000},
    "infinity": {"name": "Infinity", "price": 100000, "monthly_messages": 20000, "daily_images": 2500},
}

DAILY_PROMPTS = ["What is a small habit that has a huge impact?", "Explain a concept using only simple words.", "Write a short poem about AI."]
PERSONAS = {
    "assistant": {"name": "Assistant", "instructions": "You are Evil GPT Assistant, a helpful, accurate AI."},
    "tutor": {"name": "Tutor", "instructions": "You are a patient tutor. Explain step by step."},
    "code_reviewer": {"name": "Code reviewer", "instructions": "You are a senior code reviewer."},
}

def db(): return psycopg2.connect(DATABASE_URL, sslmode="require", cursor_factory=RealDictCursor)

def init_db():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_users (
                    id BIGSERIAL PRIMARY KEY, username VARCHAR(40) UNIQUE NOT NULL,
                    email VARCHAR(254) UNIQUE NOT NULL, password_hash TEXT,
                    plan VARCHAR(32) NOT NULL DEFAULT 'free', is_admin BOOLEAN NOT NULL DEFAULT FALSE,
                    is_verified BOOLEAN DEFAULT FALSE, trial_ends_at TIMESTAMPTZ,
                    bonus_messages INTEGER DEFAULT 0, streak_count INTEGER DEFAULT 0,
                    last_streak_date DATE, images_generated_today INTEGER DEFAULT 0,
                    last_image_date DATE, custom_persona TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("CREATE TABLE IF NOT EXISTS evil_conversations (id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, title VARCHAR(160) NOT NULL DEFAULT 'New conversation', pinned BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
            cur.execute("CREATE TABLE IF NOT EXISTS evil_messages (id BIGSERIAL PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES evil_conversations(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, role VARCHAR(16) NOT NULL, content TEXT NOT NULL, attachment_type VARCHAR(20), attachment_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
            cur.execute("CREATE TABLE IF NOT EXISTS evil_usage (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, usage_month VARCHAR(7) NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, usage_month))")
            cur.execute("CREATE TABLE IF NOT EXISTS evil_payment_requests (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, plan VARCHAR(32) NOT NULL, amount_ngn INTEGER NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
            cur.execute("CREATE TABLE IF NOT EXISTS evil_payment_settings (id INT PRIMARY KEY DEFAULT 1, account_name VARCHAR(120) NOT NULL, account_number VARCHAR(40) NOT NULL, bank_name VARCHAR(80) NOT NULL, extra_note TEXT)")
            cur.execute("INSERT INTO evil_payment_settings(id, account_name, account_number, bank_name, extra_note) VALUES (1, 'Daniel Dominion Folorunso', '8100481004', 'Moniepoint', 'Upload screenshot.') ON CONFLICT (id) DO NOTHING")
            cur.execute("CREATE TABLE IF NOT EXISTS evil_payment_proofs (id BIGSERIAL PRIMARY KEY, payment_request_id BIGINT NOT NULL REFERENCES evil_payment_requests(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, filename VARCHAR(200) NOT NULL, mimetype VARCHAR(80) NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
            cur.execute("CREATE TABLE IF NOT EXISTS evil_otp_requests (id BIGSERIAL PRIMARY KEY, email VARCHAR(254) NOT NULL, code VARCHAR(6) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
            cur.execute("CREATE TABLE IF NOT EXISTS evil_notifications (id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES evil_users(id) ON DELETE CASCADE, message TEXT NOT NULL, is_read BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
            
            if ADMIN_USERNAME and ADMIN_PASSWORD:
                cur.execute("SELECT id FROM evil_users WHERE username=%s", (ADMIN_USERNAME,))
                if not cur.fetchone():
                    cur.execute("INSERT INTO evil_users(username,email,password_hash,plan,is_admin,is_verified) VALUES (%s,%s,%s,'infinity',TRUE,TRUE)", (ADMIN_USERNAME, (ADMIN_USERNAME.lower() + "@admin.invalid")[:254], generate_password_hash(ADMIN_PASSWORD)))
        conn.commit()

def ensure_db():
    try: init_db()
    except Exception as exc: app.logger.exception("DB Init failed: %s", exc); raise

def current_user():
    user_id = session.get("user_id")
    if not user_id: return None
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id,username,email,plan,is_admin,trial_ends_at,bonus_messages,streak_count,last_streak_date,custom_persona,images_generated_today,last_image_date FROM evil_users WHERE id=%s", (user_id,))
            return cur.fetchone()

def login_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"): return jsonify({"error": "Please log in."}), 401
        return fn(*args, **kwargs)
    return wrapped

def admin_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user or not user["is_admin"]: return jsonify({"error": "Admin required."}), 403
        return fn(*args, **kwargs)
    return wrapped

def usage_status(user_id, plan):
    plan_data = PLANS.get(plan, PLANS["free"])
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT trial_ends_at, bonus_messages FROM evil_users WHERE id=%s", (user_id,))
            u = cur.fetchone()
            if u and u["trial_ends_at"] and u["trial_ends_at"] > datetime.now(timezone.utc):
                return {"used": 0, "limit": 99999, "remaining": 99999, "trial": True}
            cur.execute("SELECT message_count FROM evil_usage WHERE user_id=%s AND usage_month=%s", (user_id, month))
            row = cur.fetchone()
            used = row["message_count"] if row else 0
    limit = plan_data["monthly_messages"] + (u["bonus_messages"] if u else 0)
    return {"used": used, "limit": limit, "remaining": max(0, limit-used), "trial": False}

def send_email(to_email, code):
    if not SMTP_EMAIL or not SMTP_PASSWORD: return False
    try:
        msg = MIMEMultipart(); msg['From'], msg['To'], msg['Subject'] = SMTP_EMAIL, to_email, "Verify your Evil GPT Account"
        msg.attach(MIMEText(f"Hello,\n\nYour verification code is: {code}\n\nEnter this on the website to activate your account.", 'plain'))
        server = smtplib.SMTP('smtp.gmail.com', 587); server.starttls()
        server.login(SMTP_EMAIL, SMTP_PASSWORD); server.send_message(msg); server.quit()
        return True
    except Exception: return False

@app.errorhandler(429)
def ratelimit_handler(e): return jsonify({"error": "Too fast! Wait a moment."}), 429

@app.route("/")
def index():
    if not session.get("user_id") and not request.args.get("force_login"):
        return render_template("landing.html")
    return render_template("index.html")

@app.get("/api/health")
def health():
    try:
        with db() as conn:
            with conn.cursor() as cur: cur.execute("SELECT 1")
        return jsonify({"ok": True})
    except Exception: return jsonify({"ok": False}), 503

@app.get("/api/daily-prompt")
def daily_prompt(): return jsonify({"prompt": DAILY_PROMPTS[datetime.now().weekday()]})
@app.get("/api/personas")
def personas(): return jsonify({"personas": [{"key": k, "name": v["name"]} for k, v in PERSONAS.items()]})

@app.post("/api/checkin")
@login_required
def daily_checkin():
    user = current_user()
    today = date.today()
    if user["last_streak_date"] == today:
        return jsonify({"error": "Already checked in today."}), 400
    new_streak = (user["streak_count"] or 0) + 1 if user["last_streak_date"] == today - timedelta(days=1) else 1
    bonus = 20 if new_streak >= 3 else 5
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE evil_users SET streak_count=%s, last_streak_date=%s, bonus_messages=bonus_messages+%s WHERE id=%s", (new_streak, today, bonus, user["id"]))
    return jsonify({"success": True, "streak": new_streak, "bonus": bonus})

@app.get("/api/leaderboard")
def leaderboard():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT username, streak_count FROM evil_users WHERE is_admin=FALSE ORDER BY streak_count DESC LIMIT 10")
            return jsonify({"leaders": [dict(r) for r in cur.fetchall()]})

# --- AUTH ---
@app.post("/register")
@limiter.limit("5 per hour")
def register():
    data = request.get_json(silent=True) or {}
    username, email, password = str(data.get("username","")).strip(), str(data.get("email","")).strip().lower(), str(data.get("password",""))
    if not re.fullmatch(r"[A-Za-z0-9_]{3,40}", username): return jsonify({"error": "Invalid username."}), 400
    if len(password) < 10: return jsonify({"error": "Password too short."}), 400
    try:
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO evil_users(username,email,password_hash,plan,trial_ends_at,is_verified) VALUES (%s,%s,%s,'infinity', NOW() + INTERVAL '2 days', FALSE)", (username, email, generate_password_hash(password)))
                code = str(random.randint(100000, 999999))
                cur.execute("INSERT INTO evil_otp_requests(email,code,status) VALUES (%s,%s,'pending')", (email, code))
        return jsonify({"success": True, "message": "Account created! Wait for Admin approval."})
    except psycopg2.errors.UniqueViolation: return jsonify({"error": "Username or email taken."}), 409
    except Exception: return jsonify({"error": "Registration failed."}), 500

@app.post("/api/auth/verify-otp")
def verify_otp():
    data = request.get_json(silent=True) or {}
    email, code = str(data.get("email","")).strip().lower(), str(data.get("code","")).strip()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM evil_otp_requests WHERE email=%s AND code=%s AND status='approved' ORDER BY id DESC LIMIT 1", (email, code))
            if not cur.fetchone(): return jsonify({"error": "Invalid or unapproved code."}), 401
            cur.execute("UPDATE evil_users SET is_verified=TRUE WHERE email=%s", (email,))
            cur.execute("DELETE FROM evil_otp_requests WHERE email=%s", (email,))
    return jsonify({"success": True, "message": "Account verified! You can now log in."})

@app.post("/login")
@limiter.limit("20 per hour")
def login():
    data = request.get_json(silent=True) or {}
    username, password = str(data.get("username","")).strip(), str(data.get("password",""))
    try:
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM evil_users WHERE username=%s", (username,))
                user = cur.fetchone()
        if not user or not check_password_hash(user["password_hash"], password): return jsonify({"error": "Invalid credentials."}), 401
        if not user["is_verified"]: return jsonify({"error": "Account not verified. Please enter your OTP code."}), 403
        session.clear(); session["user_id"] = user["id"]
        return jsonify({"success": True, "user": {"username": user["username"], "plan": user["plan"], "isAdmin": user["is_admin"]}})
    except Exception: return jsonify({"error": "Login unavailable."}), 500

@app.post("/logout")
def logout(): session.clear(); return jsonify({"success": True})

# --- IMAGE GENERATION ---
@app.post("/api/generate-image")
@login_required
def generate_image():
    data = request.get_json(silent=True) or {}
    prompt = str(data.get("prompt", "")).strip()
    if not prompt: return jsonify({"error": "Prompt required."}), 400
    
    user = current_user()
    today = date.today()
    
    # Check daily limits
    imgs_today = user["images_generated_today"] or 0
    if user["last_image_date"] != today:
        imgs_today = 0 # Reset for new day
        
    limit = PLANS.get(user["plan"], PLANS["free"])["daily_images"]
    if imgs_today >= limit:
        return jsonify({"error": f"Daily image limit reached ({limit}). Upgrade your plan."}), 429
        
    try:
        url = f"https://image.pollinations.ai/prompt/{quote(prompt)}?width=1024&height=1024&nologo=true"
        requests.get(url, timeout=30) # Ping to trigger generation
        
        # Update DB
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE evil_users SET images_generated_today=%s, last_image_date=%s WHERE id=%s", (imgs_today + 1, today, user["id"]))
                
        return jsonify({"success": True, "image_url": url})
    except Exception: return jsonify({"error": "Image generation failed."}), 500

@app.post("/api/extract-text")
@login_required
def extract_text():
    if "file" not in request.files: return jsonify({"error": "No file."}), 400
    file = request.files["file"]
    try:
        if file.mimetype == "application/pdf":
            import PyPDF2
            reader = PyPDF2.PdfReader(io.BytesIO(file.read()))
            text = "".join([p.extract_text() for p in reader.pages if p.extract_text()])
            return jsonify({"success": True, "text": text[:4000]})
        return jsonify({"error": "Only PDF files are supported for text extraction right now."}), 400
    except Exception as e: return jsonify({"error": str(e)}), 500

# --- CHAT ---
@app.get("/api/conversations")
@login_required
def conversations():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id,title,updated_at,pinned FROM evil_conversations WHERE user_id=%s ORDER BY pinned DESC, updated_at DESC LIMIT 50", (current_user()["id"],))
            return jsonify({"conversations": [{"id": str(r["id"]), "title": r["title"], "pinned": r["pinned"]} for r in cur.fetchall()]})

@app.get("/api/conversations/<uuid:conversation_id>")
@login_required
def get_conversation(conversation_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id,title FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), current_user()["id"]))
            if not cur.fetchone(): return jsonify({"error": "Not found."}), 404
            cur.execute("SELECT role,content,attachment_type,attachment_url FROM evil_messages WHERE conversation_id=%s ORDER BY id", (str(conversation_id),))
            msgs = cur.fetchall()
    return jsonify({"messages": [{"role":m["role"],"content":m["content"],"attachment_type":m["attachment_type"],"attachment_url":m["attachment_url"]} for m in msgs]})

@app.post("/api/conversations/<uuid:conversation_id>/delete")
@login_required
def delete_conversation(conversation_id):
    with db() as conn:
        with conn.cursor() as cur: cur.execute("DELETE FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), current_user()["id"]))
    return jsonify({"success": True})

@app.post("/ask/stream")
@login_required
def ask_stream():
    data = request.get_json(silent=True) or {}
    question, conv_id = str(data.get("question", "")).strip(), data.get("conversationId")
    persona, model_type = str(data.get("persona", "assistant")), str(data.get("modelType", "deep"))
    temp = float(data.get("temperature", 0.7))
    user = current_user()
    if usage_status(user["id"], user["plan"])["remaining"] <= 0: return jsonify({"error": "Message limit reached."}), 429

    with db() as conn:
        with conn.cursor() as cur:
            if conv_id:
                cur.execute("SELECT id FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conv_id), user["id"]))
                if not cur.fetchone(): return jsonify({"error": "Not found."}), 404
            else:
                conv_id = str(uuid.uuid4())
                title = question[:40] + "..." if len(question) > 40 else question
                cur.execute("INSERT INTO evil_conversations(id,user_id,title) VALUES (%s,%s,%s)", (conv_id, user["id"], title))
            cur.execute("SELECT role,content FROM evil_messages WHERE conversation_id=%s ORDER BY id DESC LIMIT 16", (conv_id,))
            history = list(reversed(cur.fetchall()))

    sys_prompt = user["custom_persona"] if user["custom_persona"] else PERSONAS.get(persona, PERSONAS["assistant"])["instructions"]
    groq_messages = [{"role": "system", "content": sys_prompt}]
    groq_messages.extend([{"role": m["role"], "content": m["content"]} for m in history])
    groq_messages.append({"role": "user", "content": question})
    
    client = OpenAI(api_key=GROQ_API_KEY, base_url="https://api.groq.com/openai/v1")
    model = GROQ_FAST_MODEL if model_type == "fast" else GROQ_MODEL

    def generate():
        collected = []
        try:
            stream = client.chat.completions.create(model=model, messages=groq_messages, temperature=temp, stream=True)
            for chunk in stream:
                delta = chunk.choices[0].delta.content or ""
                if delta: collected.append(delta); yield f"data: {delta.replace(chr(10),' ')}\n\n"
            with db() as conn:
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO evil_messages(conversation_id,user_id,role,content) VALUES (%s,%s,'user',%s)", (conv_id, user["id"], question))
                    cur.execute("INSERT INTO evil_messages(conversation_id,user_id,role,content) VALUES (%s,%s,'assistant',%s)", (conv_id, user["id"], "".join(collected)))
                    cur.execute("INSERT INTO evil_usage(user_id,usage_month,message_count) VALUES (%s,%s,1) ON CONFLICT (user_id,usage_month) DO UPDATE SET message_count=evil_usage.message_count+1", (user["id"], datetime.now(timezone.utc).strftime("%Y-%m")))
        except Exception: yield "data: [ERROR]\n\n"; return
        yield f"data: [DONE:{conv_id}]\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream")

# --- ADMIN & NOTIFICATIONS ---
@app.get("/api/admin/otp-requests")
@login_required
@admin_required
def admin_otp_requests():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, email, code, status FROM evil_otp_requests ORDER BY id DESC LIMIT 50")
            return jsonify({"requests": [dict(r) for r in cur.fetchall()]})

@app.post("/api/admin/approve-otp/<int:otp_id>")
@login_required
@admin_required
def approve_otp(otp_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT email, code FROM evil_otp_requests WHERE id=%s", (otp_id,))
            row = cur.fetchone()
            if not row: return jsonify({"error": "Not found."}), 404
            sent = send_email(row["email"], row["code"])
            cur.execute("UPDATE evil_otp_requests SET status='approved' WHERE id=%s", (otp_id,))
    msg = "Approved & Email Sent!" if sent else f"Approved. (Code: {row['code']})"
    return jsonify({"success": True, "message": msg})

@app.post("/api/admin/broadcast")
@login_required
@admin_required
def admin_broadcast():
    msg = str((request.get_json(silent=True) or {}).get("message","")).strip()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO evil_notifications(user_id, message) SELECT id, %s FROM evil_users WHERE is_admin=FALSE", (msg,))
    return jsonify({"success": True})

@app.get("/api/notifications")
@login_required
def get_notifications():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, message, is_read FROM evil_notifications WHERE user_id=%s ORDER BY id DESC LIMIT 20", (current_user()["id"],))
            return jsonify({"notifications": [dict(r) for r in cur.fetchall()]})

@app.post("/api/notifications/read")
@login_required
def mark_notifications_read():
    with db() as conn:
        with conn.cursor() as cur: cur.execute("UPDATE evil_notifications SET is_read=TRUE WHERE user_id=%s", (current_user()["id"],))
    return jsonify({"success": True})

@app.get("/api/me")
@login_required
def me():
    user = current_user()
    return jsonify({"user": {"username": user["username"], "email": user["email"], "plan": user["plan"], "isAdmin": user["is_admin"], "streak": user["streak_count"] or 0}, "usage": usage_status(user["id"], user["plan"]), "plans": PLANS})

@app.post("/api/user/update-persona")
@login_required
def update_persona():
    text = str((request.get_json(silent=True) or {}).get("persona", "")).strip()
    with db() as conn:
        with conn.cursor() as cur: cur.execute("UPDATE evil_users SET custom_persona=%s WHERE id=%s", (text, current_user()["id"]))
    return jsonify({"success": True})

# --- PAYMENTS ---
@app.get("/api/payment-info")
@login_required
def payment_info():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT account_name, account_number, bank_name, extra_note FROM evil_payment_settings WHERE id=1")
            return jsonify({"payment": dict(cur.fetchone())})

@app.post("/api/upgrade")
@login_required
def upgrade_request():
    plan = str((request.get_json(silent=True) or {}).get("plan", ""))
    if plan not in PLANS or plan == "free": return jsonify({"error": "Invalid plan."}), 400
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO evil_payment_requests(user_id,plan,amount_ngn) VALUES (%s,%s,%s) RETURNING id", (current_user()["id"], plan, PLANS[plan]["price"]))
            rid = cur.fetchone()["id"]
    return jsonify({"success": True, "requestId": rid, "amount": PLANS[plan]["price"]})

@app.post("/api/payment-proof/<int:request_id>")
@login_required
def upload_payment_proof(request_id):
    if "screenshot" not in request.files: return jsonify({"error": "No file."}), 400
    file = request.files["screenshot"]
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO evil_payment_proofs(payment_request_id,user_id,filename,mimetype,data) VALUES (%s,%s,%s,%s,%s)", (request_id, current_user()["id"], file.filename, file.mimetype, psycopg2.Binary(file.read())))
    return jsonify({"success": True})

@app.get("/api/admin/users")
@login_required
@admin_required
def admin_users():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id,username,email,plan FROM evil_users WHERE is_admin=FALSE ORDER BY id DESC")
            return jsonify({"users": [dict(r) for r in cur.fetchall()]})

@app.get("/api/admin/payment-requests")
@login_required
@admin_required
def admin_payment_requests():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT pr.id, pr.user_id, u.username, pr.plan, pr.amount_ngn, pr.status, (SELECT id FROM evil_payment_proofs p WHERE p.payment_request_id=pr.id LIMIT 1) AS proof_id FROM evil_payment_requests pr JOIN evil_users u ON u.id = pr.user_id ORDER BY pr.id DESC")
            return jsonify({"requests": [dict(r) for r in cur.fetchall()]})

@app.get("/api/admin/payment-proof/<int:proof_id>")
@login_required
@admin_required
def admin_get_proof(proof_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT filename, mimetype, data FROM evil_payment_proofs WHERE id=%s", (proof_id,))
            row = cur.fetchone()
    return Response(row["data"], mimetype=row["mimetype"])

@app.post("/api/admin/approve/<int:user_id>")
@login_required
@admin_required
def admin_approve(user_id):
    plan = str((request.get_json(silent=True) or {}).get("plan", ""))
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE evil_users SET plan=%s WHERE id=%s", (plan, user_id))
            cur.execute("UPDATE evil_payment_requests SET status='approved' WHERE user_id=%s", (user_id,))
    return jsonify({"success": True})

@app.before_request
def initialize_database_once():
    if not getattr(app, "_db_initialized", False):
        ensure_db(); app._db_initialized = True