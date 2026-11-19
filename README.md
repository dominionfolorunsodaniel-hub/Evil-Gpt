# Vyra AI

Flask + Postgres + Groq. This is the upgraded version of Evil GPT. Every original feature is kept.

## Deploy (Render)
1. Copy these files over your repo (replace `app.py`, `templates/`, `static/`, `render.yaml`, `requirements.txt`) and push.
2. In Render > Environment, set the values from `.env.example`. At minimum: `DATABASE_URL`, `GROQ_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SITE_URL`.
3. Keep the Render service named `evil-gpt` (renaming it in render.yaml would create a second service). Rename it later in the Render dashboard if you want.

## Turn on the extras
- **Email codes (needed so sign-ups don't wait for you):** Render's free plan blocks SMTP, so Gmail SMTP cannot work. Make a free Brevo account, verify your sender email, create an API key, then set `BREVO_API_KEY` and `MAIL_FROM`.
- **Card payments:** set `PAYSTACK_SECRET_KEY`. In the Paystack dashboard set the webhook URL to `https://YOUR-SITE/api/paystack/webhook`. Test with a `sk_test_` key first.
- **Stay awake on Render free:** add a GitHub repo *variable* `SITE_URL` (Settings > Secrets and variables > Actions > Variables). The included workflow pings `/healthz` every 10 minutes.
- **Bank details:** set `PAYMENT_*` variables only if the database has none saved. Existing saved details are never changed.

## Things to know
- New sign-ups are on the **Free plan with a 2-day trial**. Before, they got Infinity forever. On first start, expired-trial accounts with no approved payment are moved to Free (once).
- Plans now expire after 30 days. Existing paid users have no expiry until you renew them.
- Custom personas need a paid plan or an active trial. Set `CUSTOM_PERSONA_FREE=1` to allow everyone.
- Remove the old Vercel link in the GitHub repo's About box.
- Your repo is public. Anything you ever committed (including old bank details in git history) stays visible there.

## November 2026 maintenance update
- Plan cards now render defensively when plan data is missing or malformed, with a clear retry state instead of an empty screen.
- Admin Center includes a dedicated Admin Tools directory linking to all current administrative sections: overview, user management, payments, verification/recovery codes, broadcasts, rewards, and audit/backup.
- Admin page title and responsive admin-tool styling updated.
- Validation performed: Python syntax compilation (`app.py`) and JavaScript syntax check (`static/script.js`).

## Gifts, rewards, support and notifications

- Admin Center → Gifts & reward requests lets an administrator gift a paid plan by username/email for 1–365 days; gifts are logged and notify the recipient.
- Users can submit reward requests from the Plans page. Admins can approve a request by selecting a plan and duration, or reject it.
- Payment screenshot review is already built into Admin Center → Payments: open the proof and approve/reject. Approval activates the plan and notifies the customer; upload notifies the admin.
- Forgot-password requests already use the code-based reset flow. If email delivery is not configured, admin approval is used; reset codes are time-limited.
- Broadcasts already insert in-app notifications for non-admin users. The notification badge now refreshes periodically while the app is visible.
- Telegram support is linked on the Plans page. WhatsApp support is optional: configure `WHATSAPP_SUPPORT_NUMBER` in the deployment environment with a business/guardian-managed public number (digits including country code, no `+` or spaces).
- Image Studio is branded as VYRA Image Studio. The underlying image service remains a third-party provider and is disclosed in the privacy policy; no provider replacement was made in this update.

Database changes are additive: startup creates `evil_plan_gifts` and `evil_reward_requests` if they are absent.
