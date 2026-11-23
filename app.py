"""Vyra AI backend (Flask + Postgres + Groq).

Upgraded from the Evil GPT codebase. Every original feature is kept:
chat (Deep/Fast), personas, custom persona, Image Studio, plans, daily check-in,
leaderboard, notifications, email-code verification with admin approval, 2-day trial,
admin console (users / payments / OTPs / broadcast), payment proof upload.
"""
import os, re, io, json, uuid, hmac, hashlib, secrets, logging, smtplib, threading, time, zipfile
from urllib.parse import quote, urlparse
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
                   stream_with_context, send_from_directory, abort, redirect, send_file)
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
# Balanced sits between Fast and Deep. Groq's model lineup changes over time, so this is a separate
# env var the admin can point at whatever mid-size model Groq currently offers. Unset, it just behaves like Fast.
GROQ_BALANCED_MODEL = os.environ.get("GROQ_BALANCED_MODEL", GROQ_FAST_MODEL)
CHANGELOG_VERSION = int(os.environ.get("CHANGELOG_VERSION", "2"))  # bump this when changelog.html gets a new entry
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
WHATSAPP_SUPPORT_NUMBER = re.sub(r"\D", "", os.environ.get("WHATSAPP_SUPPORT_NUMBER", ""))
CUSTOM_PERSONA_FREE = os.environ.get("CUSTOM_PERSONA_FREE") == "1"  # set to 1 to let Free users use custom personas
TRIAL_DAYS = int(os.environ.get("TRIAL_DAYS_V2", "7"))  # new name on purpose: an old TRIAL_DAYS=3 set on Render is ignored
PLAN_DAYS = int(os.environ.get("PLAN_DAYS", "30"))
MAX_MESSAGE_CHARS = 8000

# VYRA subscription catalog: five paid tiers plus Free.
PLANS = {
    "free": {"name": "Free", "price": 0, "price_usd": 0, "monthly_messages": 20, "daily_images": 3},
    "starter": {"name": "Starter", "price": 1500, "price_usd": 5.00, "monthly_messages": 120, "daily_images": 10},
    "plus": {"name": "Plus", "price": 5000, "price_usd": 12.99, "monthly_messages": 400, "daily_images": 30},
    "pro": {"name": "Pro", "price": 15000, "price_usd": 29.99, "monthly_messages": 1200, "daily_images": 100},
    "business": {"name": "Business", "price": 40000, "price_usd": 59.99, "monthly_messages": 4000, "daily_images": 300},
    "enterprise": {"name": "Enterprise", "price": 100000, "price_usd": 99.99, "monthly_messages": 10000, "daily_images": 800},
}
PLAN_ORDER = list(PLANS.keys())
LEGACY_PLAN_MAP = {"ultra": "pro", "business_elite": "enterprise", "infinity": "enterprise"}
BILLING_DAYS = {"weekly": 7, "monthly": 30, "annual": 365}
BILLING_MULTIPLIERS = {"weekly": 0.35, "monthly": 1.0, "annual": 10.0}  # annual ~= two months free

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
    "assistant": {"name": "Assistant", "instructions": f"You are {BRAND}, a helpful, accurate, friendly and fun AI assistant. Be clear and concise, and feel free to joke around. Say so when you are unsure."},
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

LANGUAGES = {"English": "", "Nigerian Pidgin": "Reply in Nigerian Pidgin English.", "Yoruba": "Reply in Yoruba.", "Hausa": "Reply in Hausa.", "Igbo": "Reply in Igbo.", "French": "Reply in French.", "Spanish": "Reply in Spanish.", "German": "Reply in German.", "Portuguese": "Reply in Portuguese."}

LENGTH_PROMPTS = {"concise": "Keep answers short and to the point.", "detailed": "Give thorough, detailed answers with examples where useful."}
TONE_PROMPTS = {"formal": "Use a formal, professional tone.", "casual": "Use a relaxed, casual, conversational tone."}
ELI5_PROMPT = "Explain things in the simplest possible way, as if to a curious beginner. Avoid jargon; use everyday comparisons."

# Badge key -> (label, icon). Earned status is computed from existing data in badges_for().
BADGE_DEFS = [
    ("first_chat", "First conversation", "chat"),
    ("hundred_messages", "100 messages sent", "zap"),
    ("streak_7", "7-day streak", "flame"),
    ("streak_30", "30-day streak", "flame"),
    ("first_image", "First image created", "image"),
    ("first_referral", "Invited a friend", "share"),
    ("sharer", "Shared a chat", "link"),
]

# ----------------------------------------------------------------------------- database
_pool = None
_pool_lock = threading.Lock()
_last_used = {}  # id(connection) -> last use time (psycopg2 connections cannot hold custom attributes)
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
    if time.time() - _last_used.get(id(conn), 0) > 20:  # idle a while: make sure Neon didn't close it
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
        dead = bad or bool(conn.closed)
        if dead: _last_used.pop(id(conn), None)
        else: _last_used[id(conn)] = time.time()
        pool.putconn(conn, close=dead)


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
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS public_id VARCHAR(16)",
    "CREATE UNIQUE INDEX IF NOT EXISTS evil_users_public_id_idx ON evil_users(public_id)",
    "CREATE TABLE IF NOT EXISTS evil_admin_messages (id BIGSERIAL PRIMARY KEY, admin_id BIGINT NOT NULL REFERENCES evil_users(id), user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, message TEXT NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
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
    "CREATE TABLE IF NOT EXISTS evil_image_blobs (image_id BIGINT PRIMARY KEY REFERENCES evil_images(id) ON DELETE CASCADE, mime VARCHAR(30) NOT NULL, data BYTEA NOT NULL)",
    "CREATE TABLE IF NOT EXISTS evil_login_attempts (id BIGSERIAL PRIMARY KEY, username VARCHAR(80), ip VARCHAR(64), success BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS evil_login_attempts_idx ON evil_login_attempts(username, ip, created_at)",
    "CREATE TABLE IF NOT EXISTS evil_rate_limits (key VARCHAR(160) NOT NULL, bucket BIGINT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(key, bucket))",
    "CREATE TABLE IF NOT EXISTS evil_audit_log (id BIGSERIAL PRIMARY KEY, actor VARCHAR(40), action VARCHAR(60) NOT NULL, detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_awards (week_key VARCHAR(10) PRIMARY KEY, awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), detail TEXT)",
    "CREATE TABLE IF NOT EXISTS evil_plan_gifts (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, admin_id BIGINT NOT NULL REFERENCES evil_users(id), plan VARCHAR(32) NOT NULL, duration_days INTEGER NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_reward_requests (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, message TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ)",
    "CREATE TABLE IF NOT EXISTS evil_settings (key VARCHAR(40) PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS evil_coupons (id BIGSERIAL PRIMARY KEY, code VARCHAR(32) UNIQUE NOT NULL, discount_type VARCHAR(12) NOT NULL, discount_value NUMERIC(12,2) NOT NULL, applicable_plan VARCHAR(32), max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT TRUE, created_by BIGINT REFERENCES evil_users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    # ---- second Vyra AI batch (all additive) ----
    "ALTER TABLE evil_conversations ADD COLUMN IF NOT EXISTS tags VARCHAR(200)",
    "ALTER TABLE evil_conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS about_me TEXT",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS ai_nickname VARCHAR(40)",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS last_seen_changelog INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS country_code VARCHAR(2)",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(40) NOT NULL DEFAULT 'English'",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(3) NOT NULL DEFAULT 'NGN'",
    "CREATE TABLE IF NOT EXISTS evil_projects (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, name VARCHAR(100) NOT NULL, instructions TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_project_files (id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES evil_projects(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, filename VARCHAR(200) NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_memories (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, memory TEXT NOT NULL, source VARCHAR(30) NOT NULL DEFAULT 'user', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_skills (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, name VARCHAR(80) NOT NULL, instruction TEXT NOT NULL, slash_command VARCHAR(40) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, slash_command))",
    "ALTER TABLE evil_conversations ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES evil_projects(id) ON DELETE SET NULL",
    "ALTER TABLE evil_payment_requests ADD COLUMN IF NOT EXISTS billing_period VARCHAR(12) NOT NULL DEFAULT 'monthly'",
    "ALTER TABLE evil_payment_requests ADD COLUMN IF NOT EXISTS duration_days INTEGER NOT NULL DEFAULT 30",
    # ---- third Vyra AI batch (all additive; nothing is dropped or rewritten) ----
    "CREATE TABLE IF NOT EXISTS evil_support_messages (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, sender VARCHAR(8) NOT NULL, message TEXT NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS evil_support_user_idx ON evil_support_messages(user_id, id)",
    "ALTER TABLE evil_payment_requests ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(32)",
    "ALTER TABLE evil_payment_requests ADD COLUMN IF NOT EXISTS original_amount_ngn INTEGER",
    "CREATE TABLE IF NOT EXISTS evil_coupon_redemptions (id BIGSERIAL PRIMARY KEY, coupon_id BIGINT NOT NULL REFERENCES evil_coupons(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, payment_request_id BIGINT REFERENCES evil_payment_requests(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS evil_coupon_red_idx ON evil_coupon_redemptions(coupon_id, user_id)",
    "CREATE INDEX IF NOT EXISTS evil_messages_conv_idx ON evil_messages(conversation_id, id)",
    "CREATE INDEX IF NOT EXISTS evil_conversations_user_idx ON evil_conversations(user_id, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS evil_notifications_user_idx ON evil_notifications(user_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS evil_payreq_user_idx ON evil_payment_requests(user_id, status)",
    "CREATE INDEX IF NOT EXISTS evil_memories_user_idx ON evil_memories(user_id, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS evil_project_files_proj_idx ON evil_project_files(project_id, id DESC)",
    # ---- Vyra batch 1: chat features (additive only) ----
    "ALTER TABLE evil_messages ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE evil_messages ADD COLUMN IF NOT EXISTS mode VARCHAR(10)",
    "CREATE TABLE IF NOT EXISTS evil_notes (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, conversation_id UUID REFERENCES evil_conversations(id) ON DELETE SET NULL, title VARCHAR(120) NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS evil_notes_user_idx ON evil_notes(user_id, id DESC)",
    # ---- Vyra batch 2: chat folders (additive only) ----
    "CREATE TABLE IF NOT EXISTS evil_folders (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, name VARCHAR(40) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS evil_folders_user_idx ON evil_folders(user_id, id)",
    "ALTER TABLE evil_conversations ADD COLUMN IF NOT EXISTS folder_id BIGINT REFERENCES evil_folders(id) ON DELETE SET NULL",
    # ---- Vyra batch 3: memory controls (additive only) ----
    "ALTER TABLE evil_memories ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'general'",
    "ALTER TABLE evil_memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
    "ALTER TABLE evil_conversations ADD COLUMN IF NOT EXISTS use_memory BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE evil_projects ADD COLUMN IF NOT EXISTS persona TEXT NOT NULL DEFAULT ''",
    "CREATE TABLE IF NOT EXISTS evil_styles (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, name VARCHAR(40) NOT NULL, instruction TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS evil_styles_user_idx ON evil_styles(user_id, id)",
    # ---- Vyra batch 5: billing extras (additive only) ----
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS expiry_warned_for TIMESTAMPTZ",
    "CREATE TABLE IF NOT EXISTS evil_gift_links (id BIGSERIAL PRIMARY KEY, code VARCHAR(40) UNIQUE NOT NULL, plan VARCHAR(32) NOT NULL, duration_days INTEGER NOT NULL, created_by BIGINT REFERENCES evil_users(id) ON DELETE SET NULL, redeemed_by BIGINT REFERENCES evil_users(id) ON DELETE SET NULL, redeemed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS evil_student_requests (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, school VARCHAR(100) NOT NULL, note TEXT NOT NULL DEFAULT '', status VARCHAR(12) NOT NULL DEFAULT 'pending', coupon_code VARCHAR(32), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS evil_student_requests_user_idx ON evil_student_requests(user_id, id DESC)",
    # ---- Vyra batch 6: security + privacy (additive only) ----
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64)",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS auto_delete_days INTEGER",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS auto_purge_at TIMESTAMPTZ",
    "CREATE TABLE IF NOT EXISTS evil_devices (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, fp VARCHAR(40) NOT NULL, label VARCHAR(80) NOT NULL, ip VARCHAR(64), first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, fp))",
    "CREATE TABLE IF NOT EXISTS evil_reports (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES evil_users(id) ON DELETE CASCADE, message_id BIGINT, reason VARCHAR(20) NOT NULL, details TEXT NOT NULL DEFAULT '', question TEXT NOT NULL DEFAULT '', answer TEXT NOT NULL DEFAULT '', status VARCHAR(12) NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "ALTER TABLE evil_reports ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'open'",
    "CREATE INDEX IF NOT EXISTS evil_reports_status_idx ON evil_reports(status, id DESC)",
    # ---- Vyra batch 7: relaunch trial offer + admin tools (additive only) ----
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS relaunch_claimed BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE evil_users ADD COLUMN IF NOT EXISTS relaunch_notified BOOLEAN NOT NULL DEFAULT FALSE",
    "INSERT INTO evil_settings(key,value) VALUES ('relaunch_trial_at', EXTRACT(EPOCH FROM NOW())::bigint::text) ON CONFLICT (key) DO NOTHING",
    "CREATE TABLE IF NOT EXISTS evil_canned (id BIGSERIAL PRIMARY KEY, title VARCHAR(40) NOT NULL, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
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
                            cur.execute("INSERT INTO evil_users(username,email,password_hash,plan,is_admin,is_verified) VALUES (%s,%s,%s,'enterprise',TRUE,TRUE)",
                                        (ADMIN_USERNAME, (ADMIN_USERNAME.lower() + "@admin.invalid")[:254], generate_password_hash(ADMIN_PASSWORD)))
                    # Every account receives a private, human-readable VYRA ID (collision checked by unique index).
                    cur.execute("SELECT id FROM evil_users WHERE public_id IS NULL")
                    for r in cur.fetchall():
                        while True:
                            pid = new_vyra_id()
                            cur.execute("SELECT 1 FROM evil_users WHERE public_id=%s", (pid,))
                            if not cur.fetchone(): break
                        cur.execute("UPDATE evil_users SET public_id=%s WHERE id=%s", (pid, r["id"]))
                    # One-time launch promotion: extend eligible existing Free accounts to 7 days.
                    cur.execute("SELECT 1 FROM evil_settings WHERE key='migration_existing_users_7day_trial'")
                    if not cur.fetchone():
                        cur.execute("""UPDATE evil_users u SET trial_ends_at=NOW() + INTERVAL '7 days'
                                    WHERE is_admin=FALSE AND plan='free'
                                    AND NOT EXISTS (SELECT 1 FROM evil_payment_requests p WHERE p.user_id=u.id AND p.status='approved')""")
                        cur.execute("INSERT INTO evil_settings(key,value) VALUES ('migration_existing_users_7day_trial','done')")
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
            except Exception as exc:
                log.exception("Database init failed (attempt %s): %s", attempt, exc)
                if attempt == 2: raise
                time.sleep(1)


def new_vyra_id():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "VYR-" + "".join(secrets.choice(alphabet) for _ in range(4)) + "-" + "".join(secrets.choice(alphabet) for _ in range(4) )

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


USER_COLS = """id,username,email,public_id,plan,is_admin,is_verified,trial_ends_at,bonus_messages,streak_count,custom_persona,referral_code,is_suspended,
    about_me,ai_nickname,session_version,last_seen_changelog,country_code,preferred_language,preferred_currency,
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
    if u and session.get("sv", 0) != (u["session_version"] or 0): return None  # signed out remotely via "log out other devices"
    return u


def effective_plan(u):
    """Resolve legacy subscriptions; a one-time free trial unlocks the Enterprise feature set."""
    if u["is_admin"]: return "enterprise", False
    raw = u["plan"] or "free"
    plan = raw if raw in PLANS else LEGACY_PLAN_MAP.get(raw, "free")
    if plan != "free" and u["plan_expired"]: plan = "free"
    if u["trial_active"]: return "enterprise", True
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
    if u["is_admin"]: return {"used": used, "limit": 99999, "remaining": 99999, "trial": False}  # the admin account is never quota-limited
    if trial: return {"used": used, "limit": 99999, "remaining": 99999, "trial": True, "trialEndsAt": iso(u["trial_ends_at"])}
    limit = PLANS[plan_key]["monthly_messages"] + (u["bonus_messages"] or 0)
    return {"used": used, "limit": limit, "remaining": max(0, limit - used), "trial": False}


def badges_for(u):
    """Cheap, computed from existing columns/tables - no new table needed."""
    total_msgs = q_one("SELECT COALESCE(SUM(message_count),0) AS n FROM evil_usage WHERE user_id=%s", (u["id"],))["n"]
    has_image = q_one("SELECT 1 FROM evil_images WHERE user_id=%s LIMIT 1", (u["id"],))
    has_chat = q_one("SELECT 1 FROM evil_conversations WHERE user_id=%s LIMIT 1", (u["id"],))
    has_shared = q_one("SELECT 1 FROM evil_conversations WHERE user_id=%s AND share_token IS NOT NULL LIMIT 1", (u["id"],))
    has_referral = q_one("SELECT 1 FROM evil_users WHERE referred_by::text=%s AND referral_rewarded=TRUE LIMIT 1", (str(u["id"]),))
    streak = u["streak_count"] or 0
    earned = {
        "first_chat": bool(has_chat), "hundred_messages": total_msgs >= 100, "streak_7": streak >= 7,
        "streak_30": streak >= 30, "first_image": bool(has_image), "first_referral": bool(has_referral), "sharer": bool(has_shared),
    }
    return [{"key": k, "label": label, "icon": icon} for k, label, icon in BADGE_DEFS if earned.get(k)]


# ----------------------------------------------------------------------------- email
def mail_enabled():
    return bool(MAIL_FROM and (BREVO_API_KEY or RESEND_API_KEY or (SMTP_EMAIL and SMTP_PASSWORD)))


def _mail_post(provider, url, **kw):
    """POST with one retry on network errors, 429 and 5xx. Returns the final response or None. Never logs keys or message bodies."""
    r = None
    for attempt in (1, 2):
        try:
            r = requests.post(url, timeout=15, **kw)
            if r.status_code < 500 and r.status_code != 429: return r
            log.warning("MAIL %s temporary_error status=%s attempt=%s", provider, r.status_code, attempt)
        except requests.RequestException as exc:
            log.warning("MAIL %s network_error type=%s attempt=%s", provider, type(exc).__name__, attempt)
        if attempt == 1: time.sleep(1.5)
    return r


def send_mail(to_email, subject, text):
    """Tries Brevo or Resend over HTTPS first (works on Render free). SMTP is the last resort and is blocked on Render free.
    True means a provider ACCEPTED the request. It does NOT prove the email was delivered (check the Brevo logs for that)."""
    domain = to_email.split("@")[-1]
    log.info("MAIL initiated to_domain=%s", domain)
    try:
        if BREVO_API_KEY and MAIL_FROM:
            r = _mail_post("brevo", "https://api.brevo.com/v3/smtp/email", headers={"api-key": BREVO_API_KEY, "accept": "application/json"},
                           json={"sender": {"name": MAIL_FROM_NAME, "email": MAIL_FROM}, "to": [{"email": to_email}], "subject": subject, "textContent": text})
            if r is not None and r.status_code < 300:
                try: mid = (r.json() or {}).get("messageId")
                except Exception: mid = None
                log.info("MAIL accepted_by_brevo delivery_status=unknown to_domain=%s message_id=%s", domain, mid)
                return True
            log.error("MAIL brevo_failed status=%s detail=%s", r.status_code if r is not None else "no_response", (r.text[:200] if r is not None else ""))
        if RESEND_API_KEY and MAIL_FROM:
            r = _mail_post("resend", "https://api.resend.com/emails", headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
                           json={"from": f"{MAIL_FROM_NAME} <{MAIL_FROM}>", "to": [to_email], "subject": subject, "text": text})
            if r is not None and r.status_code < 300:
                log.info("MAIL accepted_by_resend delivery_status=unknown to_domain=%s", domain)
                return True
            log.error("MAIL resend_failed status=%s detail=%s", r.status_code if r is not None else "no_response", (r.text[:200] if r is not None else ""))
        if SMTP_EMAIL and SMTP_PASSWORD:
            msg = MIMEMultipart(); msg["From"], msg["To"], msg["Subject"] = f"{MAIL_FROM_NAME} <{SMTP_EMAIL}>", to_email, subject
            msg.attach(MIMEText(text, "plain"))
            s = smtplib.SMTP("smtp.gmail.com", 587, timeout=10); s.starttls(); s.login(SMTP_EMAIL, SMTP_PASSWORD); s.send_message(msg); s.quit()
            log.info("MAIL accepted_by_smtp delivery_status=unknown to_domain=%s", domain)
            return True
        log.error("MAIL failed no_provider_accepted to_domain=%s", domain)
    except Exception:
        log.exception("MAIL failed exception to_domain=%s", domain)
    return False


def send_code(email, code, purpose):
    if purpose == "reset":
        return send_mail(email, f"Reset your {BRAND} password", f"Your {BRAND} password reset code is: {code}\n\nIt expires in 15 minutes. If you didn't ask for this, ignore this email.")
    return send_mail(email, f"Verify your {BRAND} account", f"Welcome to {BRAND}!\n\nYour verification code is: {code}\n\nIt expires in 15 minutes.")


def issue_code(email, purpose, reuse=False):
    """Creates a 6-digit code. With mail configured it is emailed straight away; otherwise it waits for admin approval.
    reuse=True re-sends the still-valid code instead of replacing it, so a delayed first email keeps working."""
    row = None
    if reuse:
        row = q_one("SELECT id,code FROM evil_otp_requests WHERE email=%s AND purpose=%s AND attempts < 5 AND created_at > NOW() - INTERVAL '15 minutes' ORDER BY id DESC LIMIT 1", (email, purpose))
    if row:
        code = row["code"]
    else:
        code = f"{secrets.randbelow(900000) + 100000}"
        q_run("DELETE FROM evil_otp_requests WHERE email=%s AND purpose=%s", (email, purpose))
        row = q_one("INSERT INTO evil_otp_requests(email,code,status,purpose) VALUES (%s,%s,'pending',%s) RETURNING id", (email, code, purpose))
    if mail_enabled() and send_code(email, code, purpose):
        q_run("UPDATE evil_otp_requests SET status='approved' WHERE id=%s", (row["id"],))  # 'approved' = released to the user, not proof of delivery
        return "emailed"
    log.warning("OTP not emailed (purpose=%s): waiting for admin approval", purpose)
    return "admin"


DISPOSABLE_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz", "guerrillamail.de", "guerrillamailblock.com", "grr.la", "sharklasers.com", "spam4.me",
    "10minutemail.com", "10minutemail.net", "20minutemail.com", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmailo.com", "tempail.com", "tempr.email", "tempinbox.com", "yopmail.com", "yopmail.net",
    "trashmail.com", "trashmail.net", "trashmail.de", "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com",
    "moakt.com", "spamgourmet.com", "burnermail.io", "discard.email", "mailnesia.com", "mytemp.email", "inboxkitten.com", "harakirimail.com", "mail.tm", "1secmail.com", "1secmail.org", "1secmail.net",
    "dropmail.me", "minuteinbox.com", "emailfake.com", "fakemail.net", "mailcatch.com", "mailsac.com", "mohmal.in", "tmail.ws", "tmpmail.org", "tmpmail.net", "throwam.com", "trbvm.com", "getairmail.com",
    "anonbox.net", "byom.de", "dayrep.com", "einrot.com", "fleckens.hu", "gustr.com", "jourrapide.com", "rhyta.com", "superrito.com", "teleworm.us", "armyspy.com", "cuvox.de", "emailtemporanea.net",
    "spambox.us", "spamex.com", "mailforspam.com", "mvrht.net", "wegwerfmail.de", "wegwerfmail.net", "tempmailaddress.com", "luxusmail.org", "linshiyouxiang.net", "emltmp.com", "mail-temp.com", "yomail.info",
}
DISPOSABLE_DOMAINS |= {d.strip().lower() for d in os.environ.get("EXTRA_BLOCKED_EMAIL_DOMAINS", "").split(",") if d.strip()}


def is_disposable_email(email):
    """True for throw-away mailbox services (the domain or any parent domain is on the list). The list is not exhaustive."""
    parts = email.rsplit("@", 1)[-1].lower().strip(".").split(".")
    return any(".".join(parts[i:]) in DISPOSABLE_DOMAINS for i in range(len(parts) - 1))


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



# ----------------------------------------------------------------------------- VYRA global settings, Projects, Memory, Skills and research
COUNTRY_DEFAULTS = {
    "NG": {"currency": "NGN", "language": "English"},
    "US": {"currency": "USD", "language": "English"},
    "GB": {"currency": "GBP", "language": "English"},
    "CA": {"currency": "CAD", "language": "English"},
    "GH": {"currency": "GHS", "language": "English"},
    "KE": {"currency": "KES", "language": "English"},
    "ZA": {"currency": "ZAR", "language": "English"},
    "FR": {"currency": "EUR", "language": "French"},
    "DE": {"currency": "EUR", "language": "German"},
    "ES": {"currency": "EUR", "language": "Spanish"},
    "BR": {"currency": "BRL", "language": "Portuguese"},
}
SUPPORTED_CURRENCIES = {"NGN", "USD", "GBP", "EUR", "CAD", "GHS", "KES", "ZAR", "BRL"}
SUPPORTED_LANGUAGES = {"English", "Nigerian Pidgin", "Yoruba", "Hausa", "Igbo", "French", "Spanish", "German", "Portuguese"}

@app.get("/api/preferences")
@login_required
def get_preferences():
    u = request.user
    country = (u.get("country_code") or request.headers.get("CF-IPCountry") or "").upper()[:2]
    defaults = COUNTRY_DEFAULTS.get(country, {"currency": "USD", "language": "English"})
    return jsonify({"country": country or None, "currency": u.get("preferred_currency") or defaults["currency"],
                    "language": u.get("preferred_language") or defaults["language"], "autoDetected": bool(country),
                    "needsSetup": not u.get("country_code")})

@app.post("/api/preferences")
@login_required
def save_preferences():
    d = body(); cur_u = request.user
    country = str(d["country"]).upper()[:2] if "country" in d else (cur_u.get("country_code") or "")
    currency = str(d["currency"]).upper() if "currency" in d else (cur_u.get("preferred_currency") or "NGN")
    language = str(d["language"]) if "language" in d else (cur_u.get("preferred_language") or "English")
    if country and not re.fullmatch(r"[A-Z]{2}", country): return err("Invalid country code.")
    if currency not in SUPPORTED_CURRENCIES: return err("Unsupported currency.")
    if language not in SUPPORTED_LANGUAGES: return err("Unsupported language.")
    q_run("UPDATE evil_users SET country_code=%s,preferred_currency=%s,preferred_language=%s WHERE id=%s",
          (country or None, currency, language, request.user["id"]))
    return jsonify({"success": True, "country": country or None, "currency": currency, "language": language})

@app.get("/api/projects")
@login_required
def list_projects():
    rows = q_all("SELECT id,name,instructions,persona,created_at,updated_at FROM evil_projects WHERE user_id=%s ORDER BY updated_at DESC", (request.user["id"],))
    return jsonify({"projects": [{"id": r["id"], "name": r["name"], "instructions": r["instructions"], "persona": r["persona"], "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"])} for r in rows]})

@app.post("/api/projects")
@login_required
def create_project():
    d = body(); name = str(d.get("name", "")).strip()[:100]; instructions = str(d.get("instructions", "")).strip()[:4000]; persona = str(d.get("persona", "")).strip()[:1000]
    if len(name) < 2: return err("Project name must contain at least 2 characters.")
    row = q_one("INSERT INTO evil_projects(user_id,name,instructions,persona) VALUES (%s,%s,%s,%s) RETURNING id,name,instructions,created_at",
                (request.user["id"], name, instructions, persona))
    return jsonify({"success": True, "project": {"id": row["id"], "name": row["name"], "instructions": row["instructions"], "createdAt": iso(row["created_at"])}}), 201

@app.patch("/api/projects/<int:project_id>")
@login_required
def update_project(project_id):
    d = body()
    if "name" in d and len(str(d["name"]).strip()) < 2: return err("Project name must contain at least 2 characters.")
    row = q_one("UPDATE evil_projects SET name=COALESCE(%s,name),instructions=COALESCE(%s,instructions),persona=COALESCE(%s,persona),updated_at=NOW() WHERE id=%s AND user_id=%s RETURNING id,name,instructions,persona",
                (str(d["name"]).strip()[:100] if "name" in d else None, str(d["instructions"])[:4000] if "instructions" in d else None, str(d["persona"]).strip()[:1000] if "persona" in d else None, project_id, request.user["id"]))
    if not row: return err("Project not found.", 404)
    return jsonify({"success": True, "project": dict(row)})

@app.delete("/api/projects/<int:project_id>")
@login_required
def delete_project(project_id):
    n = q_run("DELETE FROM evil_projects WHERE id=%s AND user_id=%s", (project_id, request.user["id"]))
    return jsonify({"success": bool(n)}), (200 if n else 404)

@app.get("/api/projects/<int:project_id>/files")
@login_required
def project_files(project_id):
    if not q_one("SELECT id FROM evil_projects WHERE id=%s AND user_id=%s", (project_id, request.user["id"])): return err("Project not found.", 404)
    rows = q_all("SELECT id,filename,LEFT(content,1200) AS preview,created_at FROM evil_project_files WHERE project_id=%s AND user_id=%s ORDER BY id DESC", (project_id, request.user["id"]))
    return jsonify({"files": [{"id": r["id"], "filename": r["filename"], "preview": r["preview"], "createdAt": iso(r["created_at"])} for r in rows]})

@app.post("/api/projects/<int:project_id>/files")
@login_required
def add_project_file(project_id):
    d = body(); filename = str(d.get("filename", "file.txt"))[:200]; content = str(d.get("content", ""))[:30000]
    if not content: return err("File content is empty.")
    if not q_one("SELECT id FROM evil_projects WHERE id=%s AND user_id=%s", (project_id, request.user["id"])): return err("Project not found.", 404)
    row = q_one("INSERT INTO evil_project_files(project_id,user_id,filename,content) VALUES (%s,%s,%s,%s) RETURNING id",
                (project_id, request.user["id"], filename, content))
    return jsonify({"success": True, "fileId": row["id"]}), 201

@app.delete("/api/projects/<int:project_id>/files/<int:file_id>")
@login_required
def delete_project_file(project_id, file_id):
    n = q_run("DELETE FROM evil_project_files WHERE id=%s AND project_id=%s AND user_id=%s", (file_id, project_id, request.user["id"]))
    return jsonify({"success": bool(n)}), (200 if n else 404)

def own_project(project_id):
    return q_one("SELECT id,name,instructions,persona FROM evil_projects WHERE id=%s AND user_id=%s", (project_id, request.user["id"]))


def make_snippet(text, q, width=70):
    """A short piece of text around the first match of q."""
    t = re.sub(r"\s+", " ", text or "").strip(); i = t.lower().find(q.lower())
    if i < 0: return t[:2 * width]
    s = max(0, i - width); e = min(len(t), i + len(q) + width)
    return ("..." if s else "") + t[s:e] + ("..." if e < len(t) else "")


@app.get("/api/projects/<int:project_id>/dashboard")
@login_required
def project_dashboard(project_id):
    p = own_project(project_id); uid = request.user["id"]
    if not p: return err("Project not found.", 404)
    c = q_one("SELECT COUNT(*) AS chats, MAX(updated_at) AS last FROM evil_conversations WHERE user_id=%s AND project_id=%s", (uid, project_id))
    m = q_one("SELECT COUNT(*) AS n FROM evil_messages m JOIN evil_conversations c ON c.id=m.conversation_id WHERE c.user_id=%s AND c.project_id=%s", (uid, project_id))
    f = q_one("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)),0) AS chars FROM evil_project_files WHERE user_id=%s AND project_id=%s", (uid, project_id))
    recent = q_all("SELECT id,title,updated_at FROM evil_conversations WHERE user_id=%s AND project_id=%s ORDER BY updated_at DESC LIMIT 5", (uid, project_id))
    return jsonify({"name": p["name"], "chats": c["chats"], "messages": m["n"], "files": f["n"], "fileChars": int(f["chars"]), "lastActivity": iso(c["last"]),
                    "hasPersona": bool(p["persona"]), "recent": [{"id": str(r["id"]), "title": r["title"], "updatedAt": iso(r["updated_at"])} for r in recent]})


@app.get("/api/projects/<int:project_id>/search")
@login_required
@limited("psearch", 30, 60, per="user")
def project_search(project_id):
    if not own_project(project_id): return err("Project not found.", 404)
    q = re.sub(r"\s+", " ", request.args.get("q", "")).strip()[:80]
    if len(q) < 2: return err("Type at least 2 characters.")
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"; uid = request.user["id"]
    msgs = q_all("""SELECT m.conversation_id, c.title, m.role, m.content FROM evil_messages m JOIN evil_conversations c ON c.id=m.conversation_id
                    WHERE c.user_id=%s AND c.project_id=%s AND m.content ILIKE %s ORDER BY m.id DESC LIMIT 15""", (uid, project_id, like))
    files = q_all("SELECT id,filename,content FROM evil_project_files WHERE user_id=%s AND project_id=%s AND (content ILIKE %s OR filename ILIKE %s) ORDER BY id DESC LIMIT 10", (uid, project_id, like, like))
    return jsonify({"results": [{"type": "file", "id": r["id"], "title": r["filename"], "snippet": make_snippet(r["content"], q)} for r in files] +
                               [{"type": "chat", "id": str(r["conversation_id"]), "title": r["title"], "snippet": make_snippet(r["content"], q)} for r in msgs]})


@app.get("/api/projects/<int:project_id>/export")
@login_required
@limited("pexport", 5, 60, per="user")
def project_export(project_id):
    p = own_project(project_id); uid = request.user["id"]
    if not p: return err("Project not found.", 404)
    files = q_all("SELECT filename,content FROM evil_project_files WHERE user_id=%s AND project_id=%s ORDER BY id", (uid, project_id))
    chats = q_all("SELECT id,title,created_at FROM evil_conversations WHERE user_id=%s AND project_id=%s ORDER BY created_at LIMIT 100", (uid, project_id))
    by_chat = {}
    if chats:
        for m in q_all("SELECT conversation_id,role,content FROM evil_messages WHERE conversation_id = ANY(%s::uuid[]) ORDER BY id LIMIT 5000", ([str(c["id"]) for c in chats],)):
            by_chat.setdefault(str(m["conversation_id"]), []).append(m)
    safe = lambda s: re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")[:50] or "item"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("README.txt", f"Project: {p['name']}\nExported from {BRAND}.\nfiles/ = project files, chats/ = every chat in this project (max 100).\n")
        zf.writestr("instructions.txt", (p["instructions"] or "") + (("\n\nPersona:\n" + p["persona"]) if p["persona"] else ""))
        for i, f in enumerate(files, 1): zf.writestr(f"files/{i:02d}-{safe(f['filename'])}.txt", f["content"])
        for i, c in enumerate(chats, 1):
            body_md = f"# {c['title']}\n\n" + "\n\n".join(("**You:** " if m["role"] == "user" else f"**{BRAND}:** ") + m["content"] for m in by_chat.get(str(c["id"]), []))
            zf.writestr(f"chats/{i:03d}-{safe(c['title'])}.md", body_md)
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=f"{safe(p['name'])}-project.zip")


@app.post("/api/projects/<int:project_id>/summarize")
@login_required
@limited("psummary", 5, 60, per="user")
def project_summarize(project_id):
    """One short AI summary of a project (instructions, files and the latest chat answers). Costs no chat message."""
    p = own_project(project_id); uid = request.user["id"]
    if not p: return err("Project not found.", 404)
    if not GROQ_API_KEY: return err("The AI isn't configured yet.", 503)
    files = q_all("SELECT filename,content FROM evil_project_files WHERE user_id=%s AND project_id=%s ORDER BY id DESC LIMIT 8", (uid, project_id))
    chats = q_all("""SELECT c.title, (SELECT m.content FROM evil_messages m WHERE m.conversation_id=c.id AND m.role='assistant' ORDER BY m.id DESC LIMIT 1) AS last_answer
                     FROM evil_conversations c WHERE c.user_id=%s AND c.project_id=%s ORDER BY c.updated_at DESC LIMIT 8""", (uid, project_id))
    if not files and not chats and not p["instructions"]: return err("This project is empty. Add a file or start a chat in it first.")
    ctx = f"Project: {p['name']}\nInstructions: {p['instructions'][:800]}\n"
    ctx += "".join(f"\nFile {f['filename']}: {f['content'][:1200]}" for f in files)
    ctx += "".join(f"\nChat \"{c['title']}\" latest answer: {(c['last_answer'] or '')[:500]}" for c in chats)
    try:
        r = make_client().chat.completions.create(model=GROQ_BALANCED_MODEL, temperature=0.3, max_tokens=700, messages=[
            {"role": "system", "content": "Summarise this project for its owner: what it is about, what has been done, key facts from the files, and 3 sensible next steps. Use short headings and bullet points. Do not invent anything that is not in the material."},
            {"role": "user", "content": ctx[:9000]}])
        text = (r.choices[0].message.content or "").strip()
    except Exception as exc:
        log.error("project summary failed: %s", exc); return err(friendly_ai_error(exc), 502)
    if not text: return err("The AI sent an empty summary. Try again.", 502)
    return jsonify({"success": True, "summary": text})


@app.get("/api/memory")
@login_required
def list_memories():
    rows = q_all("SELECT id,memory,source,category,expires_at,created_at FROM evil_memories WHERE user_id=%s AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at DESC LIMIT 100", (request.user["id"],))
    return jsonify({"memories": [{"id": r["id"], "memory": r["memory"], "source": r["source"], "category": r["category"], "expiresAt": iso(r["expires_at"]), "createdAt": iso(r["created_at"])} for r in rows]})


MEMORY_CATEGORIES = ("general", "personal", "work", "preferences", "goals")
MEMORY_EXPIRY_DAYS = (7, 30, 90)


def parse_expiry(d):
    """-> (provided, days). days is None for 'never expires'. Only 7, 30 or 90 days are accepted."""
    if "expiresInDays" not in d: return False, None
    try: n = int(d.get("expiresInDays") or 0)
    except (TypeError, ValueError): return False, None
    return True, (n if n in MEMORY_EXPIRY_DAYS else None)

@app.post("/api/memory")
@login_required
def add_memory():
    d = body(); memory = str(d.get("memory", "")).strip()[:1000]
    if len(memory) < 3: return err("Enter a useful memory.")
    count = q_one("SELECT COUNT(*) AS n FROM evil_memories WHERE user_id=%s AND (expires_at IS NULL OR expires_at > NOW())", (request.user["id"],))["n"]
    if count >= 100: return err("Memory limit reached. Review or delete older memories first.", 429)
    cat = d.get("category") if d.get("category") in MEMORY_CATEGORIES else "general"; _, days = parse_expiry(d)
    row = q_one("INSERT INTO evil_memories(user_id,memory,source,category,expires_at) VALUES (%s,%s,'user',%s,NOW() + make_interval(days => %s::int)) RETURNING id", (request.user["id"], memory, cat, days))
    return jsonify({"success": True, "id": row["id"]}), 201

@app.patch("/api/memory/<int:memory_id>")
@login_required
def update_memory(memory_id):
    memory = str(body().get("memory", "")).strip()[:1000]
    if len(memory) < 3: return err("Enter a useful memory.")
    d = body(); uid = request.user["id"]
    row = q_one("UPDATE evil_memories SET memory=%s, updated_at=NOW() WHERE id=%s AND user_id=%s RETURNING id", (memory, memory_id, uid))
    if not row: return err("Memory not found.", 404)
    if d.get("category") in MEMORY_CATEGORIES: q_run("UPDATE evil_memories SET category=%s WHERE id=%s AND user_id=%s", (d["category"], memory_id, uid))
    provided, days = parse_expiry(d)
    if provided: q_run("UPDATE evil_memories SET expires_at=NOW() + make_interval(days => %s::int) WHERE id=%s AND user_id=%s", (days, memory_id, uid))
    return jsonify({"success": True})

@app.delete("/api/memory/<int:memory_id>")
@login_required
def delete_memory(memory_id):
    n = q_run("DELETE FROM evil_memories WHERE id=%s AND user_id=%s", (memory_id, request.user["id"]))
    return jsonify({"success": bool(n)}), (200 if n else 404)

@app.post("/api/conversations/<uuid:conversation_id>/memory")
@login_required
def conversation_memory_switch(conversation_id):
    on = body().get("enabled") is not False
    row = q_one("UPDATE evil_conversations SET use_memory=%s WHERE id=%s AND user_id=%s RETURNING id", (on, str(conversation_id), request.user["id"]))
    if not row: return err("Chat not found.", 404)
    return jsonify({"success": True, "enabled": on})


@app.get("/api/styles")
@login_required
def list_styles():
    rows = q_all("SELECT id,name,instruction FROM evil_styles WHERE user_id=%s ORDER BY id", (request.user["id"],))
    return jsonify({"styles": [dict(r) for r in rows]})


@app.post("/api/styles")
@login_required
@limited("styles", 20, 60, per="user")
def create_style():
    d = body(); name = re.sub(r"\s+", " ", str(d.get("name", ""))).strip()[:40]; instruction = str(d.get("instruction", "")).strip()[:500]
    if len(name) < 2 or len(instruction) < 5: return err("Give the style a name and a short instruction (at least 5 characters).")
    if q_one("SELECT COUNT(*) AS n FROM evil_styles WHERE user_id=%s", (request.user["id"],))["n"] >= 20: return err("You can save up to 20 reply styles.")
    row = q_one("INSERT INTO evil_styles(user_id,name,instruction) VALUES (%s,%s,%s) RETURNING id", (request.user["id"], name, instruction))
    return jsonify({"success": True, "id": row["id"]}), 201


@app.delete("/api/styles/<int:style_id>")
@login_required
def delete_style(style_id):
    q_run("DELETE FROM evil_styles WHERE id=%s AND user_id=%s", (style_id, request.user["id"])); return jsonify({"success": True})


@app.get("/api/skills")
@login_required
def list_skills():
    rows = q_all("SELECT id,name,instruction,slash_command FROM evil_skills WHERE user_id=%s ORDER BY name", (request.user["id"],))
    return jsonify({"skills": [dict(r) for r in rows]})

@app.post("/api/skills")
@login_required
def create_skill():
    d = body(); name = str(d.get("name", "")).strip()[:80]; instruction = str(d.get("instruction", "")).strip()[:3000]
    command = re.sub(r"[^a-z0-9_-]", "", str(d.get("command", name.lower().replace(" ", "-"))).lower())[:40]
    if len(name) < 2 or len(instruction) < 5 or not command: return err("Provide a name, slash command and instruction.")
    try:
        row = q_one("INSERT INTO evil_skills(user_id,name,instruction,slash_command) VALUES (%s,%s,%s,%s) RETURNING id",
                    (request.user["id"], name, instruction, command))
    except psycopg2.errors.UniqueViolation: return err("That slash command already exists.", 409)
    return jsonify({"success": True, "id": row["id"], "command": "/" + command}), 201

@app.delete("/api/skills/<int:skill_id>")
@login_required
def delete_skill(skill_id):
    n = q_run("DELETE FROM evil_skills WHERE id=%s AND user_id=%s", (skill_id, request.user["id"]))
    return jsonify({"success": bool(n)}), (200 if n else 404)

@app.post("/api/tools/web-search")
@login_required
@limited("web_search", 15, 60, per="user")
def web_search():
    if not os.environ.get("TAVILY_API_KEY"): return err("Web Search needs the TAVILY_API_KEY environment variable. Add it in Render to enable live research.", 503)
    query = str(body().get("query", "")).strip()[:400]
    if len(query) < 3: return err("Enter a search question.")
    try:
        r = requests.post("https://api.tavily.com/search", json={"api_key": os.environ["TAVILY_API_KEY"], "query": query, "search_depth": "basic", "max_results": 5, "include_answer": True}, timeout=18)
        r.raise_for_status(); data = r.json()
        results = [{"title": x.get("title",""), "url": x.get("url",""), "snippet": x.get("content","")[:900]} for x in data.get("results", []) if x.get("url","").startswith("http")]
        return jsonify({"query": query, "answer": data.get("answer"), "results": results})
    except Exception:
        log.exception("Tavily search failed"); return err("Web search is temporarily unavailable.", 502)

@app.post("/api/tools/agent-research")
@login_required
@limited("agent", 4, 3600, per="user")
def agent_research():
    if not os.environ.get("TAVILY_API_KEY"): return err("Agent research needs TAVILY_API_KEY. Add it in Render to enable web research.", 503)
    topics = body().get("topics", [])
    if not isinstance(topics, list): return err("Topics must be a list.")
    topics = [str(x).strip()[:180] for x in topics[:3] if str(x).strip()]
    if not topics: return err("Add at least one research topic.")
    gathered = []
    for topic in topics:
        r = requests.post("https://api.tavily.com/search", json={"api_key": os.environ["TAVILY_API_KEY"], "query": topic, "search_depth": "basic", "max_results": 3}, timeout=18)
        r.raise_for_status()
        gathered.append({"topic": topic, "sources": [{"title": x.get("title",""), "url": x.get("url",""), "snippet": x.get("content","")[:650]} for x in r.json().get("results", []) if x.get("url","").startswith("http")]})
    return jsonify({"results": gathered})

# ----------------------------------------------------------------------------- pages
@app.route("/")
def index():
    if not session.get("user_id") and not request.args.get("force_login") and not request.args.get("login"):
        return render_template("landing.html", brand=BRAND, plans=PLANS, ref=re.sub(r"[^A-Za-z0-9]", "", request.args.get("ref", ""))[:12])
    ref = re.sub(r"[^A-Za-z0-9]", "", request.args.get("ref", ""))[:12]
    return render_template("index.html", brand=BRAND, ref=ref, paystack=bool(PAYSTACK_SECRET_KEY), support_whatsapp=WHATSAPP_SUPPORT_NUMBER)


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
    if is_disposable_email(email): return err("Please use a permanent email address. Temporary email services aren't allowed.")
    if len(password) < 10: return err("Password must be at least 10 characters.")
    if len(password) > 200: return err("Password is too long.")
    # Usernames are compared case-insensitively so nobody can register "Admin" next to "admin".
    clash = q_one("SELECT email FROM evil_users WHERE LOWER(username)=LOWER(%s) LIMIT 1", (username,))
    if clash and clash["email"] != email: return err("That username or email is already taken.", 409)
    referrer = q_one("SELECT id FROM evil_users WHERE referral_code=%s", (ref,)) if ref else None
    pw_hash = generate_password_hash(password)
    try:
        # New users start on Free with a one-time premium Trial (TRIAL_DAYS). (The old code made them Infinity forever.)
        row = q_one("""INSERT INTO evil_users(username,email,password_hash,plan,trial_ends_at,is_verified,referral_code,referred_by)
                       VALUES (%s,%s,%s,'free', NOW() + (%s || ' days')::interval, FALSE, %s, %s) RETURNING id""",
                    (username, email, pw_hash, str(TRIAL_DAYS), new_referral_code(), referrer["id"] if referrer else None))
    except psycopg2.errors.UniqueViolation:
        # Email already registered. Only an UNVERIFIED, non-admin account with no chats may be resumed (new password, new code).
        # The email owner must still enter the code, so this cannot give anyone access to an inbox they do not control.
        existing = q_one("""SELECT id FROM evil_users WHERE email=%s AND is_verified=FALSE AND is_admin=FALSE
                            AND NOT EXISTS (SELECT 1 FROM evil_conversations c WHERE c.user_id=evil_users.id)""", (email,))
        if not existing: return err("That username or email is already taken.", 409)
        # Security: never overwrite the password or username of an existing unverified account. Anyone could otherwise
        # re-register someone else's email with their own password. We only re-send the code to the real inbox owner.
        log.info("register: resending code for unverified account id=%s", existing["id"])
        how = issue_code(email, "verify", reuse=True)
        msg = "We emailed you a 6-digit code. Enter it below." if how == "emailed" else "Account created! Your code will arrive once the admin approves your account."
        return jsonify({"success": True, "message": msg, "mode": how})
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
    if u and not u["is_verified"]:
        if rate_limit("resend_email:" + hashlib.sha256(email.encode()).hexdigest()[:24], 1, 60):
            how = issue_code(email, "verify", reuse=True)
            log.info("OTP resend result=%s", how)
        else:
            log.info("OTP resend skipped: 60s cooldown")
    return jsonify({"success": True, "message": "If that account needs verification, a code is on its way. If you just asked for one, wait a minute before trying again."})


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
        log.info("AUTH user_verified user_id=%s", u["id"])
        reward_referral(u)
        if not u["welcome_sent"] and mail_enabled():
            def _welcome(uid=u["id"], to=email, name=u["username"]):  # background: verification never waits on the email provider
                if send_mail(to, f"Welcome to {BRAND}", f"Hi {name},\n\nYour account is ready. You have a free {TRIAL_DAYS}-day trial with full access, and you can check in daily for bonus messages.\n\n{SITE_URL or ''}\n\nThe {BRAND} team"):
                    try: q_run("UPDATE evil_users SET welcome_sent=TRUE WHERE id=%s", (uid,))
                    except Exception: log.exception("welcome flag update failed")
                else: log.warning("MAIL welcome_not_sent user_id=%s", uid)
            threading.Thread(target=_welcome, daemon=True).start()
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (u["id"], f"Welcome to {BRAND}! Try Deep mode for hard questions and Fast mode for quick ones."))
    return jsonify({"success": True, "message": "Account verified! You can sign in now."})


REFERRAL_MILESTONES = {3: 30, 5: 75, 10: 200}  # friend count -> bonus messages awarded at that count


def reward_referral(u):
    """Award referral rewards safely when referral IDs are numeric and valid."""
    raw_referrer = u.get("referred_by")
    if not raw_referrer or u.get("referral_rewarded"):
        return
    # Legacy databases may store referred_by as VARCHAR, while newer schemas use BIGINT.
    # Normalize only the value; never cast the database column, which may contain legacy text.
    try:
        referrer_id = int(raw_referrer)
    except (TypeError, ValueError):
        log.warning("Skipping referral reward for user %s: invalid referrer ID", u.get("id"))
        return
    if referrer_id <= 0:
        return
    n_row = q_one("SELECT COUNT(*) AS n FROM evil_users WHERE referred_by::text=%s AND referral_rewarded=TRUE", (str(referrer_id),))
    n = (n_row or {}).get("n", 0)
    q_run("UPDATE evil_users SET referral_rewarded=TRUE, trial_ends_at=GREATEST(COALESCE(trial_ends_at,NOW()),NOW())+INTERVAL '1 day' WHERE id=%s", (u["id"],))
    if n < 10:
        q_run("UPDATE evil_users SET trial_ends_at=GREATEST(COALESCE(trial_ends_at,NOW()),NOW())+INTERVAL '1 day' WHERE id=%s", (referrer_id,))
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (referrer_id, "A friend joined with your link. You both got +1 free day of full access."))
        new_count = n + 1
        bonus = REFERRAL_MILESTONES.get(new_count)
        if bonus:
            q_run("UPDATE evil_users SET bonus_messages=COALESCE(bonus_messages,0)+%s WHERE id=%s", (bonus, referrer_id))
            q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (referrer_id, f"Milestone! {new_count} friends joined with your link. +{bonus} bonus messages."))


@app.post("/login")
@limited("login", 40, 3600)
def login():
    d = body(); username, password = str(d.get("username", "")).strip()[:80], str(d.get("password", ""))
    ip = client_ip()
    pair_fails = q_one("""SELECT COUNT(*) AS n FROM evil_login_attempts
        WHERE success=FALSE AND LOWER(username)=LOWER(%s) AND ip=%s AND created_at > NOW() - INTERVAL '15 minutes'
        AND created_at > COALESCE((SELECT MAX(created_at) FROM evil_login_attempts WHERE success=TRUE AND LOWER(username)=LOWER(%s) AND ip=%s), '-infinity'::timestamptz)""",
        (username, ip, username, ip))["n"]
    ip_fails = q_one("SELECT COUNT(*) AS n FROM evil_login_attempts WHERE success=FALSE AND ip=%s AND created_at > NOW() - INTERVAL '15 minutes'", (ip,))["n"]
    if pair_fails >= 6 or ip_fails >= 30: return err("Too many failed attempts. Try again in 15 minutes.", 429)
    user_fails = q_one("SELECT COUNT(*) AS n FROM evil_login_attempts WHERE success=FALSE AND LOWER(username)=LOWER(%s) AND created_at > NOW() - INTERVAL '15 minutes'", (username,))["n"]
    if user_fails >= 20 and not q_one("SELECT 1 FROM evil_login_attempts WHERE success=TRUE AND LOWER(username)=LOWER(%s) AND ip=%s LIMIT 1", (username, ip)):
        return err("Too many failed attempts. Try again in 15 minutes.", 429)
    user = q_one("SELECT id,username,password_hash,is_verified,is_suspended,is_admin,totp_enabled FROM evil_users WHERE LOWER(username)=LOWER(%s) ORDER BY (username=%s) DESC LIMIT 1", (username, username))
    if not user or not user["password_hash"] or not check_password_hash(user["password_hash"], password):
        q_run("INSERT INTO evil_login_attempts(username,ip,success) VALUES (%s,%s,FALSE)", (username, ip))
        return err("Wrong username or password.", 401)
    if user["is_suspended"]: return err("This account is suspended. Contact support.", 403)
    if not user["is_verified"]: return err("Verify your email first.", 403, needsVerification=True)
    if user["is_admin"] and user["totp_enabled"] and os.environ.get("ADMIN_2FA_DISABLE") != "1":
        session.clear(); session["p2fa"] = user["id"]; session["p2fa_at"] = int(time.time())  # password OK, waiting for the authenticator code
        return jsonify({"success": True, "needs2fa": True})
    return finish_login(user["id"], user["username"], ip)


def finish_login(user_id, username, ip):
    q_run("INSERT INTO evil_login_attempts(username,ip,success) VALUES (%s,%s,TRUE)", (username, ip))
    q_run("UPDATE evil_users SET last_seen_at=NOW() WHERE id=%s", (user_id,))
    u = get_user(user_id)
    session.clear(); session.permanent = True; session["user_id"] = user_id; session["sv"] = u["session_version"] or 0
    register_device(u)
    return jsonify({"success": True, "user": {"username": u["username"], "plan": u["plan"], "isAdmin": u["is_admin"]}})


def totp_code(secret_b32, step):
    import base64, struct
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8), casefold=True)
    h = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest(); o = h[-1] & 15
    return f"{(struct.unpack('>I', h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000:06d}"


def totp_check(secret, code, last_step=0):
    """Authenticator-app code check (RFC 6238, 30s steps, one step of drift). Returns the matched step or None. A step can't be reused."""
    code = re.sub(r"\D", "", str(code or "")); now = int(time.time() // 30)
    if len(code) != 6: return None
    for st in (now, now - 1, now + 1):
        if st > last_step and hmac.compare_digest(totp_code(secret, st), code): return st
    return None


@app.post("/login/2fa")
@limited("login2fa", 15, 900)
def login_2fa():
    uid = session.get("p2fa")
    if not uid or time.time() - session.get("p2fa_at", 0) > 300: session.clear(); return err("Your sign-in timed out. Enter your password again.", 401)
    row = q_one("SELECT username,totp_secret,totp_last_step FROM evil_users WHERE id=%s AND is_admin=TRUE AND totp_enabled=TRUE", (uid,)); ip = client_ip()
    if not row: session.clear(); return err("Sign in again.", 401)
    if q_one("SELECT COUNT(*) AS n FROM evil_login_attempts WHERE success=FALSE AND LOWER(username)=LOWER(%s) AND created_at > NOW() - INTERVAL '15 minutes'", (row["username"],))["n"] >= 8:
        return err("Too many failed attempts. Try again in 15 minutes.", 429)
    st = totp_check(row["totp_secret"], body().get("code"), row["totp_last_step"] or 0)
    if not st:
        q_run("INSERT INTO evil_login_attempts(username,ip,success) VALUES (%s,%s,FALSE)", (row["username"], ip)); return err("Wrong or expired code.", 401)
    q_run("UPDATE evil_users SET totp_last_step=%s WHERE id=%s", (st, uid))
    return finish_login(uid, row["username"], ip)


def device_label(ua):
    ua = ua or ""
    os_ = next((n for p, n in (("Windows", "Windows"), ("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"), ("Mac OS X", "Mac"), ("Linux", "Linux")) if p in ua), "an unknown device")
    br = next((n for p, n in (("Edg/", "Edge"), ("OPR/", "Opera"), ("SamsungBrowser", "Samsung Internet"), ("Firefox/", "Firefox"), ("CriOS", "Chrome"), ("Chrome/", "Chrome"), ("Safari/", "Safari")) if p in ua), "A browser")
    return f"{br} on {os_}"


def register_device(u):
    """Remember this browser; when it is new for an existing account, notify in-app and by email (if mail is set up)."""
    try:
        ua = request.headers.get("User-Agent", "")[:300]; fp = hashlib.sha256(ua.encode()).hexdigest()[:32]; label = device_label(ua)
        had = q_one("SELECT 1 FROM evil_devices WHERE user_id=%s LIMIT 1", (u["id"],))
        row = q_one("INSERT INTO evil_devices(user_id,fp,label,ip) VALUES (%s,%s,%s,%s) ON CONFLICT (user_id,fp) DO UPDATE SET last_seen=NOW(), ip=EXCLUDED.ip RETURNING (xmax = 0) AS is_new", (u["id"], fp, label, client_ip()))
        q_run("DELETE FROM evil_devices WHERE user_id=%s AND id NOT IN (SELECT id FROM evil_devices WHERE user_id=%s ORDER BY last_seen DESC LIMIT 20)", (u["id"], u["id"]))
        if row and row["is_new"] and had:
            tip = "If this wasn't you, change your password and use 'Log out of all other devices' in Settings."
            q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (u["id"], f"New sign-in from {label}. {tip}"))
            if mail_enabled() and u["email"] and not u["email"].endswith(".invalid"):
                threading.Thread(target=send_mail, args=(u["email"], f"New sign-in to your {BRAND} account", f"We noticed a sign-in from {label}.\n\n{tip}"), daemon=True).start()
    except Exception: log.exception("device registration failed")


@app.get("/api/admin/2fa")
@admin_required
def admin_2fa_status():
    return jsonify({"enabled": bool(q_one("SELECT totp_enabled FROM evil_users WHERE id=%s", (request.user["id"],))["totp_enabled"])})


@app.post("/api/admin/2fa/setup")
@admin_required
def admin_2fa_setup():
    import base64
    if q_one("SELECT totp_enabled FROM evil_users WHERE id=%s", (request.user["id"],))["totp_enabled"]: return err("Two-step login is already on.")
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    q_run("UPDATE evil_users SET totp_secret=%s WHERE id=%s", (secret, request.user["id"]))
    return jsonify({"secret": secret, "uri": f"otpauth://totp/{quote(BRAND)}:{quote(request.user['username'])}?secret={secret}&issuer={quote(BRAND)}"})


@app.post("/api/admin/2fa/enable")
@admin_required
@limited("2fa_enable", 10, 900, per="user")
def admin_2fa_enable():
    row = q_one("SELECT totp_secret,totp_enabled FROM evil_users WHERE id=%s", (request.user["id"],))
    if row["totp_enabled"] or not row["totp_secret"]: return err("Start the setup again.")
    st = totp_check(row["totp_secret"], body().get("code"))
    if not st: return err("That code is wrong. Check the time on your phone and try the next code.")
    q_run("UPDATE evil_users SET totp_enabled=TRUE, totp_last_step=%s WHERE id=%s", (st, request.user["id"]))
    audit(request.user["username"], "admin_2fa_enabled"); return jsonify({"success": True})


@app.post("/api/admin/2fa/disable")
@admin_required
@limited("2fa_disable", 10, 900, per="user")
def admin_2fa_disable():
    d = body(); row = q_one("SELECT password_hash,totp_secret,totp_enabled,totp_last_step FROM evil_users WHERE id=%s", (request.user["id"],))
    if not row["totp_enabled"]: return err("Two-step login is already off.")
    if not check_password_hash(row["password_hash"], str(d.get("password", ""))): return err("Wrong password.", 401)
    if not totp_check(row["totp_secret"], d.get("code"), row["totp_last_step"] or 0): return err("Wrong or expired code.", 401)
    q_run("UPDATE evil_users SET totp_enabled=FALSE, totp_secret=NULL, totp_last_step=0 WHERE id=%s", (request.user["id"],))
    audit(request.user["username"], "admin_2fa_disabled"); return jsonify({"success": True})


@app.post("/logout")
def logout(): session.clear(); return jsonify({"success": True})


@app.post("/api/auth/forgot")
@limited("forgot", 6, 3600)
def forgot():
    email = str(body().get("email", "")).strip().lower()
    u = q_one("SELECT id FROM evil_users WHERE email=%s AND is_admin=FALSE", (email,))
    how = issue_code(email, "reset", reuse=True) if u else "emailed"
    return jsonify({"success": True, "mode": how, "message": "If that email has an account, we sent a reset code." if how == "emailed" else "Reset requested. The admin will approve it and send you the code."})


@app.post("/api/auth/reset")
@limited("reset", 20, 3600)
def reset_password():
    d = body(); email, code, pw = str(d.get("email", "")).strip().lower(), str(d.get("code", "")).strip(), str(d.get("password", ""))
    if len(pw) < 10: return err("Password must be at least 10 characters.")
    if not check_code(email, code, "reset"): return err("That code is wrong, expired or not approved yet.", 401)
    q_run("UPDATE evil_users SET password_hash=%s, session_version=session_version+1 WHERE email=%s", (generate_password_hash(pw), email))
    q_run("DELETE FROM evil_otp_requests WHERE email=%s AND purpose='reset'", (email,))
    return jsonify({"success": True, "message": "Password changed. You can sign in now."})


@app.get("/api/me")
@login_required
def me():
    u = request.user
    plan_key, trial = effective_plan(u)
    q_run("UPDATE evil_users SET last_seen_at=NOW() WHERE id=%s AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '5 minutes')", (u["id"],))
    can_persona = CUSTOM_PERSONA_FREE or u["is_admin"] or trial or plan_key != "free"
    refs_row = q_one("SELECT COUNT(*) AS n FROM evil_users WHERE referred_by::text=%s AND referral_rewarded=TRUE", (str(u["id"]),))
    refs = (refs_row or {}).get("n", 0)
    maybe_warn_expiry(u, plan_key, trial); maybe_auto_purge(u["id"])
    offer = relaunch_offer(u)
    return jsonify({
        "promo": get_promo(), "relaunchOffer": offer,
        "user": {"username": u["username"], "email": u["email"], "publicId": u.get("public_id"), "plan": ("infinity" if u["is_admin"] else plan_key), "paidPlan": u["plan"], "isAdmin": u["is_admin"],
                 "streak": u["streak_count"] or 0, "checkedInToday": bool(u["checked_in_today"]), "trial": trial,
                 "planExpiresAt": iso(u["plan_expires_at"]), "customPersona": u["custom_persona"] or "", "canUsePersona": can_persona,
                 "referralCode": u["referral_code"], "referrals": refs, "aboutMe": u["about_me"] or "", "aiNickname": u["ai_nickname"] or "",
                 "hasNewsUpdate": (u["last_seen_changelog"] or 0) < CHANGELOG_VERSION,
                 "country": u.get("country_code"), "currency": u.get("preferred_currency") or "NGN",
                 "language": u.get("preferred_language") or "English", "trialEndsAt": iso(u["trial_ends_at"])},
        "usage": usage_status(u),
        "images": {"used": u["images_today"], "limit": 99999 if u["is_admin"] else PLANS[plan_key]["daily_images"], "edit": cf_enabled()},
        "badges": badges_for(u),
        "plans": PLANS, "billing": {"days": BILLING_DAYS, "multipliers": BILLING_MULTIPLIERS, "trialDays": TRIAL_DAYS}, "paystack": bool(PAYSTACK_SECRET_KEY), "brand": BRAND})


@app.post("/api/user/update-persona")
@login_required
def update_persona():
    u = request.user; plan_key, trial = effective_plan(u)
    if not (CUSTOM_PERSONA_FREE or u["is_admin"] or trial or plan_key != "free"):
        return err("Custom personas are a paid feature. Upgrade to unlock them.", 402)
    text = str(body().get("persona", "")).strip()[:2000]
    q_run("UPDATE evil_users SET custom_persona=%s WHERE id=%s", (text or None, u["id"]))
    return jsonify({"success": True})


@app.post("/api/user/profile-extra")
@login_required
def update_profile_extra():
    d = body(); u = request.user
    about_me = str(d.get("aboutMe", "")).strip()[:800]
    nickname = re.sub(r"\s+", " ", str(d.get("aiNickname", ""))).strip()[:40]
    q_run("UPDATE evil_users SET about_me=%s, ai_nickname=%s WHERE id=%s", (about_me or None, nickname or None, u["id"]))
    return jsonify({"success": True})


@app.post("/api/user/seen-changelog")
@login_required
def seen_changelog():
    q_run("UPDATE evil_users SET last_seen_changelog=%s WHERE id=%s", (CHANGELOG_VERSION, request.user["id"]))
    return jsonify({"success": True})


@app.get("/api/user/sessions")
@login_required
def list_sessions():
    rows = q_all("SELECT ip, created_at FROM evil_login_attempts WHERE username=%s AND success=TRUE ORDER BY created_at DESC LIMIT 5", (request.user["username"],))
    return jsonify({"sessions": [{"ip": r["ip"], "at": iso(r["created_at"])} for r in rows]})


@app.post("/api/user/logout-other-devices")
@login_required
def logout_other_devices():
    row = q_one("UPDATE evil_users SET session_version=session_version+1 WHERE id=%s RETURNING session_version", (request.user["id"],))
    session["sv"] = row["session_version"]  # keep this device signed in; every other cookie now has a stale sv
    return jsonify({"success": True})


def maybe_auto_purge(user_id):
    """Auto-delete setting: at most once a day, delete the user's chats not touched for N days. Pinned and archived chats are always kept."""
    try:
        row = q_one("UPDATE evil_users SET auto_purge_at=NOW() WHERE id=%s AND auto_delete_days IS NOT NULL AND (auto_purge_at IS NULL OR auto_purge_at < NOW() - INTERVAL '1 day') RETURNING auto_delete_days", (user_id,))
        if row: q_run("DELETE FROM evil_conversations WHERE user_id=%s AND pinned=FALSE AND archived=FALSE AND updated_at < NOW() - make_interval(days => %s::int)", (user_id, row["auto_delete_days"]))
    except Exception: log.exception("auto purge failed")


@app.get("/api/privacy/summary")
@login_required
def privacy_summary():
    uid = request.user["id"]; one = lambda sql: q_one(sql, (uid,))["n"]
    devices = q_all("SELECT label,last_seen FROM evil_devices WHERE user_id=%s ORDER BY last_seen DESC LIMIT 20", (uid,))
    return jsonify({"counts": {"chats": one("SELECT COUNT(*) AS n FROM evil_conversations WHERE user_id=%s"), "messages": one("SELECT COUNT(*) AS n FROM evil_messages WHERE user_id=%s"),
                               "memories": one("SELECT COUNT(*) AS n FROM evil_memories WHERE user_id=%s AND (expires_at IS NULL OR expires_at > NOW())"), "notes": one("SELECT COUNT(*) AS n FROM evil_notes WHERE user_id=%s"),
                               "images": one("SELECT COUNT(*) AS n FROM evil_images WHERE user_id=%s"), "projects": one("SELECT COUNT(*) AS n FROM evil_projects WHERE user_id=%s")},
                    "autoDeleteDays": q_one("SELECT auto_delete_days FROM evil_users WHERE id=%s", (uid,))["auto_delete_days"] or 0,
                    "devices": [{"label": r["label"], "lastSeen": iso(r["last_seen"])} for r in devices]})


@app.post("/api/privacy/settings")
@login_required
def privacy_settings():
    try: days = int(body().get("autoDeleteDays", 0))
    except (TypeError, ValueError): return err("Invalid choice.")
    if days not in (0, 30, 90, 180, 365): return err("Invalid choice.")
    q_run("UPDATE evil_users SET auto_delete_days=%s, auto_purge_at=NULL WHERE id=%s", (days or None, request.user["id"]))
    return jsonify({"success": True})


@app.post("/api/privacy/delete-chats")
@login_required
@limited("delete_chats", 5, 3600, per="user")
def privacy_delete_chats():
    if body().get("confirm") is not True: return err("Please confirm.")
    q_run("DELETE FROM evil_conversations WHERE user_id=%s", (request.user["id"],)); return jsonify({"success": True})


REPORT_REASONS = ("harmful", "wrong", "offensive", "other")


@app.post("/api/messages/<int:message_id>/report")
@login_required
@limited("report", 10, 3600, per="user")
def report_message(message_id):
    d = body(); uid = request.user["id"]; reason = d.get("reason") if d.get("reason") in REPORT_REASONS else "other"
    m = q_one("SELECT conversation_id,content FROM evil_messages WHERE id=%s AND user_id=%s AND role='assistant'", (message_id, uid))
    if not m: return err("Message not found.", 404)
    if q_one("SELECT 1 FROM evil_reports WHERE message_id=%s AND user_id=%s", (message_id, uid)): return err("You already reported this answer. Thank you.")
    q = q_one("SELECT content FROM evil_messages WHERE conversation_id=%s AND id < %s AND role='user' ORDER BY id DESC LIMIT 1", (m["conversation_id"], message_id))
    q_run("INSERT INTO evil_reports(user_id,message_id,reason,details,question,answer) VALUES (%s,%s,%s,%s,%s,%s)", (uid, message_id, reason, str(d.get("details", "")).strip()[:500], (q or {}).get("content", "")[:2000], m["content"][:4000]))
    return jsonify({"success": True})


@app.get("/api/admin/reports")
@admin_required
def admin_reports():
    rows = q_all("SELECT r.id,r.reason,r.details,r.question,r.answer,r.created_at,u.username FROM evil_reports r JOIN evil_users u ON u.id=r.user_id WHERE r.status='open' ORDER BY r.id DESC LIMIT 50")
    return jsonify({"reports": [{"id": r["id"], "reason": r["reason"], "details": r["details"], "question": r["question"][:300], "answer": r["answer"][:600], "username": r["username"], "createdAt": iso(r["created_at"])} for r in rows]})


@app.post("/api/admin/reports/<int:report_id>/resolve")
@admin_required
def admin_resolve_report(report_id):
    q_run("UPDATE evil_reports SET status='resolved' WHERE id=%s", (report_id,)); audit(request.user["username"], "report_resolved", f"report {report_id}"); return jsonify({"success": True})


@app.get("/api/user/export")
@login_required
def export_me():
    u = request.user
    chats = q_all("SELECT id,title,created_at FROM evil_conversations WHERE user_id=%s ORDER BY created_at", (u["id"],))
    out = []
    for c in chats:
        msgs = q_all("SELECT role,content,created_at FROM evil_messages WHERE conversation_id=%s ORDER BY id", (str(c["id"]),))
        out.append({"title": c["title"], "created_at": iso(c["created_at"]), "messages": [{"role": m["role"], "content": m["content"], "at": iso(m["created_at"])} for m in msgs]})
    uid = u["id"]
    extra = {
        "memories": [{"memory": r["memory"], "category": r["category"], "created_at": iso(r["created_at"])} for r in q_all("SELECT memory,category,created_at FROM evil_memories WHERE user_id=%s ORDER BY id", (uid,))],
        "notes": [{"title": r["title"], "content": r["content"], "created_at": iso(r["created_at"])} for r in q_all("SELECT title,content,created_at FROM evil_notes WHERE user_id=%s ORDER BY id", (uid,))],
        "reply_styles": [{"name": r["name"], "instruction": r["instruction"]} for r in q_all("SELECT name,instruction FROM evil_styles WHERE user_id=%s ORDER BY id", (uid,))],
        "projects": [{"name": p["name"], "instructions": p["instructions"], "persona": p["persona"],
                      "files": [{"filename": f["filename"], "content": f["content"]} for f in q_all("SELECT filename,content FROM evil_project_files WHERE project_id=%s ORDER BY id", (p["id"],))]}
                     for p in q_all("SELECT id,name,instructions,persona FROM evil_projects WHERE user_id=%s ORDER BY id", (uid,))],
    }
    data = json.dumps({"account": {"username": u["username"], "email": u["email"]}, "conversations": out, **extra}, indent=2)
    return Response(data, mimetype="application/json", headers={"Content-Disposition": "attachment; filename=vyra-data.json"})


@app.post("/api/user/delete")
@login_required
def delete_me():
    u = request.user
    if u["is_admin"]: return err("The admin account can't be deleted here.", 403)
    pw = str(body().get("password", ""))
    row = q_one("SELECT password_hash FROM evil_users WHERE id=%s", (u["id"],))
    if not row or not row["password_hash"] or not check_password_hash(row["password_hash"], pw): return err("Wrong password.", 401)
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
    if mode == "referrals":
        rows = q_all("""SELECT u.username, COUNT(*) AS score FROM evil_users r JOIN evil_users u ON u.id=r.referred_by
                        WHERE r.referral_rewarded=TRUE AND u.is_admin=FALSE GROUP BY u.username ORDER BY score DESC, u.username LIMIT 10""")
        return jsonify({"mode": "referrals", "leaders": [{"username": r["username"], "score": r["score"]} for r in rows]})
    rows = q_all("SELECT username, streak_count AS score FROM evil_users WHERE is_admin=FALSE ORDER BY streak_count DESC NULLS LAST, username LIMIT 10")
    return jsonify({"mode": "streak", "leaders": [{"username": r["username"], "score": r["score"] or 0} for r in rows]})


@app.get("/api/notifications")
@login_required
def get_notifications():
    rows = q_all("SELECT id,message,is_read,created_at FROM evil_notifications WHERE user_id=%s ORDER BY id DESC LIMIT 30", (request.user["id"],))
    return jsonify({"notifications": [{"id": r["id"], "message": r["message"], "is_read": r["is_read"], "created_at": iso(r["created_at"])} for r in rows]})


@app.get("/api/user/direct-messages")
@login_required
def user_direct_messages():
    rows=q_all("SELECT id,message,created_at,read_at FROM evil_admin_messages WHERE user_id=%s ORDER BY id DESC LIMIT 100", (request.user["id"],))
    q_run("UPDATE evil_admin_messages SET read_at=NOW() WHERE user_id=%s AND read_at IS NULL", (request.user["id"],))
    return jsonify({"messages":[{**r,"created_at":iso(r["created_at"]),"read_at":iso(r["read_at"])} for r in rows]})


@app.post("/api/notifications/read")
@login_required
def mark_notifications_read():
    q_run("UPDATE evil_notifications SET is_read=TRUE WHERE user_id=%s", (request.user["id"],)); return jsonify({"success": True})


@app.post("/api/reward-request")
@login_required
@limited("reward_request", 4, 86400, per="user")
def create_reward_request():
    msg = str(body().get("message", "")).strip()[:500]
    if len(msg) < 8: return err("Please describe your reward request (at least 8 characters).")
    row = q_one("INSERT INTO evil_reward_requests(user_id,message) VALUES (%s,%s) RETURNING id", (request.user["id"], msg))
    q_run("INSERT INTO evil_notifications(user_id,message) SELECT id,%s FROM evil_users WHERE is_admin=TRUE", (f"New reward request from {request.user['username']}.",))
    return jsonify({"success": True, "id": row["id"], "message": "Your reward request has been sent to the admin."})


# ----------------------------------------------------------------------------- Image Studio
# Cloudflare Workers AI, FLUX.2 [klein]: one model makes AND edits pictures. Needs CF_ACCOUNT_ID and CF_API_TOKEN in the environment.
# Without them the old free generator is used and editing stays hidden.
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "").strip()
try: CF_DAILY_CAP = max(1, int(os.environ.get("CF_DAILY_IMAGE_CAP", "40")))
except ValueError: CF_DAILY_CAP = 40
CF_GEN_MODEL = os.environ.get("CF_GEN_MODEL", "@cf/black-forest-labs/flux-2-klein-4b").strip()
CF_EDIT_MODEL = os.environ.get("CF_EDIT_MODEL", "@cf/black-forest-labs/flux-2-klein-9b").strip()
IMG_SIZES = {"square": (1024, 1024), "portrait": (768, 1024), "landscape": (1024, 768)}
try:
    from PIL import Image, ImageOps
except Exception:  # Pillow missing: editing is switched off instead of failing
    Image = ImageOps = None


def cf_ready():  # keys present: picture generation can use Cloudflare
    return bool(CF_API_TOKEN and re.fullmatch(r"[0-9a-fA-F]{32}", CF_ACCOUNT_ID))


def cf_enabled():  # editing also needs Pillow to prepare the uploaded picture
    return cf_ready() and Image is not None


def cf_used_today():
    row = q_one(f"SELECT COUNT(*) AS n FROM evil_images WHERE url LIKE 'cf:%' AND (created_at AT TIME ZONE 'Africa/Lagos')::date = {TODAY}")
    return row["n"] if row else 0


def cf_run(model, fields, images=()):
    """One FLUX.2 call (multipart form). Returns (bytes, mime). Raises on any problem; never logs the token."""
    import base64
    files = {k: (None, str(v)) for k, v in fields.items()}
    for i, img in enumerate(images): files[f"input_image_{i}"] = (f"image{i}.jpg", img, "image/jpeg")
    r = requests.post(f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/{model}",
                      headers={"Authorization": f"Bearer {CF_API_TOKEN}"}, files=files, timeout=(5, 60))
    if r.status_code != 200: raise RuntimeError(f"Cloudflare answered {r.status_code}: {r.text[:160]}")
    if r.headers.get("Content-Type", "").lower().startswith("image/"): data = r.content
    else:
        b64 = ((r.json() or {}).get("result") or {}).get("image")
        if not b64: raise RuntimeError("Cloudflare returned no image")
        data = base64.b64decode(b64)
    mime = sniff_image(data)
    if not mime or len(data) > 12 * 1024 * 1024: raise RuntimeError("Cloudflare returned an unusable image")
    return data, mime


def shrink_for_storage(data, mime):
    """Re-saves as a good-quality JPEG so the database stays small and pictures load fast."""
    if Image is None: return data, mime
    try:
        im = Image.open(io.BytesIO(data)).convert("RGB"); buf = io.BytesIO(); im.save(buf, "JPEG", quality=88, optimize=True)
        return (buf.getvalue(), "image/jpeg") if len(buf.getvalue()) < len(data) else (data, mime)
    except Exception:
        return data, mime


def enhance_image_prompt(prompt):
    """Turns a short idea into a rich image prompt with the fast model. Any problem returns the original text."""
    try:
        r = make_client().chat.completions.create(model=GROQ_FAST_MODEL, temperature=0.7, max_tokens=200, timeout=10, messages=[
            {"role": "system", "content": "Rewrite the user's image idea as ONE vivid, detailed prompt for an AI image generator, max 70 words. Cover subject, setting, style, lighting, camera angle/composition and mood. Keep the user's meaning and keep any words they want written in the image, in quotes. Output only the prompt, in English."},
            {"role": "user", "content": prompt}])
        t = (r.choices[0].message.content or "").strip().strip('"').strip()
        return t[:600] if len(t) >= 15 else prompt
    except Exception:
        return prompt


def save_cf_image(uid, prompt, data, mime, tag):
    data, mime = shrink_for_storage(data, mime)
    img = q_one("INSERT INTO evil_images(user_id,prompt,url) VALUES (%s,%s,%s) RETURNING id", (uid, prompt, "cf:" + tag))
    try:
        q_run("INSERT INTO evil_image_blobs(image_id,mime,data) VALUES (%s,%s,%s)", (img["id"], mime, psycopg2.Binary(data)))
    except Exception:
        q_run("DELETE FROM evil_images WHERE id=%s", (img["id"],)); raise
    # Only the 40 newest images are listed, so older stored files are dropped to keep the database small.
    try: q_run("DELETE FROM evil_image_blobs WHERE image_id IN (SELECT id FROM evil_images WHERE user_id=%s ORDER BY id DESC OFFSET 40)", (uid,))
    except Exception: log.exception("image prune failed")
    return img["id"]


def take_image_credit(u, limit):
    # Atomic: only counts if still under today's limit, so parallel clicks can't overshoot.
    return q_one(f"""UPDATE evil_users SET images_generated_today = CASE WHEN last_image_date = {TODAY} THEN images_generated_today+1 ELSE 1 END,
                    last_image_date = {TODAY}
                    WHERE id=%s AND (CASE WHEN last_image_date = {TODAY} THEN images_generated_today ELSE 0 END) < %s RETURNING images_generated_today""", (u["id"], limit))


def refund_image_credit(uid):
    try: q_run(f"UPDATE evil_users SET images_generated_today=GREATEST(0,images_generated_today-1) WHERE id=%s AND last_image_date={TODAY}", (uid,))
    except Exception: log.exception("image refund failed")


def image_limit_for(u):
    plan_key, _ = effective_plan(u)
    return 99999 if u["is_admin"] else PLANS[plan_key]["daily_images"]


@app.post("/api/generate-image")
@login_required
@limited("image", 12, 60, per="user")
def generate_image():
    data_in = body()
    prompt = str(data_in.get("prompt", "")).strip()
    size = data_in.get("size") if data_in.get("size") in IMG_SIZES else "square"
    if not prompt: return err("Describe the image you want first.")
    if len(prompt) > 600: return err("Keep the description under 600 characters.")
    u = request.user; limit = image_limit_for(u)
    row = take_image_credit(u, limit)
    if not row: return err(f"You've used all {limit} images for today. They reset at midnight, or upgrade for more.", 429)
    w, h = IMG_SIZES[size]
    used_prompt = enhance_image_prompt(prompt) if data_in.get("enhance", True) else prompt
    if cf_ready():
        try:
            if cf_used_today() < CF_DAILY_CAP:
                out, mime = cf_run(CF_GEN_MODEL, {"prompt": used_prompt, "width": w, "height": h})
                new_id = save_cf_image(u["id"], prompt, out, mime, "gen")
                return jsonify({"success": True, "image_url": f"/api/images/{new_id}/render", "id": new_id, "used": row["images_generated_today"], "limit": limit, "prompt_used": used_prompt if used_prompt != prompt else ""})
        except Exception:
            log.warning("Cloudflare image generation failed, using the backup generator", exc_info=True)
    seed = secrets.randbelow(10 ** 8)
    url = f"https://image.pollinations.ai/prompt/{quote(used_prompt)}?width={w}&height={h}&nologo=true&seed={seed}"
    img = q_one("INSERT INTO evil_images(user_id,prompt,url) VALUES (%s,%s,%s) RETURNING id", (u["id"], prompt, url))
    return jsonify({"success": True, "image_url": f"/api/images/{img['id']}/render", "id": img["id"], "used": row["images_generated_today"], "limit": limit, "prompt_used": used_prompt if used_prompt != prompt else ""})


@app.post("/api/edit-image")
@login_required
@limited("image_edit", 8, 60, per="user")
def edit_image():
    """Changes an uploaded picture from a plain instruction (FLUX.2 image editing)."""
    if not cf_enabled(): return err("Photo editing is not switched on yet.", 503)
    prompt = str(request.form.get("prompt", "")).strip()
    if len(prompt) < 3: return err("Say what should change in the picture.")
    if len(prompt) > 500: return err("Keep the instruction under 500 characters.")
    f = request.files.get("image")
    if not f: return err("Choose a picture to edit first.")
    raw = f.read(6 * 1024 * 1024 + 1)
    if len(raw) > 6 * 1024 * 1024: return err("That picture is too large. Use one under 6 MB.")
    if sniff_image(raw) not in ("image/png", "image/jpeg", "image/webp"): return err("Use a PNG, JPG or WEBP picture.")
    try:
        im = Image.open(io.BytesIO(raw))
        if im.width * im.height > 25_000_000: return err("That picture is too large.")
        im = ImageOps.exif_transpose(im).convert("RGB")
        k = 1024 / max(im.width, im.height)  # result keeps the picture's own shape
        out_w = min(1920, max(256, round(im.width * k / 16) * 16)); out_h = min(1920, max(256, round(im.height * k / 16) * 16))
        im.thumbnail((512, 512))  # the editor accepts reference pictures up to 512 px
        buf = io.BytesIO(); im.save(buf, "JPEG", quality=92); ref = buf.getvalue()
    except Exception:
        return err("I couldn't read that picture. Try another one.")
    if cf_used_today() >= CF_DAILY_CAP: return err("Photo editing is at its daily limit. Please try again tomorrow.", 503)
    u = request.user; limit = image_limit_for(u)
    row = take_image_credit(u, limit)
    if not row: return err(f"You've used all {limit} images for today. They reset at midnight, or upgrade for more.", 429)
    try:
        out, mime = cf_run(CF_EDIT_MODEL, {"prompt": prompt + ". Keep everything else in the picture the same.", "width": out_w, "height": out_h}, [ref])
        new_id = save_cf_image(u["id"], "Edit: " + prompt[:590], out, mime, "edit")
    except Exception:
        log.warning("Cloudflare image edit failed", exc_info=True)
        refund_image_credit(u["id"]); return err("The editor is busy right now. Your image credit was not used. Try again in a moment.", 502)
    return jsonify({"success": True, "image_url": f"/api/images/{new_id}/render", "id": new_id, "used": row["images_generated_today"], "limit": limit})


@app.get("/api/images")
@login_required
def list_images():
    rows = q_all("SELECT id,prompt,url,created_at FROM evil_images WHERE user_id=%s ORDER BY id DESC LIMIT 40", (request.user["id"],))
    return jsonify({"images": [{"id": r["id"], "prompt": r["prompt"], "display_url": f"/api/images/{r['id']}/render", "created_at": iso(r["created_at"])} for r in rows]})


@app.get("/api/images/<int:image_id>/render")
@login_required
@limited("image_render", 30, 60, per="user")
def render_image_proxy(image_id):
    row = q_one("SELECT url,(created_at > NOW() - INTERVAL '2 minutes') AS fresh FROM evil_images WHERE id=%s AND user_id=%s", (image_id, request.user["id"]))
    if not row: return err("Image not found.", 404)
    if row["url"].startswith("cf:"):
        blob = q_one("SELECT mime,data FROM evil_image_blobs WHERE image_id=%s", (image_id,))
        if not blob: return err("This image is no longer stored.", 404)
        return Response(bytes(blob["data"]), mimetype=blob["mime"], headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})
    uid_ = request.user["id"]

    def failed(msg):
        # A brand-new image the provider could not produce is removed and its daily credit returned, so the gallery never shows a fake image.
        if row["fresh"]:
            try:
                if q_run("DELETE FROM evil_images WHERE id=%s AND user_id=%s", (image_id, uid_)):
                    q_run(f"UPDATE evil_users SET images_generated_today=GREATEST(0,images_generated_today-1) WHERE id=%s AND last_image_date={TODAY}", (uid_,))
            except Exception: log.exception("image refund failed")
        return err(msg, 502)
    source = urlparse(row["url"])
    if source.scheme != "https" or source.hostname != "image.pollinations.ai": return err("Image source is invalid.", 502)
    try:
        upstream = requests.get(row["url"], timeout=(5, 35), stream=True, headers={"User-Agent": "VyraAI/1.0"})
        if upstream.status_code != 200: return failed("Image service is temporarily unavailable.")
        mime = upstream.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if mime not in ("image/png", "image/jpeg", "image/webp", "image/gif"): return failed("Image service returned an unsupported format.")
        length = upstream.headers.get("Content-Length")
        if length and int(length) > 8 * 1024 * 1024: return err("Generated image is too large.", 502)
        data = upstream.content
        if len(data) > 8 * 1024 * 1024: return err("Generated image is too large.", 502)
        return Response(data, mimetype=mime, headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})
    except requests.RequestException:
        log.warning("image provider proxy failed", exc_info=True)
        return failed("Image service is temporarily unavailable. Try again shortly.")


@app.post("/api/images/<int:image_id>/delete")
@login_required
def delete_image(image_id):
    q_run("DELETE FROM evil_images WHERE id=%s AND user_id=%s", (image_id, request.user["id"])); return jsonify({"success": True})


def extract_office_text(data, ext):
    """Plain text from .docx / .xlsx using only the standard library (these files are zips of XML)."""
    import xml.etree.ElementTree as ET
    LIMIT = 15_000_000
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = set(zf.namelist())
        def read(name):
            if zf.getinfo(name).file_size > LIMIT: raise ValueError("file part too large")
            raw = zf.read(name)
            if b"<!DOCTYPE" in raw[:3000] or b"<!ENTITY" in raw[:6000]: raise ValueError("unsafe xml")
            return ET.fromstring(raw)
        if ext == "docx":
            W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"; lines = []
            for p in read("word/document.xml").iter(W + "p"):
                parts = []
                for n in p.iter():
                    if n.tag == W + "t": parts.append(n.text or "")
                    elif n.tag == W + "tab": parts.append("\t")
                line = "".join(parts).strip()
                if line: lines.append(line)
            return "\n".join(lines)
        X = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"; shared = []
        if "xl/sharedStrings.xml" in names:
            shared = ["".join(t.text or "" for t in si.iter(X + "t")) for si in read("xl/sharedStrings.xml").iter(X + "si")]
        sheets = sorted((n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), key=lambda n: int(re.findall(r"\d+", n)[0]))[:5]
        out = []
        for i, n in enumerate(sheets, 1):
            rows = []
            for row in read(n).iter(X + "row"):
                cells = {}
                for pos, c in enumerate(row.iter(X + "c")):
                    m = re.match(r"([A-Z]+)", c.get("r") or ""); col = pos
                    if m:
                        col = 0
                        for ch in m.group(1): col = col * 26 + (ord(ch) - 64)
                        col -= 1
                    v = c.find(X + "v"); t = c.get("t")
                    if t == "s" and v is not None and (v.text or "").isdigit() and int(v.text) < len(shared): val = shared[int(v.text)]
                    elif t == "inlineStr": val = "".join(x.text or "" for x in c.iter(X + "t"))
                    else: val = (v.text or "") if v is not None else ""
                    cells[col] = val
                if cells and any(cells.values()): rows.append("\t".join(cells.get(k, "") for k in range(max(cells) + 1)).rstrip("\t"))
                if len(rows) >= 2000: break
            out.append(f"## Sheet {i}\n" + "\n".join(rows))
        return "\n\n".join(out)


ZIP_TEXT_EXT = {"txt", "md", "csv", "json", "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "cs", "go", "rs", "rb", "php", "sql", "xml", "yml", "yaml", "toml", "ini", "cfg", "sh", "bat", "svg", "vue", "kt", "swift", "dart", "r", "ipynb"}


def extract_zip_text(data):
    """Reads a .zip WITHOUT unpacking anything to disk: lists the files and returns the text of the small, readable ones.
    Guards: file-count limit, per-file read limit (the zip's own size claims are not trusted), no secrets files, no encrypted or binary files."""
    names, chunks, total, skipped = [], [], 0, 0
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > 1000: raise ValueError("too many files")
        for i in infos:
            parts = [p for p in i.filename.replace("\\", "/").split("/") if p]
            if not parts or ".." in parts or parts[0] == "__MACOSX" or parts[-1] == ".DS_Store": continue
            path = "/".join(parts)[:150]; names.append(path)
            leaf = parts[-1].lower(); ext = leaf.rsplit(".", 1)[-1] if "." in leaf else ""
            if leaf.startswith(".env") or leaf in ("id_rsa", "id_ed25519") or ext in ("pem", "key", "p12", "pfx") or "secret" in leaf:
                skipped += 1; continue  # never feed secrets to the AI
            if ext not in ZIP_TEXT_EXT or i.flag_bits & 0x1 or i.file_size > 300_000 or total >= 150_000:
                skipped += 1; continue
            with zf.open(i) as fh: raw = fh.read(300_001)
            if len(raw) > 300_000 or b"\x00" in raw[:2000]: skipped += 1; continue
            txt = raw.decode("utf-8", "replace").strip()
            if txt: chunks.append(f"=== {path} ===\n{txt}"); total += len(txt)
    if not chunks: raise ValueError("no readable text files")
    listing = "Files in the zip (%d%s):\n%s" % (len(names), f", {skipped} not read" if skipped else "", "\n".join("- " + n for n in names[:60]) + ("\n- ..." if len(names) > 60 else ""))
    return listing + "\n\n" + "\n\n".join(chunks)


@app.post("/api/extract-text")
@login_required
@limited("extract", 10, 60, per="user")
def extract_text():
    f = request.files.get("file")
    if not f: return err("Choose a file first.")
    data = f.read(); fname = (f.filename or "").lower(); is_zip = False
    if data.startswith(b"%PDF"):
        try:
            import PyPDF2
            reader = PyPDF2.PdfReader(io.BytesIO(data))
            text = "\n".join((p.extract_text() or "") for p in reader.pages[:30]).strip()
        except Exception:
            log.exception("pdf extract failed"); return err("Couldn't read that PDF. It may be scanned or protected.")
    elif data[:2] == b"PK" and fname.endswith((".docx", ".xlsx")):
        try: text = extract_office_text(data, fname.rsplit(".", 1)[1]).strip()
        except Exception:
            log.exception("office extract failed"); return err("Couldn't read that file. Make sure it is a normal, unprotected .docx or .xlsx.")
    elif data[:2] == b"PK" and fname.endswith(".zip"):
        try: text = extract_zip_text(data).strip(); is_zip = True
        except ValueError as e: return err("That zip has " + str(e) + ".")
        except Exception:
            log.exception("zip extract failed"); return err("Couldn't open that zip. Make sure it is a normal, unprotected .zip file.")
    else:
        return err("Only PDF, Word (.docx), Excel (.xlsx) and Zip (.zip) files are supported right now.")
    if not text: return err("That file has no readable text (a PDF may be a scan).")
    cap = (40000 if request.args.get("for") == "project" else 20000) if is_zip else (30000 if request.args.get("for") == "project" else 6000)  # project files may hold more text than a one-off chat attachment
    return jsonify({"success": True, "text": text[:cap], "truncated": len(text) > cap, "filename": (f.filename or "file")[:120]})


# ----------------------------------------------------------------------------- chats
@app.get("/api/conversations")
@login_required
def conversations():
    archived = request.args.get("archived") == "1"
    rows = q_all("""SELECT id,title,pinned,tags,archived,project_id,folder_id,(share_token IS NOT NULL) AS shared FROM evil_conversations
                    WHERE user_id=%s AND archived=%s ORDER BY pinned DESC, updated_at DESC LIMIT 80""", (request.user["id"], archived))
    return jsonify({"conversations": [{"id": str(r["id"]), "title": r["title"], "pinned": r["pinned"], "shared": r["shared"],
                                        "tags": r["tags"] or "", "archived": r["archived"], "projectId": r["project_id"], "folderId": r["folder_id"]} for r in rows]})


def folder_name():
    return re.sub(r"\s+", " ", str(body().get("name", ""))).strip()[:40]


@app.get("/api/folders")
@login_required
def list_folders():
    rows = q_all("SELECT id,name FROM evil_folders WHERE user_id=%s ORDER BY id", (request.user["id"],))
    return jsonify({"folders": [{"id": r["id"], "name": r["name"]} for r in rows]})


@app.post("/api/folders")
@login_required
@limited("folders", 20, 60, per="user")
def create_folder():
    name = folder_name(); uid = request.user["id"]
    if not name: return err("Give the folder a name.")
    if q_one("SELECT COUNT(*) AS n FROM evil_folders WHERE user_id=%s", (uid,))["n"] >= 30: return err("You can have up to 30 folders.")
    if q_one("SELECT id FROM evil_folders WHERE user_id=%s AND LOWER(name)=LOWER(%s)", (uid, name)): return err("You already have a folder with that name.")
    row = q_one("INSERT INTO evil_folders(user_id,name) VALUES (%s,%s) RETURNING id", (uid, name))
    return jsonify({"success": True, "id": row["id"], "name": name})


@app.post("/api/folders/<int:folder_id>/rename")
@login_required
def rename_folder(folder_id):
    name = folder_name(); uid = request.user["id"]
    if not name: return err("Give the folder a name.")
    if q_one("SELECT id FROM evil_folders WHERE user_id=%s AND LOWER(name)=LOWER(%s) AND id<>%s", (uid, name, folder_id)): return err("You already have a folder with that name.")
    row = q_one("UPDATE evil_folders SET name=%s WHERE id=%s AND user_id=%s RETURNING id", (name, folder_id, uid))
    if not row: return err("Folder not found.", 404)
    return jsonify({"success": True, "name": name})


@app.delete("/api/folders/<int:folder_id>")
@login_required
def delete_folder(folder_id):
    """Deleting a folder never deletes chats: they simply go back to the main list (ON DELETE SET NULL)."""
    q_run("DELETE FROM evil_folders WHERE id=%s AND user_id=%s", (folder_id, request.user["id"])); return jsonify({"success": True})


@app.post("/api/conversations/<uuid:conversation_id>/folder")
@login_required
def move_to_folder(conversation_id):
    fid = body().get("folderId"); uid = request.user["id"]
    if fid is not None:
        try: fid = int(fid)
        except (TypeError, ValueError): return err("Invalid folder.")
        if not q_one("SELECT id FROM evil_folders WHERE id=%s AND user_id=%s", (fid, uid)): return err("Folder not found.", 404)
    row = q_one("UPDATE evil_conversations SET folder_id=%s WHERE id=%s AND user_id=%s RETURNING id", (fid, str(conversation_id), uid))
    if not row: return err("Chat not found.", 404)
    return jsonify({"success": True})


@app.post("/api/conversations/<uuid:conversation_id>/branch")
@login_required
@limited("branch", 10, 60, per="user")
def branch_conversation(conversation_id):
    """Copy a chat up to and including one message into a new chat, so the user can explore a different direction."""
    uid = request.user["id"]; c = q_one("SELECT title,project_id,folder_id FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), uid))
    if not c: return err("Chat not found.", 404)
    try: mid = int(body().get("messageId"))
    except (TypeError, ValueError): return err("Pick a message to branch from.")
    if not q_one("SELECT id FROM evil_messages WHERE id=%s AND conversation_id=%s AND user_id=%s", (mid, str(conversation_id), uid)): return err("Message not found.", 404)
    new_id = str(uuid.uuid4()); title = ("Branch: " + c["title"])[:150]
    with db() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO evil_conversations(id,user_id,title,project_id,folder_id) VALUES (%s,%s,%s,%s,%s)", (new_id, uid, title, c["project_id"], c["folder_id"]))
        cur.execute("""INSERT INTO evil_messages(conversation_id,user_id,role,content,attachment_type,attachment_url,mode)
                       SELECT %s,user_id,role,content,attachment_type,attachment_url,mode FROM evil_messages WHERE conversation_id=%s AND id<=%s ORDER BY id""", (new_id, str(conversation_id), mid))
    return jsonify({"success": True, "id": new_id})


@app.post("/api/conversations/<uuid:conversation_id>/tags")
@login_required
def tag_conversation(conversation_id):
    tags = re.sub(r"\s*,\s*", ", ", str(body().get("tags", "")).strip())[:200]
    row = q_one("UPDATE evil_conversations SET tags=%s WHERE id=%s AND user_id=%s RETURNING tags", (tags or None, str(conversation_id), request.user["id"]))
    if not row: return err("Chat not found.", 404)
    return jsonify({"success": True, "tags": row["tags"] or ""})


@app.post("/api/conversations/<uuid:conversation_id>/archive")
@login_required
def archive_conversation(conversation_id):
    row = q_one("UPDATE evil_conversations SET archived = NOT archived WHERE id=%s AND user_id=%s RETURNING archived", (str(conversation_id), request.user["id"]))
    if not row: return err("Chat not found.", 404)
    return jsonify({"success": True, "archived": row["archived"]})


@app.get("/api/conversations/export-all")
@login_required
def export_all_conversations():
    u = request.user
    chats = q_all("SELECT id,title,created_at FROM evil_conversations WHERE user_id=%s ORDER BY created_at", (u["id"],))
    parts = [f"{BRAND} - all conversations for {u['username']}\n"]
    for c in chats:
        msgs = q_all("SELECT role,content FROM evil_messages WHERE conversation_id=%s ORDER BY id", (str(c["id"]),))
        parts.append("\n\n===== " + c["title"] + " (" + fmt_date_only(c["created_at"]) + ") =====\n" +
                     "\n\n".join((("You" if m["role"] == "user" else BRAND) + ":\n" + m["content"]) for m in msgs))
    return Response("".join(parts), mimetype="text/plain", headers={"Content-Disposition": "attachment; filename=vyra-all-chats.txt"})


def fmt_date_only(v):
    try: return v.strftime("%Y-%m-%d")
    except Exception: return str(v)[:10]


def own_conversation(conversation_id):
    return q_one("SELECT id,title,share_token,project_id,use_memory FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conversation_id), request.user["id"]))


@app.get("/api/conversations/<uuid:conversation_id>")
@login_required
def get_conversation(conversation_id):
    c = own_conversation(conversation_id)
    if not c: return err("Chat not found.", 404)
    msgs = q_all("SELECT id,role,content,attachment_type,attachment_url,feedback,pinned,mode,created_at FROM evil_messages WHERE conversation_id=%s ORDER BY id", (str(conversation_id),))
    out = [dict(m) for m in msgs]
    for m in out: m["created_at"] = iso(m["created_at"])
    return jsonify({"title": c["title"], "shareToken": c["share_token"], "projectId": c["project_id"], "useMemory": c["use_memory"] is not False, "messages": out})


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


@app.post("/api/messages/<int:message_id>/pin")
@login_required
def pin_message(message_id):
    row = q_one("UPDATE evil_messages SET pinned = NOT pinned WHERE id=%s AND user_id=%s RETURNING pinned", (message_id, request.user["id"]))
    if not row: return err("Message not found.", 404)
    return jsonify({"success": True, "pinned": row["pinned"]})


def clean_followups(text):
    """Turn the model's raw reply into up to 3 short follow-up questions."""
    out = []
    for line in (text or "").splitlines():
        line = re.sub(r"^\s*(?:[-*\u2022]|\d+[.)])\s*", "", line).strip().strip("\"'")
        if 3 <= len(line) <= 70 and line not in out: out.append(line)
    return out[:3]


@app.post("/api/messages/<int:message_id>/followups")
@login_required
@limited("followups", 20, 60, per="user")
def message_followups(message_id):
    """3 short follow-up suggestions for an answer. Uses the fast model, costs no chat message."""
    m = q_one("SELECT conversation_id,content FROM evil_messages WHERE id=%s AND user_id=%s AND role='assistant'", (message_id, request.user["id"]))
    if not m: return err("Message not found.", 404)
    if not GROQ_API_KEY: return jsonify({"followups": []})
    prev = q_one("SELECT content FROM evil_messages WHERE conversation_id=%s AND id < %s AND role='user' ORDER BY id DESC LIMIT 1", (m["conversation_id"], message_id))
    try:
        r = make_client().chat.completions.create(model=GROQ_FAST_MODEL, temperature=0.6, max_tokens=80, messages=[
            {"role": "system", "content": "Suggest 3 short follow-up questions the user might ask next. One per line, each under 8 words, no numbering, no quotes. Reply with the 3 lines only, in the same language as the user."},
            {"role": "user", "content": f"User asked: {(prev or {}).get('content', '')[:300]}\nAssistant answered: {m['content'][:700]}"}])
        return jsonify({"followups": clean_followups(r.choices[0].message.content)})
    except Exception:
        log.info("followups skipped"); return jsonify({"followups": []})


@app.get("/api/notes")
@login_required
def list_notes():
    rows = q_all("SELECT id,title,content,created_at FROM evil_notes WHERE user_id=%s ORDER BY id DESC LIMIT 200", (request.user["id"],))
    out = [dict(r) for r in rows]
    for r in out: r["created_at"] = iso(r["created_at"])
    return jsonify({"notes": out})


@app.post("/api/notes")
@login_required
@limited("notes", 30, 60, per="user")
def add_note():
    d = body(); content = str(d.get("content", "")).strip()[:20000]
    if not content: return err("Nothing to save.")
    if q_one("SELECT COUNT(*) AS n FROM evil_notes WHERE user_id=%s", (request.user["id"],))["n"] >= 200: return err("You have 200 notes. Delete a few first.")
    conv = d.get("conversationId")
    if conv and not q_one("SELECT id FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conv), request.user["id"])): conv = None
    title = re.sub(r"\s+", " ", str(d.get("title") or "")).strip()[:120] or re.sub(r"[#*_`>\s]+", " ", content).strip()[:60] or "Note"
    row = q_one("INSERT INTO evil_notes(user_id,conversation_id,title,content) VALUES (%s,%s,%s,%s) RETURNING id", (request.user["id"], str(conv) if conv else None, title, content))
    return jsonify({"success": True, "id": row["id"]})


@app.delete("/api/notes/<int:note_id>")
@login_required
def delete_note(note_id):
    q_run("DELETE FROM evil_notes WHERE id=%s AND user_id=%s", (note_id, request.user["id"])); return jsonify({"success": True})


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


@app.post("/api/export-answer-zip")
@login_required
def export_answer_zip():
    d = body()
    content = str(d.get("content", ""))
    if not content or len(content) > 50000:
        return err("Provide an answer under 50,000 characters to export.", 400)
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", str(d.get("filename", "vyra-answer.md")))[:80] or "vyra-answer.md"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(safe_name, content)
        zf.writestr("README.txt", "Exported from VYRA AI.\n")
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name="vyra-answer.zip")


@app.post("/ask/stream")
@login_required
@limited("chat", 25, 60, per="user")
def ask_stream():
    d = body(); u = request.user
    question = str(d.get("question", "")).strip()
    conv_id = d.get("conversationId"); persona = str(d.get("persona", "assistant")); language = str(d.get("language", "English"))
    project_id = d.get("projectId")
    if project_id:
        try: project_id = int(project_id)
        except (TypeError, ValueError): return err("Invalid project.")
        if not q_one("SELECT id FROM evil_projects WHERE id=%s AND user_id=%s", (project_id, u["id"])): return err("Project not found.", 404)
    model_type = str(d.get("modelType")) if d.get("modelType") in ("fast", "balanced", "deep") else "deep"
    length_pref = str(d.get("length")) if d.get("length") in LENGTH_PROMPTS else None
    tone_pref = str(d.get("tone")) if d.get("tone") in TONE_PROMPTS else None
    eli5 = bool(d.get("eli5"))
    mem_req = d.get("useMemory") is not False; style_id = d.get("styleId")
    try: temp = max(0.0, min(1.0, float(d.get("temperature", 0.7))))
    except (TypeError, ValueError): temp = 0.7
    extra = str(d.get("fileText", ""))[:6000]
    trunc = None
    if d.get("truncateFromId"):
        try: trunc = int(d["truncateFromId"])
        except (TypeError, ValueError): return err("Invalid message reference.")
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
                cur.execute("SELECT id,project_id,use_memory FROM evil_conversations WHERE id=%s AND user_id=%s", (str(conv_id), u["id"]))
                existing_conv = cur.fetchone()
                if not existing_conv: refund(); return err("Chat not found.", 404)
                if not project_id: project_id = existing_conv.get("project_id")
                mem_on = existing_conv.get("use_memory") is not False
            else:
                conv_id = str(uuid.uuid4()); is_new = True
                mem_on = mem_req
                cur.execute("INSERT INTO evil_conversations(id,user_id,title,project_id,use_memory) VALUES (%s,%s,%s,%s,%s)", (conv_id, u["id"], (question[:40] + "...") if len(question) > 40 else question, project_id, mem_on))
            if trunc: cur.execute("SELECT role,content FROM evil_messages WHERE conversation_id=%s AND id < %s ORDER BY id DESC LIMIT 16", (conv_id, trunc))  # edit/regenerate: ignore that message and later ones
            else: cur.execute("SELECT role,content FROM evil_messages WHERE conversation_id=%s ORDER BY id DESC LIMIT 16", (conv_id,))
            history = list(reversed(cur.fetchall()))
    except Exception:
        log.exception("ask_stream setup failed"); refund(); return err("Couldn't start that chat. Please try again.", 500)

    can_persona = CUSTOM_PERSONA_FREE or u["is_admin"] or trial or plan_key != "free"
    sys_prompt = u["custom_persona"] if (u["custom_persona"] and can_persona) else PERSONAS.get(persona, PERSONAS["assistant"])["instructions"]
    sys_prompt += ("\nPersonality: be warm, witty and playful, like a clever friend. Answer the question first, then add a little fun. "
                   "When the user jokes or chats casually, joke back lightly, match their energy and slang (including Nigerian Pidgin if they use it), and use an emoji now and then. "
                   "If they make a playful request you cannot literally do (for example asking you to give them money), reply with a funny, good-natured answer instead of a flat refusal. "
                   "Never answer a harmless message with just 'I can't help with that'. For study, code and business work, stay clear and focused with only light humour. "
                   "Politely and briefly decline only genuinely harmful requests, without lecturing.\n"
                   "Files: you CAN make downloadable files. When the user asks you to create, export or give them a file (any text-based type such as txt, md, csv, json, html, css, js, py, svg, xml, or a real Word .docx, Excel .xlsx or PDF), "
                   "write each file as a fenced block whose language is exactly vyrafile, with the filename and extension (folders allowed, like site/index.html) alone on the FIRST line and the file content after it. "
                   "Use several blocks for several files; the app lets the user download them together as a zip. For .docx and .pdf write simple markdown (# headings, - bullets, blank lines). For .xlsx write CSV. "
                   "Never say you cannot create files. Add one short line saying what you made. Do not use vyrafile for ordinary code the user only wants to read.")
    sys_prompt += f"\n{BRAND} was created by COLD. If asked who created, built or owns {BRAND}, say it was created by COLD."
    remember_note = ""
    m_rem = re.match(r"^\s*(?:please\s+)?remember(?:\s+that\b|\s*:)\s*(.{3,500})$", question, re.I | re.S)
    if m_rem and not mem_on:
        remember_note = "\nThe user's memory is switched off for this chat, so NOTHING was saved. Tell them to turn on 'Use my memory in this chat' in Options if they want it remembered."
    elif m_rem:  # "remember that ..." really saves to the user's memory (same table the Memory page shows)
        try:
            if q_one("SELECT COUNT(*) AS n FROM evil_memories WHERE user_id=%s AND (expires_at IS NULL OR expires_at > NOW())", (u["id"],))["n"] < 100:
                q_run("INSERT INTO evil_memories(user_id,memory,source) VALUES (%s,%s,'chat')", (u["id"], m_rem.group(1).strip()[:1000]))
                remember_note = "\nThe user asked you to remember something and it has just been saved to their memory. Confirm briefly in one sentence."
            else:
                remember_note = "\nThe user's memory is full (100 items), so NOTHING was saved. Tell them to delete old memories in Projects & Memory."
        except Exception: log.exception("chat memory save failed")
    memories = relevant_memories(u["id"], question) if mem_on else []
    sys_prompt += remember_note
    if memories:
        sys_prompt += "\nUser-approved memory (use only when relevant; do not assume it is always current): " + " | ".join(x["memory"] for x in memories)
    if project_id:
        project = q_one("SELECT name,instructions,persona FROM evil_projects WHERE id=%s AND user_id=%s", (project_id, u["id"]))
        project_files = q_all("SELECT filename,content FROM evil_project_files WHERE project_id=%s AND user_id=%s ORDER BY id DESC LIMIT 5", (project_id, u["id"]))
        if project:
            sys_prompt += f"\nProject workspace: {project['name']}. Project instructions: {project['instructions']}"
            if project.get("persona"): sys_prompt += f"\nFor this project, take on this persona: {project['persona']}"
            for pf in project_files:
                sys_prompt += f"\nProject file {pf['filename']}: {pf['content'][:5000]}"
    # A saved Skill can be invoked by its slash command at the beginning of a message.
    skill_match = re.match(r"^/([a-z0-9_-]+)\s*", question, re.I)
    if skill_match:
        skill = q_one("SELECT name,instruction FROM evil_skills WHERE user_id=%s AND slash_command=%s", (u["id"], skill_match.group(1).lower()))
        if skill:
            sys_prompt += f"\nActive saved Skill ({skill['name']}): {skill['instruction']}"
            question = question[skill_match.end():].strip() or "Apply the saved Skill to my next task."
    creator_terms = re.compile(r"\b(who (made|created|built|developed) you|who (is|was) the creator (of )?(vyra|you)|who (is|was) (your|vyra) (creator|developer|founder)|your creator|your developer|who is cold|who created vyra|vyra creator|contact (your|the) creator)\b", re.I)
    if creator_terms.search(question):
        sys_prompt += "\nIf the user asks who created/developed VYRA or asks to contact its creator, identify the creator as COLD. Share only these official contact options: Telegram support https://t.me/COLDFX26 and WhatsApp support https://wa.me/2348100481004. Invite them to use the official support channel for reports and enquiries. Do not invent additional contact accounts or personal details."

    creator_hit = bool(len(question) <= 200 and creator_terms.search(question))
    if LANGUAGES.get(language): sys_prompt += " " + LANGUAGES[language] + " Keep code and technical terms in English."
    if length_pref: sys_prompt += " " + LENGTH_PROMPTS[length_pref]
    if tone_pref: sys_prompt += " " + TONE_PROMPTS[tone_pref]
    if style_id:
        try: st = q_one("SELECT instruction FROM evil_styles WHERE id=%s AND user_id=%s", (int(style_id), u["id"]))
        except (TypeError, ValueError): st = None
        if st: sys_prompt += " Reply style to follow: " + st["instruction"]
    if eli5: sys_prompt += " " + ELI5_PROMPT
    if u["about_me"]: sys_prompt += f" Here is some context about the person you're talking to, use it only when relevant: {u['about_me']}"
    user_content = f"{question}\n\n[Attached file text]\n{extra}" if extra else question
    messages = [{"role": "system", "content": sys_prompt}] + [{"role": m["role"], "content": m["content"]} for m in history] + [{"role": "user", "content": user_content}]
    user_id = u["id"]

    start_model = {"fast": GROQ_FAST_MODEL, "balanced": GROQ_BALANCED_MODEL, "deep": GROQ_MODEL}[model_type]

    def generate():
        collected, model, tried_fallback, started, truncated = [], start_model, False, False, False
        yield sse({"start": conv_id})
        if creator_hit:  # fixed answer: does not depend on the model following a prompt, in Fast and Deep alike, and costs no tokens
            refund()
            yield sse({"t": CREATOR_ANSWER})
            ids = save_turn(conv_id, user_id, question, CREATOR_ANSWER, is_new, trunc, model_type)
            yield sse({"done": conv_id, "messageId": ids[1], "userMessageId": ids[0], "truncated": False}); return
        try:
            while True:
                try:
                    if model_type == "deep":
                        draft_resp = make_client().chat.completions.create(model=model, messages=messages, temperature=temp, stream=False, max_tokens=2000)
                        draft = (draft_resp.choices[0].message.content or "").strip()
                        if not draft: raise RuntimeError("The model returned an empty draft.")
                        review_messages = [
                            {"role": "system", "content": "You are a rigorous answer reviewer. Check the draft for factual errors, missed constraints, arithmetic or logic mistakes, unsupported certainty, and unclear wording. Rewrite it into the best final answer. Preserve useful detail. Do not mention this review process."},
                            {"role": "user", "content": "Original request:\n" + question + "\n\nDraft answer:\n" + draft}
                        ]
                        reviewed = make_client().chat.completions.create(model=model, messages=review_messages, temperature=0.2, stream=False, max_tokens=2000)
                        final_text = (reviewed.choices[0].message.content or draft).strip()
                        collected.append(final_text); started = True
                        for offset in range(0, len(final_text), 180):
                            yield sse({"t": final_text[offset:offset+180]})
                        break
                    stream = make_client().chat.completions.create(model=model, messages=messages, temperature=temp, stream=True, max_tokens=1500)
                    for chunk in stream:
                        if not chunk.choices: continue
                        delta = chunk.choices[0].delta.content or ""
                        if delta: started = True; collected.append(delta); yield sse({"t": delta})
                        if getattr(chunk.choices[0], "finish_reason", None) == "length": truncated = True
                    break
                except Exception as exc:
                    # Retry once on the fast model if the deep model failed before saying anything.
                    if not started and not tried_fallback and model != GROQ_FAST_MODEL:
                        tried_fallback = True; model = GROQ_FAST_MODEL; yield sse({"notice": "Deep mode is busy, switched to Fast mode."}); continue
                    raise
        except GeneratorExit:  # the user pressed Stop or closed the tab: keep what was written
            if collected: save_turn(conv_id, user_id, question, "".join(collected), False, trunc, model_type)
            else:
                refund()
                if is_new: drop_empty_conversation(conv_id, user_id)
            raise
        except Exception as exc:
            log.error("AI stream failed: %s", exc)
            if collected: save_turn(conv_id, user_id, question, "".join(collected), False, trunc, model_type)
            else:
                refund()
                if is_new: drop_empty_conversation(conv_id, user_id)
            yield sse({"error": friendly_ai_error(exc)}); return
        answer = "".join(collected).strip()
        if not answer:
            refund()
            if is_new: drop_empty_conversation(conv_id, user_id)
            yield sse({"error": "The AI sent an empty reply. Try again."}); return
        ids = save_turn(conv_id, user_id, question, answer, is_new, trunc, model_type)
        yield sse({"done": conv_id, "messageId": ids[1], "userMessageId": ids[0], "truncated": truncated})

    return Response(stream_with_context(generate()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def relevant_memories(user_id, question, limit=12):
    """Memories that share words with the question come first; the rest of the budget is filled with the newest ones."""
    rows = q_all("SELECT memory FROM evil_memories WHERE user_id=%s AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at DESC LIMIT 100", (user_id,))
    if len(rows) <= limit: return rows
    words = set(w for w in re.findall(r"[a-z0-9]{4,}", question.lower()))
    scored = [(len(words & set(re.findall(r"[a-z0-9]{4,}", r["memory"].lower()))), i, r) for i, r in enumerate(rows)]
    hits = [x for x in sorted(scored, key=lambda t: (-t[0], t[1])) if x[0] > 0][:limit // 2]
    chosen = [x[2] for x in hits]
    for r in rows:
        if len(chosen) >= limit: break
        if r not in chosen: chosen.append(r)
    return chosen


def drop_empty_conversation(conv_id, user_id):
    """A chat whose first answer failed has no messages: remove the empty shell so history is never left with a ghost chat."""
    try: q_run("DELETE FROM evil_conversations WHERE id=%s AND user_id=%s AND NOT EXISTS (SELECT 1 FROM evil_messages m WHERE m.conversation_id=evil_conversations.id)", (conv_id, user_id))
    except Exception: log.exception("empty chat cleanup failed")


CREATOR_ANSWER = (f"I'm {BRAND}, created by COLD. For reports, questions or business enquiries, please use the official support channels: "
                  "Telegram https://t.me/COLDFX26 or WhatsApp https://wa.me/2348100481004.")


def save_turn(conv_id, user_id, question, answer, retitle, truncate_from=None, mode=None):
    try:
        with db() as conn, conn.cursor() as cur:
            if truncate_from: cur.execute("DELETE FROM evil_messages WHERE conversation_id=%s AND id >= %s", (conv_id, truncate_from))  # same transaction as the new messages
            cur.execute("INSERT INTO evil_messages(conversation_id,user_id,role,content) VALUES (%s,%s,'user',%s) RETURNING id", (conv_id, user_id, question)); uid = cur.fetchone()["id"]
            cur.execute("INSERT INTO evil_messages(conversation_id,user_id,role,content,mode) VALUES (%s,%s,'assistant',%s,%s) RETURNING id", (conv_id, user_id, answer, mode if mode in ("fast", "balanced", "deep") else None)); aid = cur.fetchone()["id"]
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


def clean_coupon(v):
    return re.sub(r"[^A-Z0-9_-]", "", str(v or "").upper())[:32]


def coupon_quote(cur, user_id, plan, period, code, lock=False):
    """Returns (final_amount_ngn, coupon_row_or_None, base_amount). Raises ValueError with a user-friendly message.
    Server-side only: the browser can never choose the price. Usage is counted from real pending/approved payment requests."""
    base = int(round(PLANS[plan]["price"] * BILLING_MULTIPLIERS[period]))
    if not code: return base, None, base
    cur.execute("SELECT id,discount_type,discount_value,applicable_plan,max_uses,(expires_at IS NOT NULL AND expires_at <= NOW()) AS expired FROM evil_coupons WHERE code=%s AND active=TRUE" + (" FOR UPDATE" if lock else ""), (code,))
    c = cur.fetchone()
    if not c: raise ValueError("Coupon is invalid or inactive.")
    if c["expired"]: raise ValueError("Coupon has expired.")
    if c["applicable_plan"] and c["applicable_plan"] != plan: raise ValueError("Coupon does not apply to that plan.")
    cur.execute("""SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE r.user_id=%s) AS mine FROM evil_coupon_redemptions r
                   JOIN evil_payment_requests p ON p.id=r.payment_request_id WHERE r.coupon_id=%s AND p.status IN ('pending','approved')""", (user_id, c["id"]))
    used = cur.fetchone()
    if used["mine"]: raise ValueError("You have already used this coupon.")
    if c["max_uses"] is not None and used["n"] >= c["max_uses"]: raise ValueError("Coupon usage limit reached.")
    value = float(c["discount_value"])
    discount = base * value / 100.0 if c["discount_type"] == "percent" else value
    return max(100, int(round(base - discount))), c, base  # 100 NGN floor: Paystack rejects tiny amounts


def sync_coupon_uses(cur, coupon_id):
    cur.execute("""UPDATE evil_coupons SET uses=(SELECT COUNT(*) FROM evil_coupon_redemptions r JOIN evil_payment_requests p ON p.id=r.payment_request_id
                   WHERE r.coupon_id=%s AND p.status IN ('pending','approved')) WHERE id=%s""", (coupon_id, coupon_id))


def create_payment_request(u, plan, period, provider, reference=None, coupon=""):
    """One transaction: validates the coupon (row-locked), stores the discounted amount, records the redemption."""
    days = BILLING_DAYS[period]
    with db() as conn, conn.cursor() as cur:
        amount, c, base = coupon_quote(cur, u["id"], plan, period, coupon, lock=True)
        cur.execute("""INSERT INTO evil_payment_requests(user_id,plan,amount_ngn,provider,reference,billing_period,duration_days,coupon_code,original_amount_ngn)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""", (u["id"], plan, amount, provider, reference, period, days, coupon or None, base))
        rid = cur.fetchone()["id"]
        if c:
            cur.execute("INSERT INTO evil_coupon_redemptions(coupon_id,user_id,payment_request_id) VALUES (%s,%s,%s)", (c["id"], u["id"], rid))
            sync_coupon_uses(cur, c["id"])
    return rid, amount, days


RELAUNCH_WHERE = "relaunch_claimed=FALSE AND created_at < to_timestamp((SELECT value::bigint FROM evil_settings WHERE key='relaunch_trial_at'))"


def relaunch_offer(u):
    """Accounts that existed before the relaunch can claim one fresh free trial. The offer message is added to their notifications once and the claim card stays until used."""
    if u["is_admin"]: return False
    try:
        if not q_one(f"SELECT 1 FROM evil_users WHERE id=%s AND {RELAUNCH_WHERE}", (u["id"],)): return False
        if q_one("UPDATE evil_users SET relaunch_notified=TRUE WHERE id=%s AND relaunch_notified=FALSE RETURNING id", (u["id"],)):
            q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (u["id"], f"We've relaunched {BRAND}! Your free {TRIAL_DAYS}-day trial is waiting. Open the claim card here or on the Plans page and tap Claim."))
        return True
    except Exception:
        log.exception("relaunch offer failed"); return False


@app.post("/api/trial/claim")
@login_required
@limited("trial_claim", 10, 3600, per="user")
def claim_relaunch_trial():
    row = q_one(f"UPDATE evil_users SET trial_ends_at=GREATEST(COALESCE(trial_ends_at, NOW()), NOW() + make_interval(days => %s::int)), relaunch_claimed=TRUE WHERE id=%s AND is_admin=FALSE AND {RELAUNCH_WHERE} RETURNING trial_ends_at", (TRIAL_DAYS, request.user["id"]))
    if not row: return err("This offer isn't available for your account (it may already be claimed).")
    q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (request.user["id"], f"Welcome back! Your free {TRIAL_DAYS}-day trial is active with full access."))
    return jsonify({"success": True, "trialEndsAt": iso(row["trial_ends_at"]), "message": f"Your free {TRIAL_DAYS}-day trial is active."})


def get_promo():
    """The admin's promo banner, or None when there is none or it has ended."""
    row = q_one("SELECT value FROM evil_settings WHERE key='promo_banner'")
    if not row: return None
    try: d = json.loads(row["value"])
    except ValueError: return None
    if d.get("until") and float(d["until"]) < time.time(): return None
    return {"id": str(d.get("id", "")), "text": str(d.get("text", ""))[:200]}


def maybe_warn_expiry(u, plan_key, trial):
    """One in-app notification when a paid plan is 3 days or less from ending (once per expiry date)."""
    if u["is_admin"] or trial or plan_key == "free" or not u["plan_expires_at"]: return
    try:
        row = q_one("""UPDATE evil_users SET expiry_warned_for=plan_expires_at WHERE id=%s AND plan_expires_at > NOW() AND plan_expires_at <= NOW() + INTERVAL '3 days'
                       AND expiry_warned_for IS DISTINCT FROM plan_expires_at RETURNING CEIL(EXTRACT(EPOCH FROM (plan_expires_at - NOW())) / 86400)::int AS d""", (u["id"],))
        if row:
            n = max(1, int(row["d"]))
            q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (u["id"], f"Your {PLANS[plan_key]['name']} plan ends in {n} day{'s' if n != 1 else ''}. Renew from Plans to keep your limits."))
    except Exception: log.exception("expiry warning failed")


@app.get("/api/billing/history")
@login_required
def billing_history():
    uid = request.user["id"]
    pays = q_all("SELECT id,plan,amount_ngn,original_amount_ngn,coupon_code,provider,status,billing_period,duration_days,created_at FROM evil_payment_requests WHERE user_id=%s ORDER BY id DESC LIMIT 50", (uid,))
    gifts = q_all("SELECT plan,duration_days,created_at FROM evil_plan_gifts WHERE user_id=%s ORDER BY id DESC LIMIT 20", (uid,))
    return jsonify({"payments": [{"id": r["id"], "plan": PLANS.get(r["plan"], {}).get("name", r["plan"]), "amount": r["amount_ngn"], "original": r["original_amount_ngn"], "coupon": r["coupon_code"], "provider": r["provider"],
                                  "status": r["status"], "period": r["billing_period"], "days": r["duration_days"], "createdAt": iso(r["created_at"])} for r in pays],
                    "gifts": [{"plan": PLANS.get(r["plan"], {}).get("name", r["plan"]), "days": r["duration_days"], "createdAt": iso(r["created_at"])} for r in gifts]})


@app.get("/receipt/<int:request_id>")
@login_required
def receipt_page(request_id):
    from html import escape as e
    r = q_one("SELECT id,plan,amount_ngn,original_amount_ngn,coupon_code,provider,billing_period,duration_days,reference,created_at FROM evil_payment_requests WHERE id=%s AND user_id=%s AND status='approved'", (request_id, request.user["id"]))
    if not r: return Response("Receipt not found. Only approved payments have a receipt.", 404, mimetype="text/plain")
    paid = int(r["amount_ngn"]); orig = int(r["original_amount_ngn"] or paid)
    rows = [("Receipt no.", f"RCT-{r['id']:06d}"), ("Date", r["created_at"].strftime("%d %b %Y, %H:%M UTC")), ("Customer", f"{request.user['username']} ({request.user['email']})"),
            ("Plan", f"{PLANS.get(r['plan'], {}).get('name', r['plan'])} ({r['billing_period'] or 'monthly'}, {r['duration_days'] or PLAN_DAYS} days)"),
            ("Payment method", "Card / Paystack" if r["provider"] == "paystack" else "Bank transfer"), ("Reference", r["reference"] or "-")]
    if r["coupon_code"] and orig > paid: rows += [("Price", f"₦{orig:,}"), ("Coupon " + r["coupon_code"], f"-₦{orig - paid:,}")]
    rows.append(("Amount paid", f"₦{paid:,}"))
    table = "".join(f"<tr><th>{e(k)}</th><td>{e(str(v))}</td></tr>" for k, v in rows)
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt RCT-{r['id']:06d}</title>
<style>body{{font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#111}}h1{{font-size:22px;margin:0}}p{{color:#555}}table{{width:100%;border-collapse:collapse;margin:16px 0}}
th,td{{text-align:left;padding:10px 6px;border-bottom:1px solid #ddd;font-size:15px}}th{{color:#555;font-weight:600;width:42%}}button{{padding:10px 16px;font-size:15px}}@media print{{button{{display:none}}}}</style></head>
<body><h1>{e(BRAND)}</h1><p>Payment receipt</p><table>{table}</table><button id="print-btn" type="button">Print or save as PDF</button><script src="/static/receipt.js"></script></body></html>"""
    return Response(page, mimetype="text/html")


@app.post("/api/gift/redeem")
@login_required
@limited("gift_redeem", 10, 60, per="user")
def redeem_gift():
    code = re.sub(r"[^A-Za-z0-9_-]", "", str(body().get("code", "")))[:40]; u = request.user
    g = q_one("SELECT id,plan,duration_days,redeemed_by,(expires_at IS NOT NULL AND expires_at <= NOW()) AS expired FROM evil_gift_links WHERE code=%s", (code,)) if code else None
    if not g: return err("That gift code isn't valid.", 404)
    if g["redeemed_by"]: return err("This gift has already been used.")
    if g["expired"]: return err("This gift link has expired.")
    plan_key, trial = effective_plan(u)
    if plan_key != "free" and not trial and PLAN_ORDER.index(plan_key) > PLAN_ORDER.index(g["plan"]):
        return err("You already have a higher plan, so this gift was not used. It is still valid for someone else.")
    claimed = q_one("UPDATE evil_gift_links SET redeemed_by=%s, redeemed_at=NOW() WHERE id=%s AND redeemed_by IS NULL AND (expires_at IS NULL OR expires_at > NOW()) RETURNING id", (u["id"], g["id"]))
    if not claimed: return err("This gift has already been used.")
    activate_plan(u["id"], g["plan"], int(g["duration_days"]))
    audit(u["username"], "gift_link_redeemed", f"link {g['id']}")
    return jsonify({"success": True, "message": f"Gift added: {PLANS[g['plan']]['name']} for {g['duration_days']} days."})


@app.get("/api/student-request")
@login_required
def my_student_request():
    r = q_one("SELECT status,coupon_code FROM evil_student_requests WHERE user_id=%s ORDER BY id DESC LIMIT 1", (request.user["id"],))
    return jsonify({"status": r["status"] if r else None, "code": r["coupon_code"] if r and r["status"] == "approved" else None})


@app.post("/api/student-request")
@login_required
@limited("student_req", 5, 3600, per="user")
def create_student_request():
    d = body(); school = re.sub(r"\s+", " ", str(d.get("school", ""))).strip()[:100]; note = str(d.get("note", "")).strip()[:500]; uid = request.user["id"]
    if len(school) < 2: return err("Tell us your school or university.")
    prev = q_one("SELECT status FROM evil_student_requests WHERE user_id=%s AND status IN ('pending','approved') LIMIT 1", (uid,))
    if prev: return err("You already have a student discount request." if prev["status"] == "pending" else "You already received a student coupon.")
    q_run("INSERT INTO evil_student_requests(user_id,school,note) VALUES (%s,%s,%s)", (uid, school, note))
    return jsonify({"success": True})


@app.get("/api/admin/student-requests")
@admin_required
def admin_student_requests():
    rows = q_all("SELECT s.id,s.school,s.note,s.created_at,u.username,u.email FROM evil_student_requests s JOIN evil_users u ON u.id=s.user_id WHERE s.status='pending' ORDER BY s.id LIMIT 50")
    return jsonify({"requests": [{"id": r["id"], "school": r["school"], "note": r["note"], "username": r["username"], "email": r["email"], "createdAt": iso(r["created_at"])} for r in rows]})


@app.post("/api/admin/student-requests/<int:req_id>/<action>")
@admin_required
def admin_review_student(req_id, action):
    if action not in ("approve", "reject"): return err("Unknown action.", 404)
    if action == "reject":
        row = q_one("UPDATE evil_student_requests SET status='rejected' WHERE id=%s AND status='pending' RETURNING user_id", (req_id,))
        if not row: return err("Already handled.", 404)
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (row["user_id"], "We couldn't verify your student discount request. You can send a new one with more details."))
    else:
        try: pct = max(5, min(60, int(body().get("percent", 30))))
        except (TypeError, ValueError): pct = 30
        code = "STU" + secrets.token_hex(3).upper()
        row = q_one("UPDATE evil_student_requests SET status='approved', coupon_code=%s WHERE id=%s AND status='pending' RETURNING user_id", (code, req_id))
        if not row: return err("Already handled.", 404)
        q_run("INSERT INTO evil_coupons(code,discount_type,discount_value,max_uses,expires_at,created_by) VALUES (%s,'percent',%s,1,NOW() + INTERVAL '30 days',%s)", (code, pct, request.user["id"]))
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (row["user_id"], f"Student discount approved: use code {code} for {pct}% off at checkout. It works once and expires in 30 days."))
    audit(request.user["username"], f"student_{action}", f"request {req_id}")
    return jsonify({"success": True})


@app.get("/api/admin/gift-links")
@admin_required
def admin_list_gift_links():
    rows = q_all("SELECT g.code,g.plan,g.duration_days,g.expires_at,g.created_at,u.username AS redeemer FROM evil_gift_links g LEFT JOIN evil_users u ON u.id=g.redeemed_by ORDER BY g.id DESC LIMIT 30")
    base = SITE_URL or request.host_url.rstrip("/")
    return jsonify({"links": [{"url": f"{base}/?gift={r['code']}", "plan": PLANS.get(r["plan"], {}).get("name", r["plan"]), "days": r["duration_days"], "redeemedBy": r["redeemer"], "createdAt": iso(r["created_at"])} for r in rows]})


@app.post("/api/admin/gift-links")
@admin_required
@limited("gift_links", 30, 3600, per="user")
def admin_create_gift_link():
    d = body(); plan = str(d.get("plan", ""))
    try: days = int(d.get("days", 30))
    except (TypeError, ValueError): return err("Days must be a whole number.")
    if plan not in PLANS or plan == "free": return err("Choose a paid plan.")
    if days < 1 or days > 365: return err("Days must be between 1 and 365.")
    code = secrets.token_urlsafe(9)
    q_run("INSERT INTO evil_gift_links(code,plan,duration_days,created_by,expires_at) VALUES (%s,%s,%s,%s,NOW() + INTERVAL '30 days')", (code, plan, days, request.user["id"]))
    audit(request.user["username"], "gift_link_created", f"{plan} {days}d")
    return jsonify({"success": True, "url": f"{SITE_URL or request.host_url.rstrip('/')}/?gift={code}"})


@app.get("/api/admin/promo")
@admin_required
def admin_get_promo():
    return jsonify({"promo": get_promo()})


@app.post("/api/admin/promo")
@admin_required
def admin_set_promo():
    d = body(); text = re.sub(r"\s+", " ", str(d.get("text", ""))).strip()[:200]
    if not text:
        q_run("DELETE FROM evil_settings WHERE key='promo_banner'"); audit(request.user["username"], "promo_clear"); return jsonify({"success": True, "promo": None})
    try: days = max(0, min(60, int(d.get("days", 7))))
    except (TypeError, ValueError): days = 7
    val = json.dumps({"id": secrets.token_hex(4), "text": text, "until": (time.time() + days * 86400) if days else None})
    q_run("INSERT INTO evil_settings(key,value) VALUES ('promo_banner',%s) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", (val,))
    audit(request.user["username"], "promo_set", text[:100])
    return jsonify({"success": True, "promo": get_promo()})


@app.post("/api/upgrade")
@login_required
@limited("upgrade", 10, 3600, per="user")
def upgrade_request():
    payload = body()
    plan = str(payload.get("plan", ""))
    period = str(payload.get("billingPeriod", "monthly")).lower()
    coupon = clean_coupon(payload.get("coupon"))
    if plan not in PLANS or plan == "free": return err("Choose a valid plan.")
    if period not in BILLING_DAYS: return err("Choose weekly, monthly or annual billing.")
    row = q_one("SELECT id,amount_ngn FROM evil_payment_requests WHERE user_id=%s AND plan=%s AND billing_period=%s AND status='pending' AND provider='bank' AND COALESCE(coupon_code,'')=%s ORDER BY id DESC LIMIT 1", (request.user["id"], plan, period, coupon))
    if row: return jsonify({"success": True, "requestId": row["id"], "amount": row["amount_ngn"], "billingPeriod": period, "durationDays": BILLING_DAYS[period]})
    try: rid, amount, days = create_payment_request(request.user, plan, period, "bank", None, coupon)
    except ValueError as e: return err(str(e))
    return jsonify({"success": True, "requestId": rid, "amount": amount, "billingPeriod": period, "durationDays": days})


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


def activate_plan(user_id, plan, duration_days=30):
    days = max(1, min(int(duration_days), 366))
    # Renewing the SAME plan while it is still active adds the new days on top of the remaining time instead of resetting it.
    q_run("""UPDATE evil_users SET
                 plan_expires_at = CASE WHEN plan=%s AND plan_expires_at IS NOT NULL AND plan_expires_at > NOW()
                                        THEN plan_expires_at + (%s || ' days')::interval
                                        ELSE NOW() + (%s || ' days')::interval END,
                 plan=%s, trial_ends_at=NULL WHERE id=%s""", (plan, str(days), str(days), plan, user_id))
    q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (user_id, f"Your {PLANS[plan]['name']} plan is active for {days} days. Thank you!"))


def paystack(method, path, **kw):
    r = requests.request(method, "https://api.paystack.co" + path, headers={"Authorization": f"Bearer {PAYSTACK_SECRET_KEY}"}, timeout=20, **kw)
    return r.json()


@app.post("/api/paystack/init")
@login_required
@limited("paystack", 10, 3600, per="user")
def paystack_init():
    if not PAYSTACK_SECRET_KEY: return err("Card payments aren't switched on yet. Use bank transfer.", 503)
    payload = body()
    plan = str(payload.get("plan", ""))
    period = str(payload.get("billingPeriod", "monthly")).lower()
    if plan not in PLANS or plan == "free": return err("Choose a valid paid plan.")
    if period not in BILLING_DAYS: return err("Choose weekly, monthly or annual billing.")
    u = request.user
    ref = "vyra_" + secrets.token_hex(10)
    try: _rid, amount, days = create_payment_request(u, plan, period, "paystack", ref, clean_coupon(payload.get("coupon")))
    except ValueError as e: return err(str(e))
    email = u["email"] if not u["email"].endswith(".invalid") else f"{u['username']}@vyra.app"
    try:
        res = paystack("POST", "/transaction/initialize", json={"email": email, "amount": amount * 100, "currency": "NGN", "reference": ref,
                       "callback_url": f"{SITE_URL or request.host_url.rstrip('/')}/?paid={ref}", "metadata": {"user_id": u["id"], "plan": plan, "billing_period": period}})
        if not res.get("status"): return err("Paystack couldn't start the payment. Try again or use bank transfer.", 502)
        return jsonify({"success": True, "url": res["data"]["authorization_url"], "reference": ref})
    except Exception:
        log.exception("paystack init failed"); return err("Couldn't reach Paystack. Try again or use bank transfer.", 502)


def settle_paystack(ref):
    """Verifies with Paystack, then activates once. Safe to call many times (webhook + redirect)."""
    row = q_one("SELECT id,user_id,plan,amount_ngn,status,duration_days,billing_period FROM evil_payment_requests WHERE reference=%s AND provider='paystack'", (ref,))
    if not row: return "unknown"
    if row["status"] == "approved": return "approved"
    res = paystack("GET", f"/transaction/verify/{quote(ref)}")
    data = res.get("data") or {}
    if not (res.get("status") and data.get("status") == "success" and data.get("currency") == "NGN" and int(data.get("amount", 0)) >= row["amount_ngn"] * 100):
        return "pending"
    claimed = q_one("UPDATE evil_payment_requests SET status='approved', reviewed_at=NOW() WHERE id=%s AND status<>'approved' RETURNING id", (row["id"],))
    if claimed:
        days = int(row.get("duration_days") or PLAN_DAYS)
        activate_plan(row["user_id"], row["plan"], days)
        audit("paystack", "plan_activated", f"user {row['user_id']} {row['plan']} {row.get('billing_period','monthly')} {ref}")
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


# ----------------------------------------------------------------------------- support inbox (user <-> admin)
@app.get("/api/support/messages")
@login_required
def support_thread():
    uid = request.user["id"]
    rows = q_all("SELECT id,sender,message,created_at FROM evil_support_messages WHERE user_id=%s ORDER BY id DESC LIMIT 200", (uid,))
    q_run("UPDATE evil_support_messages SET read_at=NOW() WHERE user_id=%s AND sender='admin' AND read_at IS NULL", (uid,))
    return jsonify({"messages": [{"id": r["id"], "sender": r["sender"], "message": r["message"], "createdAt": iso(r["created_at"])} for r in reversed(rows)]})


@app.post("/api/support/messages")
@login_required
@limited("support_msg", 10, 3600, per="user")
def support_send():
    msg = str(body().get("message", "")).strip()[:2000]
    if len(msg) < 2: return err("Write your message first.")
    u = request.user
    row = q_one("INSERT INTO evil_support_messages(user_id,sender,message) VALUES (%s,'user',%s) RETURNING id", (u["id"], msg))
    q_run("INSERT INTO evil_notifications(user_id,message) SELECT id,%s FROM evil_users WHERE is_admin=TRUE", (f"New support message from {u['username']}.",))
    return jsonify({"success": True, "id": row["id"]}), 201


@app.get("/api/admin/inbox")
@admin_required
def admin_inbox():
    rows = q_all("""SELECT u.id, u.username,
        (SELECT message FROM evil_support_messages x WHERE x.user_id=u.id ORDER BY x.id DESC LIMIT 1) AS last_message,
        (SELECT MAX(created_at) FROM evil_support_messages x WHERE x.user_id=u.id) AS last_at,
        (SELECT COUNT(*) FROM evil_support_messages x WHERE x.user_id=u.id AND x.sender='user' AND x.read_at IS NULL) AS unread
        FROM evil_users u WHERE u.is_admin=FALSE AND EXISTS (SELECT 1 FROM evil_support_messages x WHERE x.user_id=u.id)
        ORDER BY last_at DESC LIMIT 100""")
    return jsonify({"threads": [{"userId": r["id"], "username": r["username"], "lastMessage": (r["last_message"] or "")[:140], "lastAt": iso(r["last_at"]), "unread": r["unread"]} for r in rows]})


@app.get("/api/admin/inbox/<int:user_id>")
@admin_required
def admin_inbox_thread(user_id):
    target = q_one("SELECT username FROM evil_users WHERE id=%s AND is_admin=FALSE", (user_id,))
    if not target: return err("Customer not found.", 404)
    rows = q_all("SELECT id,sender,message,created_at FROM evil_support_messages WHERE user_id=%s ORDER BY id DESC LIMIT 200", (user_id,))
    q_run("UPDATE evil_support_messages SET read_at=NOW() WHERE user_id=%s AND sender='user' AND read_at IS NULL", (user_id,))
    return jsonify({"username": target["username"], "messages": [{"id": r["id"], "sender": r["sender"], "message": r["message"], "createdAt": iso(r["created_at"])} for r in reversed(rows)]})


@app.post("/api/admin/inbox/<int:user_id>/reply")
@admin_required
def admin_inbox_reply(user_id):
    msg = str(body().get("message", "")).strip()[:2000]
    if not msg: return err("Write a reply first.")
    if not q_one("SELECT id FROM evil_users WHERE id=%s AND is_admin=FALSE", (user_id,)): return err("Customer not found.", 404)
    q_run("INSERT INTO evil_support_messages(user_id,sender,message) VALUES (%s,'admin',%s)", (user_id, msg))
    q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (user_id, "VYRA Admin replied to your message. Open Settings > Contact support to read it."))
    audit(request.user["username"], "support_reply", f"user {user_id}")
    return jsonify({"success": True})


@app.get("/api/admin/payment-settings")
@admin_required
def admin_payment_settings_get():
    row = q_one("SELECT account_name, account_number, bank_name, extra_note FROM evil_payment_settings WHERE id=1")
    return jsonify({"payment": dict(row) if row else None})


@app.post("/api/admin/payment-settings")
@admin_required
def admin_payment_settings_save():
    d = body(); name = str(d.get("account_name", "")).strip()[:120]; number = re.sub(r"[^0-9A-Za-z\- ]", "", str(d.get("account_number", ""))).strip()[:40]
    bank = str(d.get("bank_name", "")).strip()[:80]; note = str(d.get("extra_note", "")).strip()[:500]
    if not (name and number and bank): return err("Enter the bank name, account number and account name.")
    q_run("""INSERT INTO evil_payment_settings(id,account_name,account_number,bank_name,extra_note) VALUES (1,%s,%s,%s,%s)
             ON CONFLICT (id) DO UPDATE SET account_name=EXCLUDED.account_name, account_number=EXCLUDED.account_number, bank_name=EXCLUDED.bank_name, extra_note=EXCLUDED.extra_note""", (name, number, bank, note or None))
    audit(request.user["username"], "payment_settings_update", f"bank {bank}")
    return jsonify({"success": True})


@app.post("/api/admin/coupons/<int:coupon_id>/toggle")
@admin_required
def admin_coupon_toggle(coupon_id):
    row = q_one("UPDATE evil_coupons SET active = NOT active WHERE id=%s RETURNING active,code", (coupon_id,))
    if not row: return err("Coupon not found.", 404)
    audit(request.user["username"], "coupon_toggle", f"{row['code']} active={row['active']}")
    return jsonify({"success": True, "active": row["active"]})


# ----------------------------------------------------------------------------- admin
@app.get("/api/admin/users")
@admin_required
def admin_users():
    where, params = ["is_admin=FALSE"], []
    q = re.sub(r"\s+", " ", request.args.get("q", "")).strip()[:80]
    if q:
        like = "%" + re.sub(r"([%_\\])", r"\\\1", q) + "%"; where.append("(username ILIKE %s OR email ILIKE %s OR public_id ILIKE %s)"); params += [like, like, like]
    plan = request.args.get("plan", "")
    if plan in PLANS: where.append("plan=%s"); params.append(plan)
    status = request.args.get("status", "")
    if status == "suspended": where.append("is_suspended=TRUE")
    elif status == "unverified": where.append("is_verified=FALSE")
    elif status == "trial": where.append("trial_ends_at IS NOT NULL AND trial_ends_at > NOW()")
    elif status == "paying": where.append("plan<>'free' AND plan_expires_at IS NOT NULL AND plan_expires_at > NOW()")
    elif status == "inactive": where.append("(last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '30 days')")
    cond = " AND ".join(where)
    rows = q_all(f"""SELECT id,username,email,public_id,plan,is_suspended,is_verified,plan_expires_at,created_at,last_seen_at,
                    (trial_ends_at IS NOT NULL AND trial_ends_at > NOW()) AS trial FROM evil_users WHERE {cond} ORDER BY id DESC LIMIT 200""", tuple(params))
    return jsonify({"users": [{**r, "plan_expires_at": iso(r["plan_expires_at"]), "created_at": iso(r["created_at"]), "last_seen_at": iso(r["last_seen_at"])} for r in rows]})


@app.post("/api/admin/users/<int:user_id>/message")
@admin_required
def admin_direct_message(user_id):
    message = str(body().get("message", "")).strip()[:2000]
    if not message: return err("Write a message first.")
    target = q_one("SELECT id,username FROM evil_users WHERE id=%s AND is_admin=FALSE", (user_id,))
    if not target: return err("Customer not found.", 404)
    q_run("INSERT INTO evil_admin_messages(admin_id,user_id,message) VALUES (%s,%s,%s)", (request.user["id"], user_id, message))
    q_run("INSERT INTO evil_support_messages(user_id,sender,message) VALUES (%s,'admin',%s)", (user_id, message))
    q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (user_id, "You have a new private message from VYRA Admin."))
    audit(request.user["username"], "private_message", f"user {user_id}")
    return jsonify({"success": True, "username": target["username"]})


@app.get("/api/admin/users/<int:user_id>/messages")
@admin_required
def admin_direct_message_history(user_id):
    rows = q_all("SELECT id,message,created_at,read_at FROM evil_admin_messages WHERE user_id=%s ORDER BY id DESC LIMIT 100", (user_id,))
    return jsonify({"messages": [{**r, "created_at": iso(r["created_at"]), "read_at": iso(r["read_at"])} for r in rows]})


@app.get("/api/admin/coupons")
@admin_required
def admin_coupons_list():
    rows = q_all("SELECT id,code,discount_type,discount_value,applicable_plan,max_uses,uses,expires_at,active,created_at FROM evil_coupons ORDER BY id DESC LIMIT 200")
    return jsonify({"coupons": [{**r, "expires_at": iso(r["expires_at"]), "created_at": iso(r["created_at"])} for r in rows]})


@app.post("/api/admin/coupons")
@admin_required
def admin_coupon_create():
    d=body(); code=re.sub(r"[^A-Z0-9_-]", "", str(d.get("code", "")).upper())[:32]
    kind=str(d.get("discount_type", "percent")); value=d.get("discount_value")
    plan=str(d.get("applicable_plan", "")) or None
    max_uses=d.get("max_uses"); expiry=str(d.get("expires_at", "")).strip() or None
    if not code or kind not in ("percent","fixed"): return err("Enter a valid coupon code and discount type.")
    try: value=float(value); max_uses=int(max_uses) if max_uses not in (None, "") else None
    except (ValueError,TypeError): return err("Discount and usage limit must be numeric.")
    if value<=0 or (kind=="percent" and value>100) or (max_uses is not None and max_uses<1): return err("Discount value or usage limit is invalid.")
    if plan and plan not in PLANS: return err("Invalid plan.")
    try:
        q_run("INSERT INTO evil_coupons(code,discount_type,discount_value,applicable_plan,max_uses,expires_at,created_by) VALUES (%s,%s,%s,%s,%s,%s,%s)", (code,kind,value,plan,max_uses,expiry,request.user["id"]))
    except psycopg2.errors.UniqueViolation: return err("Coupon code already exists.",409)
    audit(request.user["username"], "coupon_create", code)
    return jsonify({"success":True,"code":code})


@app.post("/api/coupons/validate")
@login_required
@limited("coupon_check", 30, 3600, per="user")
def coupon_validate():
    d = body(); code = clean_coupon(d.get("code")); plan = str(d.get("plan", "")); period = str(d.get("billingPeriod", "monthly")).lower()
    if plan not in PLANS or plan == "free" or period not in BILLING_DAYS: return err("Choose a plan and billing period first.")
    if not code: return err("Enter a coupon code.")
    try:
        with db() as conn, conn.cursor() as cur:
            amount, c, base = coupon_quote(cur, request.user["id"], plan, period, code)
    except ValueError as e: return err(str(e))
    return jsonify({"valid": True, "code": code, "originalAmount": base, "amount": amount, "message": f"Coupon applied. You pay ₦{amount:,} instead of ₦{base:,}."})


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
    rows = q_all("""SELECT pr.id, pr.user_id, u.username, pr.plan, pr.amount_ngn, pr.status, pr.provider, pr.billing_period, pr.duration_days, pr.created_at,
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
    row = q_one("SELECT id,user_id,plan,status,duration_days FROM evil_payment_requests WHERE id=%s", (request_id,))
    if not row or row["status"] != "pending": return err("That request was already handled.", 404)
    if action == "approve":
        # Claim atomically so a double tap cannot activate twice; honour the billing period the customer chose (weekly/monthly/annual).
        claimed = q_one("UPDATE evil_payment_requests SET status='approved', reviewed_at=NOW() WHERE id=%s AND status='pending' RETURNING id", (request_id,))
        if not claimed: return err("That request was already handled.", 404)
        activate_plan(row["user_id"], row["plan"], int(row["duration_days"] or PLAN_DAYS))
    else:
        claimed = q_one("UPDATE evil_payment_requests SET status='rejected', reviewed_at=NOW() WHERE id=%s AND status='pending' RETURNING id", (request_id,))
        if not claimed: return err("That request was already handled.", 404)
        try:
            with db() as conn, conn.cursor() as cur:
                cur.execute("SELECT coupon_id FROM evil_coupon_redemptions WHERE payment_request_id=%s", (request_id,))
                for r_ in cur.fetchall(): sync_coupon_uses(cur, r_["coupon_id"])
        except Exception: log.exception("coupon sync failed")
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (row["user_id"], "We couldn't confirm your payment. Please check and send the screenshot again."))
    audit(request.user["username"], f"payment_{action}", f"request {request_id}")
    return jsonify({"success": True})


@app.post("/api/admin/approve/<int:user_id>")  # kept from Evil GPT: sets a plan directly
@admin_required
def admin_approve(user_id):
    plan = str(body().get("plan", ""))
    if plan not in PLANS or plan == "free": return err("Invalid plan.")
    pending = q_one("SELECT duration_days FROM evil_payment_requests WHERE user_id=%s AND plan=%s AND status='pending' ORDER BY id DESC LIMIT 1", (user_id, plan))
    activate_plan(user_id, plan, int(pending["duration_days"] or PLAN_DAYS) if pending else PLAN_DAYS)
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


@app.post("/api/admin/gift-plan")
@admin_required
@limited("gift_plan", 30, 3600, per="user")
def admin_gift_plan():
    d = body(); target = str(d.get("user", "")).strip()[:254]; plan = str(d.get("plan", "")); reason = str(d.get("reason", "" )).strip()[:300]
    try: days = int(d.get("days", PLAN_DAYS))
    except (TypeError, ValueError): return err("Duration must be a whole number of days.")
    if not target: return err("Enter a username or email.")
    if plan not in PLANS or plan == "free": return err("Choose a paid plan to gift.")
    if days < 1 or days > 365: return err("Gift duration must be between 1 and 365 days.")
    user = q_one("SELECT id,username FROM evil_users WHERE is_admin=FALSE AND (LOWER(username)=LOWER(%s) OR LOWER(email)=LOWER(%s))", (target,target))
    if not user: return err("No matching customer account was found.",404)
    q_run("UPDATE evil_users SET plan=%s, plan_expires_at=NOW() + (%s || ' days')::interval WHERE id=%s", (plan,str(days),user["id"]))
    q_run("INSERT INTO evil_plan_gifts(user_id,admin_id,plan,duration_days,reason) VALUES (%s,%s,%s,%s,%s)", (user["id"],request.user["id"],plan,days,reason))
    q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (user["id"], f"You've received a {PLANS[plan]['name']} plan gift for {days} days!" + (f" Note: {reason}" if reason else "")))
    audit(request.user["username"],"gift_plan",f"user {user['id']} -> {plan} for {days} days")
    return jsonify({"success":True,"username":user["username"],"message":f"Gifted {PLANS[plan]['name']} to {user['username']} for {days} days."})


@app.get("/api/admin/reward-requests")
@admin_required
def admin_reward_requests():
    rows = q_all("SELECT rr.id,rr.user_id,u.username,u.email,rr.message,rr.status,rr.admin_note,rr.created_at FROM evil_reward_requests rr JOIN evil_users u ON u.id=rr.user_id ORDER BY rr.id DESC LIMIT 100")
    return jsonify({"requests":[{**r,"created_at":iso(r["created_at"])} for r in rows]})


@app.post("/api/admin/reward-requests/<int:request_id>/<action>")
@admin_required
def review_reward_request(request_id,action):
    if action not in ("approve","reject"): return err("Unknown action.",404)
    d=body(); note=str(d.get("note","" )).strip()[:300]; plan=str(d.get("plan",""));
    try: days=int(d.get("days",PLAN_DAYS))
    except (TypeError,ValueError): return err("Duration must be a whole number of days.")
    row=q_one("SELECT id,user_id,status FROM evil_reward_requests WHERE id=%s",(request_id,))
    if not row or row["status"]!="pending": return err("Request was already handled or not found.",404)
    if action=="approve":
        if plan not in PLANS or plan=="free": return err("Choose a paid plan to reward.")
        if days<1 or days>365: return err("Duration must be between 1 and 365 days.")
        q_run("UPDATE evil_users SET plan=%s,plan_expires_at=NOW()+(%s || ' days')::interval WHERE id=%s",(plan,str(days),row["user_id"]))
        q_run("UPDATE evil_reward_requests SET status='approved',admin_note=%s,reviewed_at=NOW() WHERE id=%s",(note,request_id))
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)",(row["user_id"],f"Your reward request was approved! You've received {PLANS[plan]['name']} for {days} days."))
    else:
        q_run("UPDATE evil_reward_requests SET status='rejected',admin_note=%s,reviewed_at=NOW() WHERE id=%s",(note,request_id))
        q_run("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)",(row["user_id"],"Your reward request was reviewed. Contact support if you need more information."))
    audit(request.user["username"],f"reward_request_{action}",f"request {request_id}")
    return jsonify({"success":True})


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
        (SELECT COUNT(*) FROM evil_otp_requests WHERE status='pending') AS pending_otps,
        (SELECT COUNT(*) FROM evil_messages WHERE feedback=1) AS feedback_up,
        (SELECT COUNT(*) FROM evil_messages WHERE feedback=-1) AS feedback_down,
        (SELECT COUNT(*) FROM evil_users WHERE referral_rewarded=TRUE) AS referral_signups,
        (SELECT COUNT(*) FROM (SELECT user_id FROM evil_support_messages WHERE sender='user' AND read_at IS NULL GROUP BY user_id) t) AS unread_threads""")
    plans = q_all("SELECT plan, COUNT(*) AS n FROM evil_users WHERE is_admin=FALSE GROUP BY plan ORDER BY n DESC")
    return jsonify({"signups": signups, "revenue": revenue, "active": active, "totals": dict(totals), "plans": plans})


@app.get("/api/admin/audit")
@admin_required
def admin_audit():
    day = request.args.get("date", "")
    if day:
        import datetime
        try: day = datetime.date.fromisoformat(day).isoformat()
        except ValueError: return err("Pick a valid date.")
        rows = q_all("SELECT actor,action,detail,created_at FROM evil_audit_log WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date=%s::date ORDER BY id DESC LIMIT 200", (day,))
        fails = q_all("SELECT username,ip,created_at FROM evil_login_attempts WHERE success=FALSE AND (created_at AT TIME ZONE 'Africa/Lagos')::date=%s::date ORDER BY id DESC LIMIT 100", (day,))
    else:
        rows = q_all("SELECT actor,action,detail,created_at FROM evil_audit_log ORDER BY id DESC LIMIT 60")
        fails = q_all("SELECT username,ip,created_at FROM evil_login_attempts WHERE success=FALSE ORDER BY id DESC LIMIT 25")
    return jsonify({"audit": [{**r, "created_at": iso(r["created_at"])} for r in rows], "failedLogins": [{**r, "created_at": iso(r["created_at"])} for r in fails]})


def _day_stats(offset):
    """Metrics for one Lagos calendar day (offset 0 = today, 1 = yesterday)."""
    d = "((NOW() AT TIME ZONE 'Africa/Lagos')::date - %s)"; lag = "(created_at AT TIME ZONE 'Africa/Lagos')::date"
    one = lambda sql: q_one(sql, (offset,))["n"]
    return {"signups": one(f"SELECT COUNT(*) AS n FROM evil_users WHERE is_admin=FALSE AND {lag}={d}"),
            "activeUsers": one(f"SELECT COUNT(DISTINCT user_id) AS n FROM evil_messages WHERE role='user' AND {lag}={d}"),
            "messages": one(f"SELECT COUNT(*) AS n FROM evil_messages WHERE role='user' AND {lag}={d}"),
            "images": one(f"SELECT COUNT(*) AS n FROM evil_images WHERE {lag}={d}"),
            "revenue": int(one(f"SELECT COALESCE(SUM(amount_ngn),0) AS n FROM evil_payment_requests WHERE status='approved' AND (COALESCE(reviewed_at, created_at) AT TIME ZONE 'Africa/Lagos')::date={d}"))}


def _ai_cost(since_sql):
    rates = {"fast": float(os.environ.get("AI_COST_FAST", "0.0002")), "balanced": float(os.environ.get("AI_COST_BALANCED", "0.0006")), "deep": float(os.environ.get("AI_COST_DEEP", "0.0015"))}
    img = float(os.environ.get("AI_COST_IMAGE", "0"))
    rows = q_all(f"SELECT COALESCE(mode,'balanced') AS m, COUNT(*) AS n FROM evil_messages WHERE role='assistant' AND {since_sql} GROUP BY 1")
    n = {r["m"]: r["n"] for r in rows}; imgs = q_one(f"SELECT COUNT(*) AS n FROM evil_images WHERE {since_sql}")["n"]
    return {"replies": n, "images": imgs, "usd": round(sum(rates.get(k, rates["balanced"]) * v for k, v in n.items()) + img * imgs, 4)}


@app.get("/api/admin/summary")
@admin_required
def admin_summary():
    today = "(created_at AT TIME ZONE 'Africa/Lagos')::date = (NOW() AT TIME ZONE 'Africa/Lagos')::date"
    month = "date_trunc('month', created_at AT TIME ZONE 'Africa/Lagos') = date_trunc('month', NOW() AT TIME ZONE 'Africa/Lagos')"
    return jsonify({"today": _day_stats(0), "yesterday": _day_stats(1),
                    "pendingPayments": q_one("SELECT COUNT(*) AS n FROM evil_payment_requests WHERE status='pending'")["n"],
                    "openReports": q_one("SELECT COUNT(*) AS n FROM evil_reports WHERE status='open'")["n"],
                    "unreadSupport": q_one("SELECT COUNT(DISTINCT user_id) AS n FROM evil_support_messages WHERE sender='user' AND read_at IS NULL")["n"],
                    "trialClaims": q_one("SELECT COUNT(*) AS n FROM evil_users WHERE relaunch_claimed=TRUE")["n"],
                    "aiToday": _ai_cost(today), "aiMonth": _ai_cost(month)})


@app.get("/api/admin/health")
@admin_required
@limited("admin_health", 20, 300, per="user")
def admin_health():
    out = []
    def check(name, fn):
        t0 = time.time()
        try: ok, detail = fn()
        except Exception as exc: ok, detail = False, type(exc).__name__ + ": " + str(exc)[:120]
        out.append({"name": name, "ok": bool(ok), "detail": detail, "ms": int((time.time() - t0) * 1000)})
    check("Database", lambda: (q_one("SELECT 1 AS x")["x"] == 1, "Connected"))
    def ai():
        if not GROQ_API_KEY: return False, "GROQ_API_KEY is not set"
        n = len(list(make_client().with_options(timeout=6, max_retries=0).models.list().data)); return True, f"Groq reachable ({n} models)"
    check("AI (Groq)", ai)
    def mail():
        if not mail_enabled(): return False, "No mail provider configured (codes wait for admin approval)"
        return True, "Brevo" if BREVO_API_KEY else ("Resend" if RESEND_API_KEY else "SMTP") + " configured. Use the test box below to confirm delivery."
    check("Email", mail)
    check("Payments (Paystack)", lambda: (bool(PAYSTACK_SECRET_KEY), "Key set" if PAYSTACK_SECRET_KEY else "Not set: only bank transfer works"))
    def img():
        r = requests.head("https://image.pollinations.ai", timeout=5, allow_redirects=True); return r.status_code < 500, f"Image service answered ({r.status_code})"
    check("Image service", img)
    check("Image editing (Cloudflare)", lambda: (cf_enabled(), (f"On. Used today: {cf_used_today()} of {CF_DAILY_CAP}" + ("" if Image is not None else ". Pillow missing: editing off")) if cf_ready() else "Not set up: basic generator only, no editing"))
    check("Admin two-step login", lambda: (bool(q_one("SELECT totp_enabled FROM evil_users WHERE id=%s", (request.user["id"],))["totp_enabled"]), "On" if q_one("SELECT totp_enabled FROM evil_users WHERE id=%s", (request.user["id"],))["totp_enabled"] else "Off: turn it on in Settings"))
    return jsonify({"checks": out, "siteUrl": SITE_URL or "(not set)"})


@app.post("/api/admin/health/test-email")
@admin_required
@limited("test_email", 5, 3600, per="user")
def admin_test_email():
    to = str(body().get("to", "")).strip().lower()
    if not valid_email(to): return err("Enter a valid email address.")
    if not mail_enabled(): return err("No mail provider is configured.")
    ok = send_mail(to, f"{BRAND} test email", "This is a test email from your admin Health page. If you can read it, email works.")
    return jsonify({"success": ok, "message": "The provider accepted the email. Check the inbox (and spam)." if ok else "The provider rejected or failed to send it. Check the logs."})


@app.post("/api/admin/gift-bulk")
@admin_required
@limited("gift_bulk", 10, 3600, per="user")
def admin_gift_bulk():
    d = body(); plan = str(d.get("plan", "")); audience = str(d.get("audience", "")); reason = str(d.get("reason", "")).strip()[:300]
    try: days = int(d.get("days", 30))
    except (TypeError, ValueError): return err("Days must be a whole number.")
    if plan not in PLANS or plan == "free": return err("Choose a paid plan.")
    if days < 1 or days > 365: return err("Days must be between 1 and 365.")
    base = "is_admin=FALSE AND is_suspended=FALSE"; params = []
    if audience == "free": base += " AND (plan='free' OR plan IS NULL OR plan_expires_at IS NULL OR plan_expires_at < NOW())"
    elif audience == "usernames":
        names = [n.strip().lower() for n in re.split(r"[,\n; ]+", str(d.get("usernames", ""))) if n.strip()][:200]
        if not names: return err("Enter at least one username.")
        base += " AND LOWER(username) = ANY(%s)"; params.append(names)
    elif audience != "all": return err("Choose who should receive the gift.")
    rows = q_all(f"SELECT id,username,CASE WHEN plan<>'free' AND plan_expires_at > NOW() THEN plan ELSE 'free' END AS active_plan FROM evil_users WHERE {base} ORDER BY id LIMIT 501", tuple(params))
    if len(rows) > 500: return err("That is more than 500 people. Narrow it down (for example use a list of usernames).")
    rank = lambda p: PLAN_ORDER.index(LEGACY_PLAN_MAP.get(p, p)) if LEGACY_PLAN_MAP.get(p, p) in PLAN_ORDER else 0
    targets = [r for r in rows if rank(r["active_plan"]) <= PLAN_ORDER.index(plan)]
    skipped = len(rows) - len(targets)
    if d.get("confirm") is not True: return jsonify({"preview": True, "count": len(targets), "skipped": skipped, "sample": [r["username"] for r in targets[:8]]})
    note = f"You've received a {PLANS[plan]['name']} plan gift for {days} days!" + (f" Note: {reason}" if reason else "")
    with db() as conn, conn.cursor() as cur:
        for r in targets:
            cur.execute("""UPDATE evil_users SET plan_expires_at = CASE WHEN plan=%s AND plan_expires_at > NOW() THEN plan_expires_at + (%s || ' days')::interval ELSE NOW() + (%s || ' days')::interval END, plan=%s WHERE id=%s""", (plan, str(days), str(days), plan, r["id"]))
            cur.execute("INSERT INTO evil_plan_gifts(user_id,admin_id,plan,duration_days,reason) VALUES (%s,%s,%s,%s,%s)", (r["id"], request.user["id"], plan, days, reason))
            cur.execute("INSERT INTO evil_notifications(user_id,message) VALUES (%s,%s)", (r["id"], note))
    audit(request.user["username"], "gift_bulk", f"{plan} {days}d to {len(targets)} users ({audience})")
    return jsonify({"success": True, "gifted": len(targets), "skipped": skipped, "message": f"Gifted {PLANS[plan]['name']} for {days} days to {len(targets)} users." + (f" Skipped {skipped} who already have a higher plan." if skipped else "")})


@app.get("/api/admin/canned")
@admin_required
def admin_canned():
    if not q_one("SELECT 1 FROM evil_settings WHERE key='canned_seeded'"):
        for t, x in (("Payment received", "Thank you! We received your payment and your plan is now active. Enjoy!"), ("Send payment proof", "Please upload a clear screenshot of your transfer from the Plans page so we can confirm your payment."), ("Thanks for contacting us", "Thanks for reaching out. We're looking into this and will update you soon.")):
            q_run("INSERT INTO evil_canned(title,text) VALUES (%s,%s)", (t, x))
        q_run("INSERT INTO evil_settings(key,value) VALUES ('canned_seeded','1') ON CONFLICT (key) DO NOTHING")
    return jsonify({"replies": [dict(r) for r in q_all("SELECT id,title,text FROM evil_canned ORDER BY id")]})


@app.post("/api/admin/canned")
@admin_required
def admin_canned_add():
    d = body(); text = str(d.get("text", "")).strip()[:2000]; title = re.sub(r"\s+", " ", str(d.get("title") or text)).strip()[:40]
    if len(text) < 2: return err("Write the reply text first.")
    if q_one("SELECT COUNT(*) AS n FROM evil_canned")["n"] >= 30: return err("You can keep up to 30 canned replies.")
    row = q_one("INSERT INTO evil_canned(title,text) VALUES (%s,%s) RETURNING id", (title, text)); return jsonify({"success": True, "id": row["id"]})


@app.delete("/api/admin/canned/<int:canned_id>")
@admin_required
def admin_canned_delete(canned_id):
    q_run("DELETE FROM evil_canned WHERE id=%s", (canned_id,)); return jsonify({"success": True})


@app.get("/api/admin/export")
@admin_required
def admin_export():
    plan_filter = request.args.get("plan")
    if plan_filter and plan_filter not in PLANS: return err("Unknown plan.")
    users_sql = "SELECT id,username,email,plan,plan_expires_at,is_verified,is_suspended,streak_count,bonus_messages,created_at FROM evil_users"
    users = q_all(users_sql + " WHERE plan=%s ORDER BY id", (plan_filter,)) if plan_filter else q_all(users_sql + " ORDER BY id")
    if request.args.get("format") == "csv":
        lines = ["id,username,email,plan,plan_expires_at,is_verified,is_suspended,streak_count,bonus_messages,created_at"]
        for r in users:
            vals = [r["id"], r["username"], r["email"], r["plan"], iso(r["plan_expires_at"]) or "", r["is_verified"], r["is_suspended"], r["streak_count"], r["bonus_messages"], iso(r["created_at"])]
            lines.append(",".join('"' + str(v).replace('"', '""') + '"' for v in vals))
        return Response("\n".join(lines), mimetype="text/csv", headers={"Content-Disposition": "attachment; filename=vyra-users.csv"})
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
