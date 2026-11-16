import os
import re
import uuid
from datetime import datetime, timezone
from functools import wraps

import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, render_template, request, jsonify, session
from werkzeug.security import generate_password_hash, check_password_hash
from openai import OpenAI

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY")
if not app.secret_key:
    raise RuntimeError("SECRET_KEY is missing. Set it in Render Environment.")

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_SAMESITE="Lax",
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)

DATABASE_URL = os.environ.get("DATABASE_URL")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")

PLANS = {
    "free": {"name": "Free", "price": 0, "monthly_messages": 20},
    "starter": {"name": "Starter", "price": 1500, "monthly_messages": 100},
    "plus": {"name": "Plus", "price": 3500, "monthly_messages": 300},
    "pro": {"name": "Pro", "price": 7500, "monthly_messages": 750},
    "ultra": {"name": "Ultra", "price": 15000, "monthly_messages": 2000},
    "enterprise": {"name": "Enterprise", "price": 35000, "monthly_messages": 5000},
    "business_elite": {"name": "Business Elite", "price": 50000, "monthly_messages": 10000},
    "infinity": {"name": "Infinity", "price": 100000, "monthly_messages": 20000},
}

def db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is missing. Add your Neon connection string in Render.")
    return psycopg2.connect(DATABASE_URL, sslmode="require", cursor_factory=RealDictCursor)

def init_db():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_users (
                    id BIGSERIAL PRIMARY KEY,
                    username VARCHAR(40) UNIQUE NOT NULL,
                    email VARCHAR(254) UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    plan VARCHAR(32) NOT NULL DEFAULT 'free',
                    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_conversations (
                    id UUID PRIMARY KEY,
                    user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE,
                    title VARCHAR(160) NOT NULL DEFAULT 'New conversation',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_messages (
                    id BIGSERIAL PRIMARY KEY,
                    conversation_id UUID NOT NULL REFERENCES evil_conversations(id) ON DELETE CASCADE,
                    user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE,
                    role VARCHAR(16) NOT NULL CHECK (role IN ('user','assistant')),
                    content TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_usage (
                    id BIGSERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE,
                    usage_month VARCHAR(7) NOT NULL,
                    message_count INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(user_id, usage_month)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_payment_requests (
                    id BIGSERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE,
                    plan VARCHAR(32) NOT NULL,
                    amount_ngn INTEGER NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_announcements (
                    id BIGSERIAL PRIMARY KEY,
                    admin_user_id BIGINT REFERENCES evil_users(id),
                    message TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            # Create/update only the configured admin account; no default credentials.
            if ADMIN_USERNAME and ADMIN_PASSWORD:
                cur.execute("SELECT id FROM evil_users WHERE username=%s", (ADMIN_USERNAME,))
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "UPDATE evil_users SET is_admin=TRUE WHERE username=%s",
                        (ADMIN_USERNAME,)
                    )
                else:
                    admin_email = (ADMIN_USERNAME.lower() + "@admin.invalid")[:254]
                    cur.execute("""
                        INSERT INTO evil_users(username,email,password_hash,plan,is_admin)
                        VALUES (%s,%s,%s,'infinity',TRUE)
                        ON CONFLICT (username) DO NOTHING
                    """, (ADMIN_USERNAME, admin_email, generate_password_hash(ADMIN_PASSWORD)))
        conn.commit()

def ensure_db():
    try:
        init_db()
    except Exception as exc:
        app.logger.exception("Database initialization failed: %s", exc)
        raise

def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id,username,email,plan,is_admin FROM evil_users WHERE id=%s", (user_id,))
            return cur.fetchone()

def login_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"error": "Please log in."}), 401
        return fn(*args, **kwargs)
    return wrapped

def admin_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user or not user["is_admin"]:
            return jsonify({"error": "Admin access required."}), 403
        return fn(*args, **kwargs)
    return wrapped

def usage_status(user_id, plan):
    plan_data = PLANS.get(plan, PLANS["free"])
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT message_count FROM evil_usage
                WHERE user_id=%s AND usage_month=%s
            """, (user_id, month))
            row = cur.fetchone()
            used = row["message_count"] if row else 0
    limit = plan_data["monthly_messages"]
    return {"used": used, "limit": limit, "remaining": max(0, limit-used)}

@app.route("/")
def index():
    return render_template("index.html")

@app.get("/api/health")
def health():
    try:
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        return jsonify({"ok": True, "database": "connected"})
    except Exception:
        return jsonify({"ok": False, "database": "unavailable"}), 503

@app.post("/register")
def register():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    if not re.fullmatch(r"[A-Za-z0-9_]{3,40}", username):
        return jsonify({"success": False, "message": "Username must be 3–40 characters using letters, numbers or underscores."}), 400
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(email) > 254:
        return jsonify({"success": False, "message": "Enter a valid email address."}), 400
    if len(password) < 10 or len(password) > 128:
        return jsonify({"success": False, "message": "Password must be at least 10 characters."}), 400
    try:
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO evil_users(username,email,password_hash,plan)
                    VALUES (%s,%s,%s,'free')
                """, (username, email, generate_password_hash(password)))
        return jsonify({"success": True, "message": "Account created. You can now sign in."})
    except psycopg2.errors.UniqueViolation:
        return jsonify({"success": False, "message": "That username or email is already registered."}), 409
    except Exception:
        app.logger.exception("Registration failed")
        return jsonify({"success": False, "message": "Registration is temporarily unavailable."}), 500

@app.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    try:
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM evil_users WHERE username=%s", (username,))
                user = cur.fetchone()
        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify({"success": False, "message": "Invalid username or password."}), 401
        session.clear()
        session["user_id"] = user["id"]
        return jsonify({"success": True, "user": {
            "username": user["username"], "email": user["email"],
            "plan": user["plan"], "isAdmin": user["is_admin"]
        }})
    except Exception:
        app.logger.exception("Login failed")
        return jsonify({"success": False, "message": "Login is temporarily unavailable."}), 500

@app.post("/logout")
def logout():
    session.clear()
    return jsonify({"success": True})

@app.get("/api/me")
@login_required
def me():
    user = current_user()
    return jsonify({
        "user": {"username": user["username"], "email": user["email"],
                 "plan": user["plan"], "isAdmin": user["is_admin"]},
        "usage": usage_status(user["id"], user["plan"]),
        "plans": PLANS
    })

@app.get("/api/conversations")
@login_required
def conversations():
    user = current_user()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id,title,updated_at FROM evil_conversations
                WHERE user_id=%s ORDER BY updated_at DESC LIMIT 50
            """, (user["id"],))
            rows = cur.fetchall()
    return jsonify({"conversations": [
        {"id": str(r["id"]), "title": r["title"], "updatedAt": r["updated_at"].isoformat()}
        for r in rows
    ]})

@app.get("/api/conversations/<uuid:conversation_id>")
@login_required
def get_conversation(conversation_id):
    user = current_user()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id,title FROM evil_conversations WHERE id=%s AND user_id=%s
            """, (str(conversation_id), user["id"]))
            conv = cur.fetchone()
            if not conv:
                return jsonify({"error": "Conversation not found."}), 404
            cur.execute("""
                SELECT role,content,created_at FROM evil_messages
                WHERE conversation_id=%s AND user_id=%s ORDER BY id
            """, (str(conversation_id), user["id"]))
            msgs = cur.fetchall()
    return jsonify({"conversation": {"id": str(conv["id"]), "title": conv["title"]},
                     "messages": [{"role":m["role"],"content":m["content"]} for m in msgs]})

@app.post("/ask")
@login_required
def ask():
    if not OPENAI_API_KEY:
        return jsonify({"error": "AI service is not configured. Add OPENAI_API_KEY in Render."}), 503
    data = request.get_json(silent=True) or {}
    question = str(data.get("question", "")).strip()
    conv_id = data.get("conversationId")
    use_web = bool(data.get("webSearch", False))
    if not question or len(question) > 12000:
        return jsonify({"error": "Enter a message up to 12,000 characters."}), 400
    user = current_user()
    status = usage_status(user["id"], user["plan"])
    if status["remaining"] <= 0:
        return jsonify({"error": "You've reached this month's message limit. Choose a plan to request an upgrade.", "usage": status}), 429
    try:
        with db() as conn:
            with conn.cursor() as cur:
                if conv_id:
                    cur.execute("SELECT id FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conv_id), user["id"]))
                    conv = cur.fetchone()
                    if not conv:
                        return jsonify({"error": "Conversation not found."}), 404
                    conv_id = str(conv["id"])
                else:
                    conv_id = str(uuid.uuid4())
                    title = question[:70].strip() or "New conversation"
                    cur.execute("""
                        INSERT INTO evil_conversations(id,user_id,title) VALUES (%s,%s,%s)
                    """, (conv_id, user["id"], title))
                cur.execute("""
                    SELECT role,content FROM evil_messages
                    WHERE conversation_id=%s AND user_id=%s ORDER BY id DESC LIMIT 16
                """, (conv_id, user["id"]))
                history = list(reversed(cur.fetchall()))
        input_items = [{"role": m["role"], "content": m["content"]} for m in history]
        input_items.append({"role": "user", "content": question})
        tools = [{"type": "web_search"}] if use_web else []
        client = OpenAI(api_key=OPENAI_API_KEY)
        response = client.responses.create(
            model=OPENAI_MODEL,
            instructions="You are Evil GPT Assistant, a helpful, accurate, safe AI assistant. Be clear about uncertainty. Do not claim to have performed actions you have not performed.",
            input=input_items,
            tools=tools or None,
        )
        answer = (response.output_text or "").strip()
        if not answer:
            answer = "I couldn't produce a response. Please try again."
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO evil_messages(conversation_id,user_id,role,content)
                    VALUES (%s,%s,'user',%s),(%s,%s,'assistant',%s)
                """, (conv_id,user["id"],question,conv_id,user["id"],answer))
                cur.execute("UPDATE evil_conversations SET updated_at=NOW() WHERE id=%s", (conv_id,))
                month = datetime.now(timezone.utc).strftime("%Y-%m")
                cur.execute("""
                    INSERT INTO evil_usage(user_id,usage_month,message_count)
                    VALUES (%s,%s,1)
                    ON CONFLICT (user_id,usage_month)
                    DO UPDATE SET message_count=evil_usage.message_count+1
                """, (user["id"],month))
        return jsonify({"answer": answer, "conversationId": conv_id,
                        "usage": usage_status(user["id"], user["plan"])})
    except Exception as exc:
        app.logger.exception("AI request failed")
        return jsonify({"error": "The AI request failed. Check your model setting and API account, then try again."}), 502

@app.post("/api/upgrade")
@login_required
def upgrade_request():
    data = request.get_json(silent=True) or {}
    plan = str(data.get("plan", ""))
    if plan not in PLANS or plan == "free":
        return jsonify({"error": "Choose a valid paid plan."}), 400
    user = current_user()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO evil_payment_requests(user_id,plan,amount_ngn)
                VALUES (%s,%s,%s)
            """, (user["id"],plan,PLANS[plan]["price"]))
    return jsonify({"success": True, "message": "Upgrade request submitted for admin review. No payment has been verified yet."})

@app.get("/api/admin/users")
@login_required
@admin_required
def admin_users():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT u.id,u.username,u.email,u.plan,
                  (SELECT p.plan FROM evil_payment_requests p WHERE p.user_id=u.id AND p.status='pending' ORDER BY p.id DESC LIMIT 1) AS requested_plan
                FROM evil_users u WHERE u.is_admin=FALSE ORDER BY u.created_at DESC LIMIT 200
            """)
            users = cur.fetchall()
    return jsonify({"users": [dict(r) for r in users]})

@app.post("/api/admin/approve/<int:user_id>")
@login_required
@admin_required
def admin_approve(user_id):
    data = request.get_json(silent=True) or {}
    plan = str(data.get("plan", ""))
    if plan not in PLANS or plan == "free":
        return jsonify({"error": "Invalid plan."}), 400
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE evil_users SET plan=%s WHERE id=%s AND is_admin=FALSE", (plan,user_id))
            if cur.rowcount == 0:
                return jsonify({"error": "User not found."}), 404
            cur.execute("""
                UPDATE evil_payment_requests SET status='approved'
                WHERE user_id=%s AND status='pending'
            """, (user_id,))
    return jsonify({"success": True})

@app.post("/api/admin/announcement")
@login_required
@admin_required
def announcement():
    data = request.get_json(silent=True) or {}
    message = str(data.get("message", "")).strip()
    if not message or len(message) > 2000:
        return jsonify({"error": "Announcement must be 1–2,000 characters."}), 400
    user = current_user()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO evil_announcements(admin_user_id,message) VALUES (%s,%s)", (user["id"],message))
    return jsonify({"success": True})

@app.get("/api/announcements")
@login_required
def get_announcements():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT message,created_at FROM evil_announcements ORDER BY id DESC LIMIT 10")
            rows = cur.fetchall()
    return jsonify({"announcements": [{"message":r["message"],"createdAt":r["created_at"].isoformat()} for r in rows]})

@app.before_request
def initialize_database_once():
    if not getattr(app, "_db_initialized", False):
        ensure_db()
        app._db_initialized = True
