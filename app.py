import os
import re
import uuid
from datetime import datetime, timezone
from functools import wraps

import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, render_template, request, jsonify, session, Response, stream_with_context
from werkzeug.security import generate_password_hash, check_password_hash
from openai import OpenAI
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY")
if not app.secret_key:
    raise RuntimeError("SECRET_KEY is missing. Set it in Render Environment.")

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_SAMESITE="Lax",
    MAX_CONTENT_LENGTH=6 * 1024 * 1024,
)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[],
    storage_uri="memory://",
)

DATABASE_URL = os.environ.get("DATABASE_URL")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama3-70b-8192")
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

PROMPT_LIBRARY = [
    {"category": "Writing", "text": "Rewrite this paragraph to be clearer and shorter:"},
    {"category": "Writing", "text": "Write a professional email declining a meeting politely."},
    {"category": "Coding", "text": "Explain this code line by line:"},
    {"category": "Coding", "text": "Debug this Python error and suggest a fix:"},
    {"category": "Learning", "text": "Explain quantum computing like I'm 12 years old."},
    {"category": "Learning", "text": "Give me a 5-point summary of the following text:"},
    {"category": "Productivity", "text": "Create a weekly plan to learn a new skill in 30 days."},
    {"category": "Productivity", "text": "Turn these notes into a clean to-do list:"},
    {"category": "Career", "text": "Write a cover letter for this job description:"},
    {"category": "Career", "text": "Review my CV and suggest improvements:"},
]

SURPRISE_PROMPTS = [
    "Explain a complex idea using a simple analogy.",
    "Give me three unusual questions I could ask about this topic:",
    "Summarize the key idea behind quantum entanglement in plain English.",
    "Write a short story where the main character is a confused AI.",
    "What is a common misconception people have about money?",
    "Suggest a 20-minute learning activity for today.",
    "Write a haiku about deadlines.",
    "Explain why sleep matters in three sentences.",
]

PERSONAS = {
    "assistant": {
        "name": "Assistant",
        "instructions": (
            "You are Evil GPT Assistant, a helpful, accurate, safe AI assistant. "
            "Be clear about uncertainty. Do not claim to have performed actions you have not performed. "
            "Reply in the same language the user writes in."
        ),
    },
    "tutor": {
        "name": "Tutor",
        "instructions": (
            "You are a patient tutor. Explain step by step, ask one checking question at the end, "
            "and adapt to the learner's level. Reply in the same language the user writes in."
        ),
    },
    "code_reviewer": {
        "name": "Code reviewer",
        "instructions": (
            "You are a senior code reviewer. Point out bugs, style issues, and security risks. "
            "Show corrected code when helpful. Reply in the same language the user writes in."
        ),
    },
    "business_advisor": {
        "name": "Business advisor",
        "instructions": (
            "You are a pragmatic business advisor. Give concrete next steps, numbers where possible, "
            "and flag risks. Reply in the same language the user writes in."
        ),
    },
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
                    pinned BOOLEAN NOT NULL DEFAULT FALSE,
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
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_reports (
                    id BIGSERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE,
                    conversation_id UUID,
                    message TEXT,
                    reason VARCHAR(60),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_shares (
                    token VARCHAR(40) PRIMARY KEY,
                    conversation_id UUID NOT NULL REFERENCES evil_conversations(id) ON DELETE CASCADE,
                    user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_payment_settings (
                    id INT PRIMARY KEY DEFAULT 1,
                    account_name VARCHAR(120) NOT NULL,
                    account_number VARCHAR(40) NOT NULL,
                    bank_name VARCHAR(80) NOT NULL,
                    extra_note TEXT,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                INSERT INTO evil_payment_settings(id, account_name, account_number, bank_name, extra_note)
                VALUES (1, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
            """, (
                "Daniel Dominion Folorunso",
                "8100481004",
                "Moniepoint",
                "Send the exact plan amount, then upload your payment screenshot below."
            ))
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evil_payment_proofs (
                    id BIGSERIAL PRIMARY KEY,
                    payment_request_id BIGINT NOT NULL REFERENCES evil_payment_requests(id) ON DELETE CASCADE,
                    user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE,
                    filename VARCHAR(200) NOT NULL,
                    mimetype VARCHAR(80) NOT NULL,
                    data BYTEA NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            if ADMIN_USERNAME and ADMIN_PASSWORD:
                cur.execute("SELECT id FROM evil_users WHERE username=%s", (ADMIN_USERNAME,))
                row = cur.fetchone()
                if row:
                    cur.execute("UPDATE evil_users SET is_admin=TRUE WHERE username=%s", (ADMIN_USERNAME,))
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

def persona_instructions(persona_key):
    return PERSONAS.get(persona_key, PERSONAS["assistant"])["instructions"]

@app.errorhandler(429)
def ratelimit_handler(e):
    return jsonify({
        "error": "You're going a bit fast — wait a moment and try again.",
        "retry_after": getattr(e, "retry_after", None),
    }), 429

@app.route("/")
def index():
    return render_template("index.html")

@app.get("/privacy")
def privacy_page():
    return render_template("privacy.html")

@app.get("/terms")
def terms_page():
    return render_template("terms.html")

@app.get("/changelog")
def changelog_page():
    return render_template("changelog.html")

@app.get("/api/version")
def version():
    return jsonify({"name": "Evil GPT", "version": "1.2.0"})

@app.get("/api/health")
def health():
    try:
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        return jsonify({"ok": True, "database": "connected"})
    except Exception:
        return jsonify({"ok": False, "database": "unavailable"}), 503

@app.get("/api/prompts")
def prompts():
    return jsonify({"prompts": PROMPT_LIBRARY})

@app.get("/api/personas")
def personas():
    return jsonify({"personas": [{"key": k, "name": v["name"]} for k, v in PERSONAS.items()]})

@app.get("/api/surprise")
def surprise_prompt():
    import random
    return jsonify({"prompt": random.choice(SURPRISE_PROMPTS)})

@app.post("/register")
@limiter.limit("5 per hour")
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
@limiter.limit("20 per hour")
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
                SELECT id,title,updated_at,pinned FROM evil_conversations
                WHERE user_id=%s ORDER BY pinned DESC, updated_at DESC LIMIT 50
            """, (user["id"],))
            rows = cur.fetchall()
    return jsonify({"conversations": [
        {"id": str(r["id"]), "title": r["title"], "updatedAt": r["updated_at"].isoformat(), "pinned": r["pinned"]}
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

@app.post("/api/conversations/<uuid:conversation_id>/pin")
@login_required
def pin_conversation(conversation_id):
    user = current_user()
    data = request.get_json(silent=True) or {}
    pinned = bool(data.get("pinned", True))
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE evil_conversations SET pinned=%s
                WHERE id=%s AND user_id=%s
            """, (pinned, str(conversation_id), user["id"]))
            if cur.rowcount == 0:
                return jsonify({"error": "Conversation not found."}), 404
    return jsonify({"success": True, "pinned": pinned})

def _run_ai(conv_id, user, question, persona, is_continue=False):
    with db() as conn:
        with conn.cursor() as cur:
            if conv_id:
                cur.execute("SELECT id FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conv_id), user["id"]))
                conv = cur.fetchone()
                if not conv:
                    return None, None, "Conversation not found."
                conv_id = str(conv["id"])
            else:
                conv_id = str(uuid.uuid4())
                title = (question[:70].strip() or "New conversation")
                cur.execute("INSERT INTO evil_conversations(id,user_id,title) VALUES (%s,%s,%s)", (conv_id, user["id"], title))
            cur.execute("""
                SELECT role,content FROM evil_messages
                WHERE conversation_id=%s AND user_id=%s ORDER BY id DESC LIMIT 16
            """, (conv_id, user["id"]))
            history = list(reversed(cur.fetchall()))

    input_items = [{"role": m["role"], "content": m["content"]} for m in history]
    if is_continue:
        input_items.append({"role": "user", "content": "Please continue exactly where you stopped. Do not repeat the previous text."})
    else:
        input_items.append({"role": "user", "content": question})

    client = OpenAI(api_key=OPENAI_API_KEY)
    response = client.responses.create(
        model=OPENAI_MODEL,
        instructions=persona_instructions(persona),
        input=input_items,
    )
    answer = (response.output_text or "").strip() or "I couldn't produce a response. Please try again."
    return conv_id, answer, None

@app.post("/ask")
@login_required
@limiter.limit("10 per minute")
def ask():
    if not OPENAI_API_KEY:
        return jsonify({"error": "AI service is not configured. Add OPENAI_API_KEY in Render."}), 503
    data = request.get_json(silent=True) or {}
    question = str(data.get("question", "")).strip()
    conv_id = data.get("conversationId")
    persona = str(data.get("persona", "assistant"))
    is_continue = bool(data.get("continue", False))
    if not is_continue and (not question or len(question) > 12000):
        return jsonify({"error": "Enter a message up to 12,000 characters."}), 400
    user = current_user()
    status = usage_status(user["id"], user["plan"])
    if status["remaining"] <= 0:
        return jsonify({"error": "You've reached this month's message limit. Choose a plan to request an upgrade.", "usage": status}), 429
    try:
        conv_id, answer, err = _run_ai(conv_id, user, question, persona, is_continue)
        if err:
            return jsonify({"error": err}), 404
        with db() as conn:
            with conn.cursor() as cur:
                if not is_continue:
                    cur.execute("""
                        INSERT INTO evil_messages(conversation_id,user_id,role,content)
                        VALUES (%s,%s,'user',%s)
                    """, (conv_id, user["id"], question))
                cur.execute("""
                    INSERT INTO evil_messages(conversation_id,user_id,role,content)
                    VALUES (%s,%s,'assistant',%s)
                """, (conv_id, user["id"], answer))
                cur.execute("UPDATE evil_conversations SET updated_at=NOW() WHERE id=%s", (conv_id,))
                month = datetime.now(timezone.utc).strftime("%Y-%m")
                cur.execute("""
                    INSERT INTO evil_usage(user_id,usage_month,message_count)
                    VALUES (%s,%s,1)
                    ON CONFLICT (user_id,usage_month)
                    DO UPDATE SET message_count=evil_usage.message_count+1
                """, (user["id"], month))
        return jsonify({"answer": answer, "conversationId": conv_id,
                        "usage": usage_status(user["id"], user["plan"])})
    except Exception:
        app.logger.exception("AI request failed")
        return jsonify({"error": "The AI request failed. Check your model setting and API account, then try again."}), 502

@app.post("/ask/stream")
@login_required
@limiter.limit("10 per minute")
def ask_stream():
    if not OPENAI_API_KEY:
        return jsonify({"error": "AI service is not configured. Add OPENAI_API_KEY in Render."}), 503
    data = request.get_json(silent=True) or {}
    question = str(data.get("question", "")).strip()
    conv_id = data.get("conversationId")
    persona = str(data.get("persona", "assistant"))
    if not question or len(question) > 12000:
        return jsonify({"error": "Enter a message up to 12,000 characters."}), 400
    user = current_user()
    status = usage_status(user["id"], user["plan"])
    if status["remaining"] <= 0:
        return jsonify({"error": "You've reached this month's message limit.", "usage": status}), 429

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
                cur.execute("INSERT INTO evil_conversations(id,user_id,title) VALUES (%s,%s,%s)", (conv_id, user["id"], title))
            cur.execute("""
                SELECT role,content FROM evil_messages
                WHERE conversation_id=%s AND user_id=%s ORDER BY id DESC LIMIT 16
            """, (conv_id, user["id"]))
            history = list(reversed(cur.fetchall()))

    input_items = [{"role": m["role"], "content": m["content"]} for m in history]
    input_items.append({"role": "user", "content": question})
    client = OpenAI(api_key=OPENAI_API_KEY)

    def generate():
        collected = []
        try:
            with client.responses.stream(
                model=OPENAI_MODEL,
                instructions=persona_instructions(persona),
                input=input_items,
            ) as stream:
                for event in stream:
                    if event.type == "response.output_text.delta":
                        delta = event.delta or ""
                        if delta:
                            collected.append(delta)
                            yield f"data: {delta.replace(chr(10),' ')}\n\n"
            answer = "".join(collected).strip() or "I couldn't produce a response."
            with db() as conn:
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO evil_messages(conversation_id,user_id,role,content) VALUES (%s,%s,'user',%s)", (conv_id, user["id"], question))
                    cur.execute("INSERT INTO evil_messages(conversation_id,user_id,role,content) VALUES (%s,%s,'assistant',%s)", (conv_id, user["id"], answer))
                    cur.execute("UPDATE evil_conversations SET updated_at=NOW() WHERE id=%s", (conv_id,))
                    month = datetime.now(timezone.utc).strftime("%Y-%m")
                    cur.execute("""
                        INSERT INTO evil_usage(user_id,usage_month,message_count)
                        VALUES (%s,%s,1)
                        ON CONFLICT (user_id,usage_month)
                        DO UPDATE SET message_count=evil_usage.message_count+1
                    """, (user["id"], month))
        except Exception:
            app.logger.exception("Stream failed")
            yield "data: [ERROR]\n\n"
            return
        yield f"data: [DONE:{conv_id}]\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.post("/api/report")
@login_required
def report_response():
    data = request.get_json(silent=True) or {}
    user = current_user()
    reason = str(data.get("reason", ""))[:60]
    message = str(data.get("message", ""))[:4000]
    conv_id = data.get("conversationId")
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO evil_reports(user_id, conversation_id, message, reason)
                VALUES (%s,%s,%s,%s)
            """, (user["id"], str(conv_id) if conv_id else None, message, reason))
    return jsonify({"success": True})

@app.get("/api/conversations/<uuid:conversation_id>/export")
@login_required
def export_conversation(conversation_id):
    user = current_user()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT title FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), user["id"]))
            conv = cur.fetchone()
            if not conv:
                return jsonify({"error": "Conversation not found."}), 404
            cur.execute("SELECT role,content FROM evil_messages WHERE conversation_id=%s AND user_id=%s ORDER BY id", (str(conversation_id), user["id"]))
            msgs = cur.fetchall()
    lines = [f"# {conv['title']}\n"]
    for m in msgs:
        who = "You" if m["role"] == "user" else "Evil GPT"
        lines.append(f"**{who}:**\n{m['content']}\n")
    return Response("\n".join(lines), mimetype="text/markdown")

@app.post("/api/conversations/<uuid:conversation_id>/delete")
@login_required
def delete_conversation(conversation_id):
    user = current_user()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), user["id"]))
            if cur.rowcount == 0:
                return jsonify({"error": "Conversation not found."}), 404
    return jsonify({"success": True})

@app.post("/api/conversations/<uuid:conversation_id>/share")
@login_required
def share_conversation(conversation_id):
    user = current_user()
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), user["id"]))
            if not cur.fetchone():
                return jsonify({"error": "Conversation not found."}), 404
            token = uuid.uuid4().hex[:24]
            cur.execute("INSERT INTO evil_shares(token,conversation_id,user_id) VALUES (%s,%s,%s)", (token, str(conversation_id), user["id"]))
    return jsonify({"success": True, "token": token})

@app.get("/share/<token>")
def view_share(token):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.conversation_id, c.title
                FROM evil_shares s JOIN evil_conversations c ON c.id = s.conversation_id
                WHERE s.token=%s
            """, (token,))
            row = cur.fetchone()
            if not row:
                return "Shared conversation not found.", 404
            cur.execute("SELECT role,content FROM evil_messages WHERE conversation_id=%s ORDER BY id", (str(row["conversation_id"]),))
            msgs = cur.fetchall()
    return render_template("share.html", title=row["title"], messages=msgs)

@app.get("/api/payment-info")
@login_required
def payment_info():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT account_name, account_number, bank_name, extra_note FROM evil_payment_settings WHERE id=1")
            row = cur.fetchone()
    return jsonify({"payment": dict(row) if row else None})

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
                VALUES (%s,%s,%s) RETURNING id
            """, (user["id"], plan, PLANS[plan]["price"]))
            request_id = cur.fetchone()["id"]
    return jsonify({"success": True, "requestId": request_id, "amount": PLANS[plan]["price"],
                    "message": "Upgrade request created. Pay the amount, then upload your screenshot."})

@app.post("/api/payment-proof/<int:request_id>")
@login_required
def upload_payment_proof(request_id):
    user = current_user()
    if "screenshot" not in request.files:
        return jsonify({"error": "No file uploaded."}), 400
    file = request.files["screenshot"]
    if not file or not file.filename:
        return jsonify({"error": "Empty file."}), 400
    allowed = {"image/png", "image/jpeg", "image/webp"}
    if file.mimetype not in allowed:
        return jsonify({"error": "Upload a PNG, JPG, or WEBP image."}), 400
    data = file.read()
    if len(data) > 5 * 1024 * 1024:
        return jsonify({"error": "Screenshot must be under 5 MB."}), 400
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM evil_payment_requests WHERE id=%s AND user_id=%s AND status='pending'", (request_id, user["id"]))
            if not cur.fetchone():
                return jsonify({"error": "Payment request not found or already handled."}), 404
            cur.execute("""
                INSERT INTO evil_payment_proofs(payment_request_id,user_id,filename,mimetype,data)
                VALUES (%s,%s,%s,%s,%s)
            """, (request_id, user["id"], file.filename, file.mimetype, psycopg2.Binary(data)))
    return jsonify({"success": True, "message": "Screenshot received. An admin will review it."})

@app.get("/api/admin/payment-proof/<int:proof_id>")
@login_required
@admin_required
def admin_get_proof(proof_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT filename, mimetype, data FROM evil_payment_proofs WHERE id=%s", (proof_id,))
            row = cur.fetchone()
    if not row:
        return jsonify({"error": "Not found."}), 404
    return Response(row["data"], mimetype=row["mimetype"],
                    headers={"Content-Disposition": f"inline; filename={row['filename']}"})

@app.get("/api/admin/payment-requests")
@login_required
@admin_required
def admin_payment_requests():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT pr.id, pr.user_id, u.username, u.email, pr.plan, pr.amount_ngn,
                       pr.status, pr.created_at,
                       (SELECT id FROM evil_payment_proofs p
                        WHERE p.payment_request_id=pr.id ORDER BY p.id DESC LIMIT 1) AS proof_id
                FROM evil_payment_requests pr
                JOIN evil_users u ON u.id = pr.user_id
                ORDER BY pr.created_at DESC LIMIT 200
            """)
            rows = cur.fetchall()
    return jsonify({"requests": [dict(r) for r in rows]})

@app.post("/api/admin/reject/<int:request_id>")
@login_required
@admin_required
def admin_reject(request_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE evil_payment_requests SET status='rejected' WHERE id=%s AND status='pending'", (request_id,))
            if cur.rowcount == 0:
                return jsonify({"error": "Request not found or already handled."}), 404
    return jsonify({"success": True})

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
            cur.execute("UPDATE evil_payment_requests SET status='approved' WHERE user_id=%s AND status='pending'", (user_id,))
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
