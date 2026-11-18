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
