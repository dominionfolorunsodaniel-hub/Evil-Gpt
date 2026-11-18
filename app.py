"""Vyra AI backend (Flask + Postgres + Groq).

Upgraded from the Evil GPT codebase. Every original feature is kept:
chat (Deep/Fast), personas, custom persona, Image Studio, plans, daily check-in,
leaderboard, notifications, email-code verification with admin approval, 2-day trial,
admin console (users / payments / OTPs / broadcast), payment proof upload.
"""
import os, re, io, json, uuid, hmac, hashlib, secrets, logging, smtplib, threading, time
from urllib.parse import quote
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from functools import wraps
from contextlib import contextmanager

import psycopg2
import psycopg2.pool
import psycopg2.errors
import requests
from psycopg2.extras import RealDictCursor
from flask import (Flask, render_template, request, jsonify, session, Response,
                   stream_with_context, send_from_directory, abort, redirect)
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from openai import OpenAI

BRAND = "Vyra AI"
log = logging.getLogger("vyra")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # real client IP behind Render's proxy
_secret = os.environ.get("SECRET_KEY")
if not _secret:
    _secret = secrets.token_hex(32)
    log.warning("SECRET_KEY is not set: using a random key. Everyone is signed out on every restart. Set SECRET_KEY in Render.")
app.secret_key = _secret
IS_PROD = bool(os.environ.get("RENDER")) or os.environ.get("FORCE_SECURE_COOKIES") == "1"
app.config.update(
    SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SECURE=IS_PROD, SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_NAME="vyra_session", PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,
    MAX_CONTENT_LENGTH=8 * 1024 * 1024, JSON_SORT_KEYS=False,
)

DATABASE_URL = os.environ.get("DATABASE_URL")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_FAST_MODEL = os.environ.get("GROQ_FAST_MODEL", "llama-3.1-8b-instant")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
SMTP_EMAIL = os.environ.get("SMTP_EMAIL")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD")
BREVO_API_KEY = os.environ.get("BREVO_API_KEY")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
MAIL_FROM = os.environ.get("MAIL_FROM") or SMTP_EMAIL
MAIL_FROM_NAME = os.environ.get("MAIL_FROM_NAME", BRAND)
SITE_URL = (os.environ.get("SITE_URL") or "").rstrip("/")
PAYSTACK_SECRET_KEY = os.environ.get("PAYSTACK_SECRET_KEY")
CUSTOM_PERSONA_FREE = os.environ.get("CUSTOM_PERSONA_FREE") == "1"  # set to 1 to let Free users use custom personas
TRIAL_DAYS = int(os.environ.get("TRIAL_DAYS", "2"))
PLAN_DAYS = int(os.environ.get("PLAN_DAYS", "30"))
MAX_MESSAGE_CHARS = 8000

# Plans are unchanged from Evil GPT (same names, prices and limits).
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
PLAN_ORDER = list(PLANS.keys())

DAILY_PROMPTS = [
    "What is a small habit that has a huge impact?",
    "Explain a concept using only simple words.",
    "Write a short poem about AI.",
    "Teach me one useful thing about money in 5 minutes.",
    "Help me plan my week in 3 priorities.",
    "Give me a 10-minute workout I can do at home.",
    "Explain how the internet works like I'm 12.",
]
PERSONAS = {
    "assistant": {"name": "Assistant", "instructions": f"You are {BRAND}, a helpful, accurate and friendly AI assistant. Be clear and concise. Say so when you are unsure."},
    "tutor": {"name": "Tutor", "instructions": f"You are {BRAND} in tutor mode. Teach patiently, step by step, check understanding, and use simple examples."},
    "code_reviewer": {"name": "Code reviewer", "instructions": f"You are {BRAND} in code reviewer mode: a senior engineer. Find bugs, explain why, and show fixed code."},
    "writer": {"name": "Writer", "instructions": f"You are {BRAND} in writing mode. Help draft, edit and polish writing in a clear natural voice."},
    "business": {"name": "Business advisor", "instructions": f"You are {BRAND} in business advisor mode. Give practical, realistic advice for small businesses, with Nigerian market context when relevant."},
}
SUGGESTIONS = [
    {"icon": "book", "title": "Learn something", "prompt": "Explain a difficult topic to me in simple steps. Ask me which topic first."},
    {"icon": "code", "title": "Fix my code", "prompt": "Help me debug some code. I'll paste it next. Explain the problem and the fix."},
    {"icon": "pen", "title": "Improve my writing", "prompt": "Help me improve a piece of writing. I'll paste it next."},
    {"icon": "briefcase", "title": "Plan a business idea", "prompt": "Help me turn a business idea into a simple plan. Ask me about the idea first."},
]

LANGUAGES = {"English": "", "Nigerian Pidgin": "Reply in Nigerian Pidgin English.", "Yoruba": "Reply in Yoruba.", "Hausa": "Reply in Hausa.", "Igbo": "Reply in Igbo."}

# ----------------------------------------------------------------------------- database
_pool = None
_pool_lock = threading.Lock()
TODAY = "(NOW() AT TIME ZONE 'Africa/Lagos')::date"  # streaks and daily limits roll over at midnight Nigerian time


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                if not DATABASE_URL:
                    raise RuntimeError("DATABASE_URL is not set")
                _pool = psycopg2.pool.ThreadedConnectionPool(
                    1, int(os.environ.get("DB_POOL_MAX", "6")), DATABASE_URL, sslmode=os.environ.get("DB_SSLMODE", "require"),
                    cursor_factory=RealDictCursor, connect_timeout=10)
    return _pool


@contextmanager
def db():
    """Pooled connection. Commits on success, rolls back on error. Replaces dead Neon connections."""
    pool = _get_pool()
    conn = pool.getconn()
    if time.time() - getattr(conn, "_vyra_last", 0) > 20:  # idle a while: make sure Neon didn't close it
        try:
            with conn.cursor() as c: c.execute("SELECT 1")
            conn.rollback()
        except Exception:
            pool.putconn(conn, close=True)
            conn = pool.getconn()
    bad = False
    try:
        yield conn
        conn.commit()
    except Exception:
        try: conn.rollback()
        except Exception: bad = True
        raise
    finally:
        conn._vyra_last = time.time()
        pool.putconn(conn, close=bad or bool(conn.closed))


def q_one(sql, params=None):
    with db() as conn, conn.cursor() as cur:
        cur.execute(sql, params); return cur.fetchone()


def q_all(sql, params=None):
    with db() as conn, conn.cursor() as cur:
        cur.execute(sql, params); return cur.fetchall()


def q_run(sql, params=None):
    with db() as conn, conn.cursor() as cur:
        cur.execute(sql, params); return cur.rowcount


def iso(v):
    if v is None: return None
    return v if isinstance(v, str) else v.isoformat()


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS evil_users (
        id BIGSERIAL PRIMARY KEY, username VARCHAR(40) UNIQUE NOT NULL, email VARCHAR(254) UNIQUE NOT NULL,
        password_hash TEXT, plan VARCHAR(32) NOT NULL DEFAULT 'free', is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        is_verified BOOLEAN DEFAULT FALSE, trial_ends_at TIMESTAMPTZ, bonus_messages INTEGER DEFAULT 0,
        streak_count INTEGER DEFAULT 0, last_streak_date DATE, images_generated_today INTEGER DEFAULT 0,
        last_image_date DATE, custom_persona TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "CREATE TABLE IF NOT EXISTS evil_conversations (id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, title VARCHAR(160) NOT NULL DEFAULT 'New conversation', pinned BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_messages (id BIGSERIAL PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES evil_conversations(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, role VARCHAR(16) NOT NULL, content TEXT NOT NULL, attachment_type VARCHAR(20), attachment_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_usage (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, usage_month VARCHAR(7) NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, usage_month))",
    "CREATE TABLE IF NOT EXISTS evil_payment_requests (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, plan VARCHAR(32) NOT NULL, amount_ngn INTEGER NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_payment_settings (id INT PRIMARY KEY DEFAULT 1, account_name VARCHAR(120) NOT NULL, account_number VARCHAR(40) NOT NULL, bank_name VARCHAR(80) NOT NULL, extra_note TEXT)",
    "CREATE TABLE IF NOT EXISTS evil_payment_proofs (id BIGSERIAL PRIMARY KEY, payment_request_id BIGINT NOT NULL REFERENCES evil_payment_requests(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, filename VARCHAR(200) NOT NULL, mimetype VARCHAR(80) NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_otp_requests (id BIGSERIAL PRIMARY KEY, email VARCHAR(254) NOT NULL, code VARCHAR(6) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_notifications (id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES evil_users(id) ON DELETE CASCADE, message TEXT NOT NULL, is_read BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    # ---- new in Vyra AI (all additive, nothing existing is changed) ----
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12)",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS referred_by BIGINT",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS welcome_sent BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ",
    "CREATE UNIQUE INDEX IF NOT EXISTS evil_users_referral_code_idx ON evil_users(referral_code)",
    "ALTER TABLE evil_conversations ADD COLUMN IF NOT EXISTS share_token VARCHAR(40)",
    "CREATE UNIQUE INDEX IF NOT EXISTS evil_conversations_share_idx ON evil_conversations(share_token) WHERE share_token IS NOT NULL",
    "ALTER TABLE evil_messages ADD COLUMN IF NOT EXISTS feedback SMALLINT",
    "ALTER TABLE evil_otp_requests ADD COLUMN IF NOT EXISTS purpose VARCHAR(12) NOT NULL DEFAULT 'verify'",
    "ALTER TABLE evil_otp_requests ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE evil_payment_requests ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'bank'",
    "ALTER TABLE evil_payment_requests ADD COLUMN IF NOT EXISTS reference VARCHAR(80)",
    "CREATE UNIQUE INDEX IF NOT EXISTS evil_payreq_ref_idx ON evil_payment_requests(reference) WHERE reference IS NOT NULL",
    "ALTER TABLE evil_payment_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ",
    "CREATE TABLE IF NOT EXISTS evil_images (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, prompt TEXT NOT NULL, url TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_login_attempts (id BIGSERIAL PRIMARY KEY, username VARCHAR(80), ip VARCHAR(64), success BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS evil_login_attempts_idx ON evil_login_attempts(username, ip, created_at)",
    "CREATE TABLE IF NOT EXISTS evil_rate_limits (key VARCHAR(160) NOT NULL, bucket BIGINT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(key, bucket))",
    "CREATE TABLE IF NOT EXISTS evil_audit_log (id BIGSERIAL PRIMARY KEY, actor VARCHAR(40), action VARCHAR(60) NOT NULL, detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_awards (week_key VARCHAR(10) PRIMARY KEY, awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), detail TEXT)",
    "CREATE TABLE IF NOT EXISTS evil_settings (key VARCHAR(40) PRIMARY KEY, value TEXT NOT NULL)",
]
_db_ready = False
_db_lock = threading.Lock()


def init_db():
    global _db_ready
    if _db_ready: return
    with _db_lock:
        if _db_ready: return
        for attempt in (1, 2):
            try:
                with db() as conn, conn.cursor() as cur:
                    cur.execute("SELECT pg_advisory_xact_lock(724001)")  # two workers booting at once must not collide
                    for stmt in SCHEMA: cur.execute(stmt)
                    # Bank details come from env vars now. An existing row in the database is never touched.
                    name, number, bank = os.environ.get("PAYMENT_ACCOUNT_NAME"), os.environ.get("PAYMENT_ACCOUNT_NUMBER"), os.environ.get("PAYMENT_BANK_NAME")
                    if name and number and bank:
                        cur.execute("INSERT INTO evil_payment_settings(id,account_name,account_number,bank_name,extra_note) VALUES (1,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING",
                                    (name, number, bank, os.environ.get("PAYMENT_NOTE", "Upload your payment screenshot after paying.")))
                    if ADMIN_USERNAME and ADMIN_PASSWORD:
                        cur.execute("SELECT id FROM evil_users WHERE username=%s", (ADMIN_USERNAME,))
                        if not cur.fetchone():
                            cur.execute("INSERT INTO evil_users(username,email,password_hash,plan,is_admin,is_verified) VALUES (%s,%s,%s,'infinity',TRUE,TRUE)",
                                        (ADMIN_USERNAME, (ADMIN_USERNAME.lower() + "@admin.invalid")[:254], generate_password_hash(ADMIN_PASSWORD)))
                    # Everyone gets a referral code.
                    cur.execute("SELECT id FROM evil_users WHERE referral_code IS NULL")
                    for r in cur.fetchall():
                        cur.execute("UPDATE evil_users SET referral_code=%s WHERE id=%s", (new_referral_code(), r["id"]))
                    # One-time fix: the old signup gave every new user the permanent 'infinity' plan with only a 2-day trial.
                    # Downgrade expired-trial accounts that never had an approved payment. Paid and admin accounts are untouched.
                    cur.execute("SELECT 1 FROM evil_settings WHERE key='migration_trial_fix'")
                    if not cur.fetchone():
                        cur.execute("""UPDATE evil_users u SET plan='free' WHERE plan='infinity' AND is_admin=FALSE AND trial_ends_at IS NOT NULL
                                       AND trial_ends_at < NOW() AND NOT EXISTS (SELECT 1 FROM evil_payment_requests p WHERE p.user_id=u.id AND p.status='approved')""")
                        log.info("Trial fix migration: downgraded %s expired-trial accounts to Free", cur.rowcount)
                        cur.execute("INSERT INTO evil_settings(key,value) VALUES ('migration_trial_fix','done')")
                _db_ready = True
                return
            except Exception:
                log.exception("Database init failed (attempt %s)", attempt)
                if attempt == 2: raise
                time.sleep(1)


def new_referral_code():
    return "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(7))


def audit(actor, action, detail=""):
    try: q_run("INSERT INTO evil_audit_log(actor,action,detail) VALUES (%s,%s,%s)", (actor, action, str(detail)[:500]))
    except Exception: log.exception("audit failed")


# ----------------------------------------------------------------------------- helpers
def err(msg, code=400, **extra):
    return jsonify({"error": msg, **extra}), code


def body():
    return request.get_json(silent=True) or {}


def client_ip():
    return (request.remote_addr or "unknown")[:64]


def rate_limit(key, limit, window):
    """Postgres-backed limiter: correct across gunicorn workers and survives restarts. Returns True if allowed."""
    bucket = int(time.time() // window)
    try:
        row = q_one("INSERT INTO evil_rate_limits(key,bucket,hits) VALUES (%s,%s,1) ON CONFLICT (key,bucket) DO UPDATE SET hits=evil_rate_limits.hits+1 RETURNING hits", (key[:160], bucket))
        if secrets.randbelow(200) == 0:
            q_run("DELETE FROM evil_rate_limits WHERE bucket < %s", (bucket - 2000,))
        return row["hits"] <= limit
    except Exception:
        log.exception("rate limiter failed open")
        return True


def limited(name, limit, window, per="ip"):
    """Decorator: limit requests per IP (or per signed-in user)."""
    def deco(fn):
        @wraps(fn)
        def wrapped(*a, **kw):
            who = client_ip() if per == "ip" else f"u{session.get('user_id', client_ip())}"
            if not rate_limit(f"{name}:{who}", limit, window):
                return err("You're going too fast. Wait a moment and try again.", 429)
            return fn(*a, **kw)
        return wrapped
    return deco


USER_COLS = """id,username,email,plan,is_admin,is_verified,trial_ends_at,bonus_messages,streak_count,custom_persona,referral_code,is_suspended,
    (trial_ends_at IS NOT NULL AND trial_ends_at > NOW()) AS trial_active,
    (plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS plan_expired,
    plan_expires_at, (last_streak_date = """ + TODAY + """) AS checked_in_today,
    CASE WHEN last_image_date = """ + TODAY + """ THEN images_generated_today ELSE 0 END AS images_today"""


def get_user(user_id):
    return q_one(f"SELECT {USER_COLS} FROM evil_users WHERE id=%s", (user_id,))


def current_user():
    uid = session.get("user_id")
    if not uid: return None
    u = get_user(uid)
    if u and u["is_suspended"]: return None
    return u


def effective_plan(u):
    """The plan that decides limits right now: trial acts as Infinity, an expired paid plan falls back to Free."""
    if u["is_admin"]: return "infinity", False
    plan = u["plan"] if u["plan"] in PLANS else "free"
    if plan != "free" and u["plan_expired"]: plan = "free"
    if u["trial_active"] and PLAN_ORDER.index(plan) < PLAN_ORDER.index("infinity"): return "infinity", True
    return plan, False


def login_required(fn):
    @wraps(fn)
    def wrapped(*a, **kw):
        u = current_user()
        if not u: return err("Please sign in.", 401)
        request.user = u
        return fn(*a, **kw)
    return wrapped


def admin_required(fn):
    @wraps(fn)
    def wrapped(*a, **kw):
        u = current_user()
        if not u: return err("Please sign in.", 401)
        if not u["is_admin"]: return err("Admin only.", 403)
        request.user = u
        return fn(*a, **kw)
    return wrapped


def usage_status(u):
    plan_key, trial = effective_plan(u)
    month = q_one("SELECT to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM') AS m")["m"]
    row = q_one("SELECT message_count FROM evil_usage WHERE user_id=%s AND usage_month=%s", (u["id"], month))
    used = row["message_count"] if row else 0
    if trial: return {"used": used, "limit": 99999, "remaining": 99999, "trial": True, "trialEndsAt": iso(u["trial_ends_at"])}
    limit = PLANS[plan_key]["monthly_messages"] + (u["bonus_messages"] or 0)
    return {"used": used, "limit": limit, "remaining": max(0, limit - used), "trial": False}


# ----------------------------------------------------------------------------- email
def mail_enabled():
    return bool(MAIL_FROM and (BREVO_API_KEY or RESEND_API_KEY or (SMTP_EMAIL and SMTP_PASSWORD)))


def send_mail(to_email, subject, text):
    """Tries Brevo or Resend over HTTPS first (works on Render free). SMTP is the last resort and is blocked on Render free."""
    try:
        if BREVO_API_KEY and MAIL_FROM:
            r = requests.post("https://api.brevo.com/v3/smtp/email", timeout=15, headers={"api-key": BREVO_API_KEY, "accept": "application/json"},
                              json={"sender": {"name": MAIL_FROM_NAME, "email": MAIL_FROM}, "to": [{"email": to_email}], "subject": subject, "textContent": text})
            if r.status_code < 300: return True
            log.error("Brevo error %s %s", r.status_code, r.text[:200])
        if RESEND_API_KEY and MAIL_FROM:
            r = requests.post("https://api.resend.com/emails", timeout=15, headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
                              json={"from": f"{MAIL_FROM_NAME} <{MAIL_FROM}>", "to": [to_email], "subject": subject, "text": text})
            if r.status_code < 300: return True
            log.error("Resend error %s %s", r.status_code, r.text[:200])
        if SMTP_EMAIL and SMTP_PASSWORD:
            msg = MIMEMultipart(); msg["From"], msg["To"], msg["Subject"] = f"{MAIL_FROM_NAME} <{SMTP_EMAIL}>", to_email, subject
            msg.attach(MIMEText(text, "plain"))
            s = smtplib.SMTP("smtp.gmail.com", 587, timeout=10); s.starttls(); s.login(SMTP_EMAIL, SMTP_PASSWORD); s.send_message(msg); s.quit()
            return True
    except Exception:
        log.exception("send_mail failed")
    return False


def send_code(email, code, purpose):
    if purpose == "reset":
        return send_mail(email, f"Reset your {BRAND} password", f"Your {BRAND} password reset code is: {code}\n\nIt expires in 15 minutes. If you didn't ask for this, ignore this email.")
    return send_mail(email, f"Verify your {BRAND} account", f"Welcome to {BRAND}!\n\nYour verification code is: {code}\n\nIt expires in 15 minutes.")


def issue_code(email, purpose):
    """Creates a 6-digit code. With mail configured it is emailed straight away; otherwise it waits for admin approval."""
    code = f"{secrets.randbelow(900000) + 100000}"
    q_run("DELETE FROM evil_otp_requests WHERE email=%s AND purpose=%s", (email, purpose))
    row = q_one("INSERT INTO evil_otp_requests(email,code,status,purpose) VALUES (%s,%s,'pending',%s) RETURNING id", (email, code, purpose))
    if mail_enabled() and send_code(email, code, purpose):
        q_run("UPDATE evil_otp_requests SET status='approved' WHERE id=%s", (row["id"],))
        return "emailed"
    return "admin"


def valid_email(e):
    return len(e) <= 254 and bool(re.fullmatch(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", e))


# ----------------------------------------------------------------------------- security headers / CSRF
@app.before_request
def guard():
    if request.endpoint == "static": return
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path != "/api/paystack/webhook":
        origin = request.headers.get("Origin")
        if origin:
            allowed = {request.host, request.headers.get("Host", ""), request.headers.get("X-Forwarded-Host", ""), SITE_URL.split("://", 1)[-1]}
            if origin.split("://", 1)[-1] not in allowed:
                return err("Blocked cross-site request.", 403)
        elif not request.headers.get("X-Requested-With"):
            return err("Blocked request.", 403)
    if request.path.startswith("/api/") or request.method == "POST":
        try: init_db()
        except Exception:
            return err("Service is waking up. Try again in a few seconds.", 503)


@app.after_request
def headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if resp.mimetype == "text/html":
        resp.headers.setdefault("Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob: https://image.pollinations.ai https://*.pollinations.ai; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
            "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    if request.path.startswith("/api/"): resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"): return err("Not found.", 404)
    return render_template("legal.html", title="Page not found", content="<p>That page doesn't exist.</p>"), 404


@app.errorhandler(413)
def too_big(e): return err("That file is too big. Maximum is 8 MB.", 413)


@app.errorhandler(429)
def ratelimit_handler(e): return err("You're going too fast. Wait a moment and try again.", 429)


@app.errorhandler(500)
def server_error(e):
    log.exception("Unhandled error on %s", request.path)
    return err("Something went wrong on our side. Please try again.", 500)


# ----------------------------------------------------------------------------- pages
@app.route("/")
def index():
    if not session.get("user_id") and not request.args.get("force_login") and not request.args.get("login"):
        return render_template("landing.html", brand=BRAND, plans=PLANS, ref=re.sub(r"[^A-Za-z0-9]", "", request.args.get("ref", ""))[:12])
    ref = re.sub(r"[^A-Za-z0-9]", "", request.args.get("ref", ""))[:12]
    return render_template("index.html", brand=BRAND, ref=ref, paystack=bool(PAYSTACK_SECRET_KEY))


@app.get("/healthz")
def healthz(): return "ok", 200  # no database call: cheap, used by uptime pingers to keep Render awake


@app.get("/api/health")
def health():
    try: q_one("SELECT 1 AS ok"); return jsonify({"ok": True})
    except Exception: return jsonify({"ok": False}), 503


@app.get("/sw.js")
def service_worker():
    r = send_from_directory(app.static_folder, "sw.js", mimetype="application/javascript")
    r.headers["Cache-Control"] = "no-cache"; r.headers["Service-Worker-Allowed"] = "/"
    return r


@app.get("/offline.html")
def offline(): return render_template("offline.html")


@app.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(app.static_folder, "manifest.json", mimetype="application/manifest+json")


LEGAL = {
    "privacy": ("Privacy", """<p class="muted">Last updated: November 2026</p>
<p>We collect only what we need to run Vyra AI: your username, email, a hashed password, your conversations, and monthly message counts.</p>
<h2>What we store</h2><p>Chats are saved so you can come back to them. Usage counts enforce your plan limits. Payment screenshots you upload are visible only to the site administrator.</p>
<h2>What we share</h2><p>Your messages are sent to our AI provider (Groq) to produce replies. Image prompts are sent to an image service. We do not sell your data.</p>
<h2>Your controls</h2><p>You can delete any chat, turn off sharing on a shared chat, download all your data, or delete your account from Settings. Deleting your account permanently removes your chats and details.</p>
<h2>Cookies</h2><p>One session cookie keeps you signed in. No tracking cookies.</p>"""),
    "terms": ("Terms of use", """<p class="muted">Last updated: November 2026</p>
<p>By using Vyra AI you agree to these terms.</p>
<h2>Acceptable use</h2><p>Don't use the service for anything illegal, harmful or abusive, and don't try to break or bypass its limits or safety systems.</p>
<h2>AI can be wrong</h2><p>Replies may be inaccurate. Check anything important, and don't rely on it alone for medical, legal or financial decisions.</p>
<h2>Plans and payment</h2><p>Plans last 30 days. Card payments through Paystack activate your plan automatically. Bank transfers are activated after the administrator confirms your payment. Free trial days and bonus messages have no cash value.</p>
<h2>Suspension</h2><p>We may suspend accounts that break these terms.</p>"""),
}


@app.get("/privacy")
def privacy(): return render_template("legal.html", title=LEGAL["privacy"][0], content=LEGAL["privacy"][1])


@app.get("/terms")
def terms(): return render_template("legal.html", title=LEGAL["terms"][0], content=LEGAL["terms"][1])


@app.get("/changelog")
def changelog(): return render_template("changelog.html")


@app.get("/share/<token>")
def shared_chat(token):
    if not re.fullmatch(r"[A-Za-z0-9_\-]{10,40}", token): abort(404)
    init_db()
    conv = q_one("SELECT id,title FROM evil_conversations WHERE share_token=%s", (token,))
    if not conv: abort(404)
    msgs = q_all("SELECT role,content FROM evil_messages WHERE conversation_id=%s ORDER BY id", (str(conv["id"]),))
    return render_template("share.html", title=conv["title"], messages=msgs, brand=BRAND)


# ----------------------------------------------------------------------------- public data
@app.get("/api/daily-prompt")
def daily_prompt():
    day = (int(time.time()) + 3600) // 86400  # days since 1970 in Nigerian time
    return jsonify({"prompt": DAILY_PROMPTS[day % len(DAILY_PROMPTS)]})


@app.get("/api/personas")
def personas(): return jsonify({"personas": [{"key": k, "name": v["name"]} for k, v in PERSONAS.items()], "suggestions": SUGGESTIONS})


# ----------------------------------------------------------------------------- auth
@app.post("/register")
@limited("register", 8, 3600)
def register():
    d = body()
    username, email, password = str(d.get("username", "")).strip(), str(d.get("email", "")).strip().lower(), str(d.get("password", ""))
    ref = re.sub(r"[^A-Za-z0-9]", "", str(d.get("ref", "")))[:12].upper()
    if not re.fullmatch(r"[A-Za-z0-9_]{3,40}", username): return err("Username must be 3-40 letters, numbers or underscores.")
    if not valid_email(email): return err("Enter a valid email address.")
    if len(password) < 10: return err("Password must be at least 10 characters.")
    if len(password) > 200: return err("Password is too long.")
    referrer = q_one("SELECT id FROM evil_users WHERE referral_code=%s", (ref,)) if ref else None
    try:
        # New users start on the Free plan with a 2-day trial window. (The old code made them Infinity forever.)
        row = q_one("""INSERT INTO evil_users(username,email,password_hash,plan,trial_ends_at,is_verified,referral_code,referred_by)
                       VALUES (%s,%s,%s,'free', NOW() + (%s || ' days')::interval, FALSE, %s, %s) RETURNING id""",
                    (username, email, generate_password_hash(password), str(TRIAL_DAYS), new_referral_code(), referrer["id"] if referrer else None))
    except psycopg2.errors.UniqueViolation:
        return err("That username or email is already taken.", 409)
    except Exception:
        log.exception("register failed"); return err("Registration failed. Please try again.", 500)
    how = issue_code(email, "verify")
    msg = "We emailed you a 6-digit code. Enter it below." if how == "emailed" else "Account created! Your code will arrive once the admin approves your account."
    return jsonify({"success": True, "message": msg, "mode": how})


@app.post("/api/auth/resend-otp")
@limited("resend", 5, 3600)
def resend_otp():
    email = str(body().get("email", "")).strip().lower()
    u = q_one("SELECT is_verified FROM evil_users WHERE email=%s", (email,))
    if u and not u["is_verified"]: issue_code(email, "verify")
    return jsonify({"success": True, "message": "If that account needs verification, a new code is on its way."})


def check_code(email, code, purpose):
    """Returns True if the code is right, approved, and under 15 minutes old. Wrong guesses burn the code after 5 tries."""
    row = q_one("SELECT id,code,status,attempts,(created_at > NOW() - INTERVAL '15 minutes') AS fresh FROM evil_otp_requests WHERE email=%s AND purpose=%s ORDER BY id DESC LIMIT 1", (email, purpose))
    if not row or row["status"] != "approved" or not row["fresh"] or row["attempts"] >= 5: return False
    if not hmac.compare_digest(str(row["code"]), code):
        q_run("UPDATE evil_otp_requests SET attempts=attempts+1 WHERE id=%s", (row["id"],)); return False
    return True


@app.post("/api/auth/verify-otp")
@limited("verify", 20, 3600)
def verify_otp():
    d = body(); email, code = str(d.get("email", "")).strip().lower(), str(d.get("code", "")).strip()
    if not check_code(email, code, "verify"): return err("That code is wrong, expired or not approved yet.", 401)
    u = q_one("UPDATE evil_users SET is_verified=TRUE WHERE email=%s RETURNING id,username,email,referred_by,referral_rewarded,welcome_sent", (email,))
    q_run("DELETE FROM evil_otp_requests WHERE email=%s AND purpose='verify'", (email,))
    if u:
        reward_referral(u)
        if not u["welcome_sent"] and mail_enabled():
            if send_mail(email, f"Welcome to {BRAND}", f"Hi {u['username']},\n\nYour account is ready. You have a free {TRIAL_DAYS}-day trial with full access, and you can check in daily for bonus messages.\n\n{SITE_URL or ''}\n\nThe {BRAND} team"):
                q_run("UPDATE evil_users SET welcome_sent=TRUE WHERE id=%s", (u["id"],))
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (u["id"], f"Welcome to {BRAND}! Try Deep mode for hard questions and Fast mode for quick ones."))
    return jsonify({"success": True, "message": "Account verified! You can sign in now."})


def reward_referral(u):
    """Both people get +1 trial day once the new account is verified. A referrer can earn this 10 times."""
    if not u["referred_by"] or u["referral_rewarded"]: return
    n = q_one("SELECT COUNT(*) AS n FROM evil_users WHERE referred_by=%s AND referral_rewarded=TRUE", (u["referred_by"],))["n"]
    q_run("UPDATE evil_users SET referral_rewarded=TRUE, trial_ends_at=GREATEST(COALESCE(trial_ends_at,NOW()),NOW())+INTERVAL '1 day' WHERE id=%s", (u["id"],))
    if n < 10:
        q_run("UPDATE evil_users SET trial_ends_at=GREATEST(COALESCE(trial_ends_at,NOW()),NOW())+INTERVAL '1 day' WHERE id=%s", (u["referred_by"],))
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (u["referred_by"], "A friend joined with your link. You both got +1 free day of full access."))


@app.post("/login")
@limited("login", 40, 3600)
def login():
    d = body(); username, password = str(d.get("username", "")).strip()[:80], str(d.get("password", ""))
    ip = client_ip()
    fails = q_one("SELECT COUNT(*) AS n FROM evil_login_attempts WHERE success=FALSE AND created_at > NOW() - INTERVAL '15 minutes' AND (LOWER(username)=LOWER(%s) OR ip=%s)", (username, ip))["n"]
    if fails >= 6: return err("Too many failed attempts. Try again in 15 minutes.", 429)
    user = q_one("SELECT id,username,password_hash,is_verified,is_suspended FROM evil_users WHERE username=%s", (username,))
    if not user or not user["password_hash"] or not check_password_hash(user["password_hash"], password):
        q_run("INSERT INTO evil_login_attempts(username,ip,success) VALUES (%s,%s,FALSE)", (username, ip))
        return err("Wrong username or password.", 401)
    if user["is_suspended"]: return err("This account is suspended. Contact support.", 403)
    if not user["is_verified"]: return err("Verify your email first.", 403, needsVerification=True)
    q_run("INSERT INTO evil_login_attempts(username,ip,success) VALUES (%s,%s,TRUE)", (username, ip))
    q_run("UPDATE evil_users SET last_seen_at=NOW() WHERE id=%s", (user["id"],))
    session.clear(); session.permanent = True; session["user_id"] = user["id"]
    u = get_user(user["id"])
    return jsonify({"success": True, "user": {"username": u["username"], "plan": u["plan"], "isAdmin": u["is_admin"]}})


@app.post("/logout")
def logout(): session.clear(); return jsonify({"success": True})


@app.post("/api/auth/forgot")
@limited("forgot", 6, 3600)
def forgot():
    email = str(body().get("email", "")).strip().lower()
    u = q_one("SELECT id FROM evil_users WHERE email=%s AND is_admin=FALSE", (email,))
    how = issue_code(email, "reset") if u else "emailed"
    return jsonify({"success": True, "mode": how, "message": "If that email has an account, we sent a reset code." if how == "emailed" else "Reset requested. The admin will approve it and send you the code."})


@app.post("/api/auth/reset")
@limited("reset", 20, 3600)
def reset_password():
    d = body(); email, code, pw = str(d.get("email", "")).strip().lower(), str(d.get("code", "")).strip(), str(d.get("password", ""))
    if len(pw) < 10: return err("Password must be at least 10 characters.")
    if not check_code(email, code, "reset"): return err("That code is wrong, expired or not approved yet.", 401)
    q_run("UPDATE evil_users SET password_hash=%s WHERE email=%s", (generate_password_hash(pw), email))
    q_run("DELETE FROM evil_otp_requests WHERE email=%s AND purpose='reset'", (email,))
    return jsonify({"success": True, "message": "Password changed. You can sign in now."})


@app.get("/api/me")
@login_required
def me():
    u = request.user
    plan_key, trial = effective_plan(u)
    q_run("UPDATE evil_users SET last_seen_at=NOW() WHERE id=%s AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '5 minutes')", (u["id"],))
    can_persona = CUSTOM_PERSONA_FREE or u["is_admin"] or trial or plan_key != "free"
    refs = q_one("SELECT COUNT(*) AS n FROM evil_users WHERE referred_by=%s AND referral_rewarded=TRUE", (u["id"],))["n"]
    return jsonify({
        "user": {"username": u["username"], "email": u["email"], "plan": plan_key, "paidPlan": u["plan"], "isAdmin": u["is_admin"],
                 "streak": u["streak_count"] or 0, "checkedInToday": bool(u["checked_in_today"]), "trial": trial,
                 "planExpiresAt": iso(u["plan_expires_at"]), "customPersona": u["custom_persona"] or "", "canUsePersona": can_persona,
                 "referralCode": u["referral_code"], "referrals": refs},
        "usage": usage_status(u),
        "images": {"used": u["images_today"], "limit": PLANS[plan_key]["daily_images"]},
        "plans": PLANS, "paystack": bool(PAYSTACK_SECRET_KEY), "brand": BRAND})


@app.post("/api/user/update-persona")
@login_required
def update_persona():
    u = request.user; plan_key, trial = effective_plan(u)
    if not (CUSTOM_PERSONA_FREE or u["is_admin"] or trial or plan_key != "free"):
        return err("Custom personas are a paid feature. Upgrade to unlock them.", 402)
    text = str(body().get("persona", "")).strip()[:2000]
    q_run("UPDATE evil_users SET custom_persona=%s WHERE id=%s", (text or None, u["id"]))
    return jsonify({"success": True})


@app.get("/api/user/export")
@login_required
def export_me():
    u = request.user
    chats = q_all("SELECT id,title,created_at FROM evil_conversations WHERE user_id=%s ORDER BY created_at", (u["id"],))
    out = []
    for c in chats:
        msgs = q_all("SELECT role,content,created_at FROM evil_messages WHERE conversation_id=%s ORDER BY id", (str(c["id"]),))
        out.append({"title": c["title"], "created_at": iso(c["created_at"]), "messages": [{"role": m["role"], "content": m["content"], "at": iso(m["created_at"])} for m in msgs]})
    data = json.dumps({"account": {"username": u["username"], "email": u["email"]}, "conversations": out}, indent=2)
    return Response(data, mimetype="application/json", headers={"Content-Disposition": "attachment; filename=vyra-data.json"})


@app.post("/api/user/delete")
@login_required
def delete_me():
    u = request.user
    if u["is_admin"]: return err("The admin account can't be deleted here.", 403)
    pw = str(body().get("password", ""))
    row = q_one("SELECT password_hash FROM evil_users WHERE id=%s", (u["id"],))
    if not row or not check_password_hash(row["password_hash"], pw): return err("Wrong password.", 401)
    q_run("DELETE FROM evil_users WHERE id=%s", (u["id"],)); session.clear()
    return jsonify({"success": True})


# ----------------------------------------------------------------------------- check-in, leaderboard, notifications
def checkin_bonus(streak):
    return 5 + min(streak, 7) * 3 + (50 if streak % 7 == 0 else 0)  # grows each day, big bonus every 7th day


@app.post("/api/checkin")
@login_required
def daily_checkin():
    u = request.user
    if u["checked_in_today"]: return err("You already checked in today. Come back tomorrow!")
    row = q_one(f"""UPDATE evil_users SET streak_count = CASE WHEN last_streak_date = {TODAY} - 1 THEN COALESCE(streak_count,0)+1 ELSE 1 END,
                    last_streak_date = {TODAY} WHERE id=%s RETURNING streak_count""", (u["id"],))
    streak = row["streak_count"]; bonus = checkin_bonus(streak)
    q_run("UPDATE evil_users SET bonus_messages=bonus_messages+%s WHERE id=%s", (bonus, u["id"]))
    return jsonify({"success": True, "streak": streak, "bonus": bonus, "milestone": streak % 7 == 0})


WEEK_SQL = "to_char((NOW() AT TIME ZONE 'Africa/Lagos')::date - 7 * %s, 'IYYY-\"W\"IW')"


@app.get("/api/leaderboard")
@login_required
def leaderboard():
    mode = request.args.get("mode", "streak")
    if mode == "weekly":
        rows = q_all("""SELECT u.username, COUNT(*) AS score FROM evil_messages m JOIN evil_users u ON u.id=m.user_id
                        WHERE m.role='user' AND u.is_admin=FALSE AND m.created_at >= date_trunc('week', NOW() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'
                        GROUP BY u.username ORDER BY score DESC, u.username LIMIT 10""")
        prize = q_one("SELECT value FROM evil_settings WHERE key='weekly_prize'")
        resets = q_one("SELECT EXTRACT(EPOCH FROM ((date_trunc('week', NOW() AT TIME ZONE 'Africa/Lagos') + INTERVAL '7 days') AT TIME ZONE 'Africa/Lagos') - NOW())::int AS s")["s"]
        return jsonify({"mode": "weekly", "leaders": [{"username": r["username"], "score": r["score"]} for r in rows], "prize": prize["value"] if prize else "", "resetsInSeconds": resets})
    rows = q_all("SELECT username, streak_count AS score FROM evil_users WHERE is_admin=FALSE ORDER BY streak_count DESC NULLS LAST, username LIMIT 10")
    return jsonify({"mode": "streak", "leaders": [{"username": r["username"], "score": r["score"] or 0} for r in rows]})


@app.get("/api/notifications")
@login_required
def get_notifications():
    rows = q_all("SELECT id,message,is_read,created_at FROM evil_notifications WHERE user_id=%s ORDER BY id DESC LIMIT 30", (request.user["id"],))
    return jsonify({"notifications": [{"id": r["id"], "message": r["message"], "is_read": r["is_read"], "created_at": iso(r["created_at"])} for r in rows]})


@app.post("/api/notifications/read")
@login_required
def mark_notifications_read():
    q_run("UPDATE evil_notifications SET is_read=TRUE WHERE user_id=%s", (request.user["id"],)); return jsonify({"success": True})


# ----------------------------------------------------------------------------- Image Studio
@app.post("/api/generate-image")
@login_required
@limited("image", 12, 60, per="user")
def generate_image():
    prompt = str(body().get("prompt", "")).strip()
    if not prompt: return err("Describe the image you want first.")
    if len(prompt) > 600: return err("Keep the description under 600 characters.")
    u = request.user; plan_key, _ = effective_plan(u)
    limit = PLANS[plan_key]["daily_images"]
    # Atomic: only counts if still under today's limit, so parallel clicks can't overshoot.
    row = q_one(f"""UPDATE evil_users SET images_generated_today = CASE WHEN last_image_date = {TODAY} THEN images_generated_today+1 ELSE 1 END,
                    last_image_date = {TODAY}
                    WHERE id=%s AND (CASE WHEN last_image_date = {TODAY} THEN images_generated_today ELSE 0 END) < %s RETURNING images_generated_today""", (u["id"], limit))
    if not row: return err(f"You've used all {limit} images for today. They reset at midnight, or upgrade for more.", 429)
    seed = secrets.randbelow(10 ** 8)
    url = f"https://image.pollinations.ai/prompt/{quote(prompt)}?width=1024&height=1024&nologo=true&seed={seed}"
    img = q_one("INSERT INTO evil_images(user_id,prompt,url) VALUES (%s,%s,%s) RETURNING id", (u["id"], prompt, url))
    return jsonify({"success": True, "image_url": url, "id": img["id"], "used": row["images_generated_today"], "limit": limit})


@app.get("/api/images")
@login_required
def list_images():
    rows = q_all("SELECT id,prompt,url,created_at FROM evil_images WHERE user_id=%s ORDER BY id DESC LIMIT 60", (request.user["id"],))
    return jsonify({"images": [{"id": r["id"], "prompt": r["prompt"], "url": r["url"], "created_at": iso(r["created_at"])} for r in rows]})


@app.post("/api/images/<int:image_id>/delete")
@login_required
def delete_image(image_id):
    q_run("DELETE FROM evil_images WHERE id=%s AND user_id=%s", (image_id, request.user["id"])); return jsonify({"success": True})


@app.post("/api/extract-text")
@login_required
@limited("extract", 10, 60, per="user")
def extract_text():
    f = request.files.get("file")
    if not f: return err("Choose a PDF first.")
    data = f.read()
    if not data.startswith(b"%PDF"): return err("Only PDF files are supported right now.")
    try:
        import PyPDF2
        reader = PyPDF2.PdfReader(io.BytesIO(data))
        text = "\n".join((p.extract_text() or "") for p in reader.pages[:30]).strip()
    except Exception:
        log.exception("pdf extract failed"); return err("Couldn't read that PDF. It may be scanned or protected.")
    if not text: return err("That PDF has no readable text (it may be a scan).")
    return jsonify({"success": True, "text": text[:6000], "truncated": len(text) > 6000, "filename": (f.filename or "file.pdf")[:120]})


# ----------------------------------------------------------------------------- chats
@app.get("/api/conversations")
@login_required
def conversations():
    rows = q_all("SELECT id,title,pinned,(share_token IS NOT NULL) AS shared FROM evil_conversations WHERE user_id=%s ORDER BY pinned DESC, updated_at DESC LIMIT 80", (request.user["id"],))
    return jsonify({"conversations": [{"id": str(r["id"]), "title": r["title"], "pinned": r["pinned"], "shared": r["shared"]} for r in rows]})


def own_conversation(conversation_id):
    return q_one("SELECT id,title,share_token FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), request.user["id"]))


@app.get("/api/conversations/<uuid:conversation_id>")
@login_required
def get_conversation(conversation_id):
    c = own_conversation(conversation_id)
    if not c: return err("Chat not found.", 404)
    msgs = q_all("SELECT id,role,content,attachment_type,attachment_url,feedback FROM evil_messages WHERE conversation_id=%s ORDER BY id", (str(conversation_id),))
    return jsonify({"title": c["title"], "shareToken": c["share_token"], "messages": [dict(m) for m in msgs]})


@app.post("/api/conversations/<uuid:conversation_id>/delete")
@login_required
def delete_conversation(conversation_id):
    q_run("DELETE FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), request.user["id"])); return jsonify({"success": True})


@app.post("/api/conversations/<uuid:conversation_id>/rename")
@login_required
def rename_conversation(conversation_id):
    title = re.sub(r"\s+", " ", str(body().get("title", ""))).strip()[:120]
    if not title: return err("Give the chat a name.")
    q_run("UPDATE evil_conversations SET title=%s WHERE id=%s AND user_id=%s", (title, str(conversation_id), request.user["id"])); return jsonify({"success": True, "title": title})


@app.post("/api/conversations/<uuid:conversation_id>/pin")
@login_required
def pin_conversation(conversation_id):
    row = q_one("UPDATE evil_conversations SET pinned = NOT pinned WHERE id=%s AND user_id=%s RETURNING pinned", (str(conversation_id), request.user["id"]))
    if not row: return err("Chat not found.", 404)
    return jsonify({"success": True, "pinned": row["pinned"]})


@app.post("/api/conversations/<uuid:conversation_id>/share")
@login_required
def share_conversation(conversation_id):
    c = own_conversation(conversation_id)
    if not c: return err("Chat not found.", 404)
    if body().get("enabled") is False:
        q_run("UPDATE evil_conversations SET share_token=NULL WHERE id=%s", (str(conversation_id),)); return jsonify({"success": True, "url": None})
    token = c["share_token"] or secrets.token_urlsafe(12)
    q_run("UPDATE evil_conversations SET share_token=%s WHERE id=%s", (token, str(conversation_id)))
    return jsonify({"success": True, "url": f"{SITE_URL or request.host_url.rstrip('/')}/share/{token}"})


@app.post("/api/messages/<int:message_id>/feedback")
@login_required
def message_feedback(message_id):
    v = body().get("value")
    if v not in (1, -1, 0): return err("Invalid feedback.")
    q_run("UPDATE evil_messages SET feedback=%s WHERE id=%s AND user_id=%s AND role='assistant'", (v or None, message_id, request.user["id"])); return jsonify({"success": True})


@app.get("/api/search")
@login_required
def search_chats():
    term = str(request.args.get("q", "")).strip()[:80]
    if len(term) < 2: return jsonify({"results": []})
    like = "%" + re.sub(r"([%_\\])", r"\\\1", term) + "%"
    rows = q_all("""SELECT DISTINCT ON (c.id) c.id, c.title, m.content FROM evil_conversations c LEFT JOIN evil_messages m ON m.conversation_id=c.id AND m.content ILIKE %s
                    WHERE c.user_id=%s AND (c.title ILIKE %s OR m.id IS NOT NULL) ORDER BY c.id, m.id LIMIT 30""", (like, request.user["id"], like))
    out = []
    for r in rows:
        snippet = ""
        if r["content"]:
            i = r["content"].lower().find(term.lower()); snippet = r["content"][max(0, i - 30): i + 70].replace("\n", " ")
        out.append({"id": str(r["id"]), "title": r["title"], "snippet": snippet})
    return jsonify({"results": out})


def friendly_ai_error(exc):
    s = str(exc).lower()
    if "rate" in s or "429" in s: return "The AI is busy right now. Wait a few seconds and try again."
    if "api key" in s or "401" in s or "auth" in s: return "The AI service isn't set up correctly. The admin has been alerted."
    return "The AI couldn't answer that just now. Try again, or switch to Fast mode."


def make_client(): return OpenAI(api_key=GROQ_API_KEY, base_url="https://api.groq.com/openai/v1", timeout=60)


def auto_title(conv_id, question, answer):
    try:
        r = make_client().chat.completions.create(model=GROQ_FAST_MODEL, temperature=0.3, max_tokens=16, messages=[
            {"role": "system", "content": "Write a 3 to 6 word title for this chat. Reply with the title only. No quotes, no full stop."},
            {"role": "user", "content": f"User: {question[:300]}\nAssistant: {answer[:300]}"}])
        t = re.sub(r"[\"'\n]", "", (r.choices[0].message.content or "")).strip()[:80]
        default = (question[:40] + "...") if len(question) > 40 else question
        if len(t) >= 3: q_run("UPDATE evil_conversations SET title=%s WHERE id=%s AND title=%s", (t, conv_id, default))  # skip if the user already renamed it
    except Exception: log.info("auto title skipped")


def sse(obj): return f"data: {json.dumps(obj)}\n\n"


@app.post("/ask/stream")
@login_required
@limited("chat", 25, 60, per="user")
def ask_stream():
    d = body(); u = request.user
    question = str(d.get("question", "")).strip()
    conv_id = d.get("conversationId"); persona = str(d.get("persona", "assistant")); language = str(d.get("language", "English"))
    model_type = "fast" if d.get("modelType") == "fast" else "deep"
    try: temp = max(0.0, min(1.0, float(d.get("temperature", 0.7))))
    except (TypeError, ValueError): temp = 0.7
    extra = str(d.get("fileText", ""))[:6000]
    if not question: return err("Type a message first.")
    if len(question) > MAX_MESSAGE_CHARS: return err(f"That message is too long. Keep it under {MAX_MESSAGE_CHARS} characters.")
    if not GROQ_API_KEY: return err("The AI isn't configured yet. The admin needs to add GROQ_API_KEY.", 503)

    # Reserve one message up front (atomic) so parallel sends can't go over the limit. Refunded if the AI fails.
    status = usage_status(u)
    plan_key, trial = effective_plan(u)
    month = q_one("SELECT to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM') AS m")["m"]
    if not trial and status["remaining"] <= 0:
        return err("You've used all your messages for this month. Check in daily for bonus messages, or upgrade.", 429, limitReached=True)
    q_run("INSERT INTO evil_usage(user_id,usage_month,message_count) VALUES (%s,%s,1) ON CONFLICT (user_id,usage_month) DO UPDATE SET message_count=evil_usage.message_count+1", (u["id"], month))

    def refund():
        try: q_run("UPDATE evil_usage SET message_count=GREATEST(0,message_count-1) WHERE user_id=%s AND usage_month=%s", (u["id"], month))
        except Exception: log.exception("refund failed")

    is_new = False
    try:
        with db() as conn, conn.cursor() as cur:
            if conv_id:
                cur.execute("SELECT id FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conv_id), u["id"]))
                if not cur.fetchone(): refund(); return err("Chat not found.", 404)
                if d.get("truncateFromId"):  # edit-and-resend or regenerate: drop that message and everything after it
                    cur.execute("DELETE FROM evil_messages WHERE conversation_id=%s AND id >= %s", (str(conv_id), int(d["truncateFromId"])))
            else:
                conv_id = str(uuid.uuid4()); is_new = True
                cur.execute("INSERT INTO evil_conversations(id,user_id,title) VALUES (%s,%s,%s)", (conv_id, u["id"], (question[:40] + "...") if len(question) > 40 else question))
            cur.execute("SELECT role,content FROM evil_messages WHERE conversation_id=%s ORDER BY id DESC LIMIT 16", (conv_id,))
            history = list(reversed(cur.fetchall()))
    except Exception:
        log.exception("ask_stream setup failed"); refund(); return err("Couldn't start that chat. Please try again.", 500)

    can_persona = CUSTOM_PERSONA_FREE or u["is_admin"] or trial or plan_key != "free"
    sys_prompt = u["custom_persona"] if (u["custom_persona"] and can_persona) else PERSONAS.get(persona, PERSONAS["assistant"])["instructions"]
    if LANGUAGES.get(language): sys_prompt += " " + LANGUAGES[language] + " Keep code and technical terms in English."
    user_content = f"{question}\n\n[Attached file text]\n{extra}" if extra else question
    messages = [{"role": "system", "content": sys_prompt}] + [{"role": m["role"], "content": m["content"]} for m in history] + [{"role": "user", "content": user_content}]
    user_id = u["id"]

    def generate():
        collected, model, tried_fallback, started = [], (GROQ_FAST_MODEL if model_type == "fast" else GROQ_MODEL), False, False
        yield sse({"start": conv_id})
        try:
            while True:
                try:
                    stream = make_client().chat.completions.create(model=model, messages=messages, temperature=temp, stream=True)
                    for chunk in stream:
                        delta = (chunk.choices[0].delta.content or "") if chunk.choices else ""
                        if delta: started = True; collected.append(delta); yield sse({"t": delta})
                    break
                except Exception as exc:
                    # Retry once on the fast model if the deep model failed before saying anything.
                    if not started and not tried_fallback and model != GROQ_FAST_MODEL:
                        tried_fallback = True; model = GROQ_FAST_MODEL; yield sse({"notice": "Deep mode is busy, switched to Fast mode."}); continue
                    raise
        except GeneratorExit:  # the user pressed Stop or closed the tab: keep what was written
            if collected: save_turn(conv_id, user_id, question, "".join(collected), False)
            else: refund()
            raise
        except Exception as exc:
            log.error("AI stream failed: %s", exc)
            if collected: save_turn(conv_id, user_id, question, "".join(collected), False)
            else: refund()
            yield sse({"error": friendly_ai_error(exc)}); return
        answer = "".join(collected).strip()
        if not answer: refund(); yield sse({"error": "The AI sent an empty reply. Try again."}); return
        ids = save_turn(conv_id, user_id, question, answer, is_new)
        yield sse({"done": conv_id, "messageId": ids[1], "userMessageId": ids[0]})

    return Response(stream_with_context(generate()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def save_turn(conv_id, user_id, question, answer, retitle):
    try:
        with db() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO evil_messages(conversation_id,user_id,role,content) VALUES (%s,%s,'user',%s) RETURNING id", (conv_id, user_id, question)); uid = cur.fetchone()["id"]
            cur.execute("INSERT INTO evil_messages(conversation_id,user_id,role,content) VALUES (%s,%s,'assistant',%s) RETURNING id", (conv_id, user_id, answer)); aid = cur.fetchone()["id"]
            cur.execute("UPDATE evil_conversations SET updated_at=NOW() WHERE id=%s", (conv_id,))
        if retitle: threading.Thread(target=auto_title, args=(conv_id, question, answer), daemon=True).start()
        return uid, aid
    except Exception:
        log.exception("save_turn failed"); return None, None


# ----------------------------------------------------------------------------- payments
@app.get("/api/payment-info")
@login_required
def payment_info():
    row = q_one("SELECT account_name, account_number, bank_name, extra_note FROM evil_payment_settings WHERE id=1")
    return jsonify({"payment": dict(row) if row else None})


@app.post("/api/upgrade")
@login_required
@limited("upgrade", 10, 3600, per="user")
def upgrade_request():
    plan = str(body().get("plan", ""))
    if plan not in PLANS or plan == "free": return err("Choose a valid plan.")
    # Re-use an open request for the same plan instead of piling up duplicates.
    row = q_one("SELECT id FROM evil_payment_requests WHERE user_id=%s AND plan=%s AND status='pending' AND provider='bank' ORDER BY id DESC LIMIT 1", (request.user["id"], plan))
    if not row: row = q_one("INSERT INTO evil_payment_requests(user_id,plan,amount_ngn,provider) VALUES (%s,%s,%s,'bank') RETURNING id", (request.user["id"], plan, PLANS[plan]["price"]))
    return jsonify({"success": True, "requestId": row["id"], "amount": PLANS[plan]["price"]})


def sniff_image(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n": return "image/png"
    if data[:3] == b"\xff\xd8\xff": return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"): return "image/gif"
    return None


@app.post("/api/payment-proof/<int:request_id>")
@login_required
@limited("proof", 10, 3600, per="user")
def upload_payment_proof(request_id):
    f = request.files.get("screenshot")
    if not f: return err("Choose your payment screenshot first.")
    data = f.read()
    if len(data) > 5 * 1024 * 1024: return err("Screenshot is too big. Maximum is 5 MB.")
    mime = sniff_image(data)  # never trust the browser's content type: an HTML upload would run as the admin
    if not mime: return err("Upload a PNG, JPG, WEBP or GIF image.")
    if not q_one("SELECT id FROM evil_payment_requests WHERE id=%s AND user_id=%s AND status='pending'", (request_id, request.user["id"])): return err("Payment request not found.", 404)
    q_run("INSERT INTO evil_payment_proofs(payment_request_id,user_id,filename,mimetype,data) VALUES (%s,%s,%s,%s,%s)", (request_id, request.user["id"], (f.filename or "proof")[:190], mime, psycopg2.Binary(data)))
    q_run("INSERT INTO evil_notifications(user_id,message) SELECT id, %s FROM evil_users WHERE is_admin=TRUE", (f"New payment proof from {request.user['username']}.",))
    return jsonify({"success": True, "message": "Screenshot received. We'll activate your plan once we confirm the payment."})


def activate_plan(user_id, plan):
    q_run("UPDATE evil_users SET plan=%s, plan_expires_at=NOW() + (%s || ' days')::interval WHERE id=%s", (plan, str(PLAN_DAYS), user_id))
    q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (user_id, f"Your {PLANS[plan]['name']} plan is active for {PLAN_DAYS} days. Thank you!"))


def paystack(method, path, **kw):
    r = requests.request(method, "https://api.paystack.co" + path, headers={"Authorization": f"Bearer {PAYSTACK_SECRET_KEY}"}, timeout=20, **kw)
    return r.json()


@app.post("/api/paystack/init")
@login_required
@limited("paystack", 10, 3600, per="user")
def paystack_init():
    if not PAYSTACK_SECRET_KEY: return err("Card payments aren't switched on yet. Use bank transfer.", 503)
    plan = str(body().get("plan", ""))
    if plan not in PLANS or plan == "free": return err("Choose a valid plan.")
    u = request.user
    ref = "vyra_" + secrets.token_hex(10)
    q_run("INSERT INTO evil_payment_requests(user_id,plan,amount_ngn,provider,reference) VALUES (%s,%s,%s,'paystack',%s)", (u["id"], plan, PLANS[plan]["price"], ref))
    email = u["email"] if not u["email"].endswith(".invalid") else f"{u['username']}@vyra.app"
    try:
        res = paystack("POST", "/transaction/initialize", json={"email": email, "amount": PLANS[plan]["price"] * 100, "currency": "NGN", "reference": ref,
                       "callback_url": f"{SITE_URL or request.host_url.rstrip('/')}/?paid={ref}", "metadata": {"user_id": u["id"], "plan": plan}})
        if not res.get("status"): return err("Paystack couldn't start the payment. Try again or use bank transfer.", 502)
        return jsonify({"success": True, "url": res["data"]["authorization_url"], "reference": ref})
    except Exception:
        log.exception("paystack init failed"); return err("Couldn't reach Paystack. Try again or use bank transfer.", 502)


def settle_paystack(ref):
    """Verifies with Paystack, then activates once. Safe to call many times (webhook + redirect)."""
    row = q_one("SELECT id,user_id,plan,amount_ngn,status FROM evil_payment_requests WHERE reference=%s AND provider='paystack'", (ref,))
    if not row: return "unknown"
    if row["status"] == "approved": return "approved"
    res = paystack("GET", f"/transaction/verify/{quote(ref)}")
    data = res.get("data") or {}
    if not (res.get("status") and data.get("status") == "success" and data.get("currency") == "NGN" and int(data.get("amount", 0)) >= row["amount_ngn"] * 100):
        return "pending"
    claimed = q_one("UPDATE evil_payment_requests SET status='approved', reviewed_at=NOW() WHERE id=%s AND status<>'approved' RETURNING id", (row["id"],))
    if claimed: activate_plan(row["user_id"], row["plan"]); audit("paystack", "plan_activated", f"user {row['user_id']} {row['plan']} {ref}")
    return "approved"


@app.get("/api/paystack/verify")
@login_required
def paystack_verify():
    ref = str(request.args.get("reference", ""))[:80]
    if not q_one("SELECT id FROM evil_payment_requests WHERE reference=%s AND user_id=%s", (ref, request.user["id"])): return err("Payment not found.", 404)
    try: return jsonify({"status": settle_paystack(ref)})
    except Exception: log.exception("paystack verify failed"); return err("Couldn't check the payment yet. Refresh in a minute.", 502)


@app.post("/api/paystack/webhook")
def paystack_webhook():
    if not PAYSTACK_SECRET_KEY: return "", 404
    raw = request.get_data()
    sig = request.headers.get("x-paystack-signature", "")
    if not hmac.compare_digest(hmac.new(PAYSTACK_SECRET_KEY.encode(), raw, hashlib.sha512).hexdigest(), sig): return "", 401
    try:
        event = json.loads(raw)
        if event.get("event") == "charge.success": settle_paystack(str(event["data"].get("reference", ""))[:80])
    except Exception: log.exception("webhook failed"); return "", 500
    return "", 200


# ----------------------------------------------------------------------------- admin
@app.get("/api/admin/users")
@admin_required
def admin_users():
    rows = q_all("""SELECT id,username,email,plan,is_suspended,is_verified,plan_expires_at,created_at,last_seen_at,
                    (trial_ends_at IS NOT NULL AND trial_ends_at > NOW()) AS trial FROM evil_users WHERE is_admin=FALSE ORDER BY id DESC LIMIT 500""")
    return jsonify({"users": [{**r, "plan_expires_at": iso(r["plan_expires_at"]), "created_at": iso(r["created_at"]), "last_seen_at": iso(r["last_seen_at"])} for r in rows]})


@app.post("/api/admin/users/<int:user_id>/plan")
@admin_required
def admin_set_plan(user_id):
    plan = str(body().get("plan", ""))
    if plan not in PLANS: return err("Invalid plan.")
    if plan == "free": q_run("UPDATE evil_users SET plan='free', plan_expires_at=NULL WHERE id=%s AND is_admin=FALSE", (user_id,))
    else: activate_plan(user_id, plan)
    audit(request.user["username"], "set_plan", f"user {user_id} -> {plan}")
    return jsonify({"success": True})


@app.post("/api/admin/users/<int:user_id>/suspend")
@admin_required
def admin_suspend(user_id):
    on = bool(body().get("suspended", True))
    q_run("UPDATE evil_users SET is_suspended=%s WHERE id=%s AND is_admin=FALSE", (on, user_id))
    audit(request.user["username"], "suspend" if on else "unsuspend", f"user {user_id}")
    return jsonify({"success": True})


@app.get("/api/admin/payment-requests")
@admin_required
def admin_payment_requests():
    rows = q_all("""SELECT pr.id, pr.user_id, u.username, pr.plan, pr.amount_ngn, pr.status, pr.provider, pr.created_at,
                    (SELECT id FROM evil_payment_proofs p WHERE p.payment_request_id=pr.id ORDER BY id DESC LIMIT 1) AS proof_id
                    FROM evil_payment_requests pr JOIN evil_users u ON u.id = pr.user_id ORDER BY pr.id DESC LIMIT 200""")
    return jsonify({"requests": [{**r, "created_at": iso(r["created_at"])} for r in rows]})


@app.get("/api/admin/payment-proof/<int:proof_id>")
@admin_required
def admin_get_proof(proof_id):
    row = q_one("SELECT mimetype, data FROM evil_payment_proofs WHERE id=%s", (proof_id,))
    if not row: return err("Not found.", 404)
    data = row["data"]
    if isinstance(data, str): data = bytes.fromhex(data[2:]) if data.startswith("\\x") else data.encode()
    mime = row["mimetype"] if row["mimetype"] in ("image/png", "image/jpeg", "image/webp", "image/gif") else "application/octet-stream"
    return Response(bytes(data), mimetype=mime, headers={"Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff"})


@app.post("/api/admin/payment-requests/<int:request_id>/<action>")
@admin_required
def admin_review_payment(request_id, action):
    if action not in ("approve", "reject"): return err("Unknown action.", 404)
    row = q_one("SELECT id,user_id,plan,status FROM evil_payment_requests WHERE id=%s", (request_id,))
    if not row or row["status"] != "pending": return err("That request was already handled.", 404)
    if action == "approve":
        q_run("UPDATE evil_payment_requests SET status='approved', reviewed_at=NOW() WHERE id=%s", (request_id,))
        activate_plan(row["user_id"], row["plan"])
    else:
        q_run("UPDATE evil_payment_requests SET status='rejected', reviewed_at=NOW() WHERE id=%s", (request_id,))
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (row["user_id"], "We couldn't confirm your payment. Please check and send the screenshot again."))
    audit(request.user["username"], f"payment_{action}", f"request {request_id}")
    return jsonify({"success": True})


@app.post("/api/admin/approve/<int:user_id>")  # kept from Evil GPT: sets a plan directly
@admin_required
def admin_approve(user_id):
    plan = str(body().get("plan", ""))
    if plan not in PLANS or plan == "free": return err("Invalid plan.")
    activate_plan(user_id, plan)
    q_run("UPDATE evil_payment_requests SET status='approved', reviewed_at=NOW() WHERE user_id=%s AND plan=%s AND status='pending'", (user_id, plan))
    audit(request.user["username"], "approve", f"user {user_id} -> {plan}")
    return jsonify({"success": True})


@app.get("/api/admin/otp-requests")
@admin_required
def admin_otp_requests():
    rows = q_all("SELECT id,email,code,status,purpose,created_at FROM evil_otp_requests ORDER BY id DESC LIMIT 50")
    return jsonify({"requests": [{**r, "created_at": iso(r["created_at"])} for r in rows]})


@app.post("/api/admin/approve-otp/<int:otp_id>")
@admin_required
def approve_otp(otp_id):
    row = q_one("SELECT email, code, purpose FROM evil_otp_requests WHERE id=%s", (otp_id,))
    if not row: return err("Not found.", 404)
    sent = send_code(row["email"], row["code"], row["purpose"]) if mail_enabled() else False
    q_run("UPDATE evil_otp_requests SET status='approved', created_at=NOW() WHERE id=%s", (otp_id,))
    audit(request.user["username"], "approve_otp", row["email"])
    return jsonify({"success": True, "emailed": sent, "message": "Approved and emailed." if sent else f"Approved. Send this code to the user yourself: {row['code']}"})


@app.post("/api/admin/broadcast")
@admin_required
def admin_broadcast():
    msg = str(body().get("message", "")).strip()[:1000]
    if not msg: return err("Write a message first.")
    n = q_run("INSERT INTO evil_notifications(user_id, message) SELECT id, %s FROM evil_users WHERE is_admin=FALSE", (msg,))
    audit(request.user["username"], "broadcast", msg[:100])
    return jsonify({"success": True, "sent": n})


@app.get("/api/admin/stats")
@admin_required
def admin_stats():
    days = 30
    signups = q_all("SELECT to_char(d,'YYYY-MM-DD') AS day, COALESCE(n,0) AS n FROM generate_series((NOW() AT TIME ZONE 'Africa/Lagos')::date - %s, (NOW() AT TIME ZONE 'Africa/Lagos')::date, '1 day') d LEFT JOIN (SELECT (created_at AT TIME ZONE 'Africa/Lagos')::date AS dd, COUNT(*) AS n FROM evil_users WHERE is_admin=FALSE GROUP BY 1) s ON s.dd=d ORDER BY d", (days - 1,))
    revenue = q_all("SELECT to_char(d,'YYYY-MM-DD') AS day, COALESCE(n,0) AS n FROM generate_series((NOW() AT TIME ZONE 'Africa/Lagos')::date - %s, (NOW() AT TIME ZONE 'Africa/Lagos')::date, '1 day') d LEFT JOIN (SELECT (reviewed_at AT TIME ZONE 'Africa/Lagos')::date AS dd, SUM(amount_ngn)::bigint AS n FROM evil_payment_requests WHERE status='approved' GROUP BY 1) s ON s.dd=d ORDER BY d", (days - 1,))
    active = q_all("SELECT to_char(d,'YYYY-MM-DD') AS day, COALESCE(n,0) AS n FROM generate_series((NOW() AT TIME ZONE 'Africa/Lagos')::date - %s, (NOW() AT TIME ZONE 'Africa/Lagos')::date, '1 day') d LEFT JOIN (SELECT (created_at AT TIME ZONE 'Africa/Lagos')::date AS dd, COUNT(DISTINCT user_id) AS n FROM evil_messages WHERE role='user' GROUP BY 1) s ON s.dd=d ORDER BY d", (days - 1,))
    totals = q_one("""SELECT (SELECT COUNT(*) FROM evil_users WHERE is_admin=FALSE) AS users,
        (SELECT COUNT(*) FROM evil_users WHERE is_admin=FALSE AND plan<>'free' AND (plan_expires_at IS NULL OR plan_expires_at > NOW())) AS paying,
        (SELECT COUNT(*) FROM evil_messages WHERE role='user') AS messages,
        (SELECT COALESCE(SUM(amount_ngn),0)::bigint FROM evil_payment_requests WHERE status='approved') AS revenue,
        (SELECT COUNT(DISTINCT user_id) FROM evil_messages WHERE created_at > NOW() - INTERVAL '1 day') AS dau,
        (SELECT COUNT(DISTINCT user_id) FROM evil_messages WHERE created_at > NOW() - INTERVAL '7 days') AS wau,
        (SELECT COUNT(*) FROM evil_payment_requests WHERE status='pending') AS pending_payments,
        (SELECT COUNT(*) FROM evil_otp_requests WHERE status='pending') AS pending_otps""")
    plans = q_all("SELECT plan, COUNT(*) AS n FROM evil_users WHERE is_admin=FALSE GROUP BY plan ORDER BY n DESC")
    return jsonify({"signups": signups, "revenue": revenue, "active": active, "totals": dict(totals), "plans": plans})


@app.get("/api/admin/audit")
@admin_required
def admin_audit():
    rows = q_all("SELECT actor,action,detail,created_at FROM evil_audit_log ORDER BY id DESC LIMIT 60")
    fails = q_all("SELECT username,ip,created_at FROM evil_login_attempts WHERE success=FALSE ORDER BY id DESC LIMIT 25")
    return jsonify({"audit": [{**r, "created_at": iso(r["created_at"])} for r in rows], "failedLogins": [{**r, "created_at": iso(r["created_at"])} for r in fails]})


@app.get("/api/admin/export")
@admin_required
def admin_export():
    users = q_all("SELECT id,username,email,plan,plan_expires_at,is_verified,is_suspended,streak_count,bonus_messages,created_at FROM evil_users ORDER BY id")
    pays = q_all("SELECT id,user_id,plan,amount_ngn,status,provider,reference,created_at,reviewed_at FROM evil_payment_requests ORDER BY id")
    clean = lambda rows: [{k: iso(v) if hasattr(v, "isoformat") else v for k, v in r.items()} for r in rows]
    data = json.dumps({"exported_at": q_one("SELECT NOW()::text AS t")["t"], "users": clean(users), "payments": clean(pays)}, indent=2, default=str)
    return Response(data, mimetype="application/json", headers={"Content-Disposition": "attachment; filename=vyra-backup.json"})


@app.post("/api/admin/weekly-prize")
@admin_required
def admin_weekly_prize():
    text = str(body().get("prize", "")).strip()[:140]
    q_run("INSERT INTO evil_settings(key,value) VALUES ('weekly_prize',%s) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", (text,))
    return jsonify({"success": True})


@app.post("/api/admin/award-weekly")
@admin_required
def admin_award_weekly():
    """Gives +100 / +50 / +25 bonus messages to last week's top 3 chatters. Can only be run once per week."""
    wk = q_one("SELECT " + (WEEK_SQL % "1") + " AS k")["k"]
    if q_one("SELECT week_key FROM evil_awards WHERE week_key=%s", (wk,)): return err(f"Already awarded for {wk}.")
    rows = q_all("""SELECT u.id, u.username, COUNT(*) AS score FROM evil_messages m JOIN evil_users u ON u.id=m.user_id
                    WHERE m.role='user' AND u.is_admin=FALSE
                      AND m.created_at >= (date_trunc('week', NOW() AT TIME ZONE 'Africa/Lagos') - INTERVAL '7 days') AT TIME ZONE 'Africa/Lagos'
                      AND m.created_at <  date_trunc('week', NOW() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'
                    GROUP BY u.id,u.username ORDER BY score DESC LIMIT 3""")
    if not rows: return err("Nobody chatted last week, so there are no winners.")
    names = []
    for bonus, r in zip((100, 50, 25), rows):
        q_run("UPDATE evil_users SET bonus_messages=bonus_messages+%s WHERE id=%s", (bonus, r["id"]))
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (r["id"], f"You placed on last week's leaderboard! +{bonus} bonus messages."))
        names.append(f"{r['username']} (+{bonus})")
    q_run("INSERT INTO evil_awards(week_key,detail) VALUES (%s,%s)", (wk, ", ".join(names)))
    audit(request.user["username"], "award_weekly", ", ".join(names))
    return jsonify({"success": True, "message": "Awarded: " + ", ".join(names)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=os.environ.get("FLASK_DEBUG") == "1")
