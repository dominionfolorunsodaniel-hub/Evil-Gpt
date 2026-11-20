# VYRA additive patch

This patch is based on the supplied VYRA source ZIP. It preserves the original architecture and files, and modifies only `app.py`, `static/script.js`, and `templates/index.html`.


## Implemented in this patch
- One-time migration grants eligible existing Free accounts a 7-day trial, and new registrations default to 7 days (`TRIAL_DAYS` can still override it).
- Random permanent VYRA public IDs in `VYR-XXXX-XXXX` format; backfills existing accounts, returns the ID in `/api/me`, and displays/copies it in Settings.
- Admin user list displays each customer's VYRA ID and includes a direct-message button.
- Admin-to-user direct messages are stored separately, delivered in the recipient's notification panel, and have read timestamps.
- Coupon management API and Admin Coupons tab (create/list) plus a validation endpoint.
- Eight-step onboarding tour; skip, back, next, finish, and restart from Settings.

## Not yet production-complete
- Coupon validation is not wired into checkout, so coupon codes created here do not yet reduce a payment amount. Do not promote them as redeemable discounts until checkout redemption, atomic usage tracking, and per-user limits are implemented.
- User-to-user messaging is not included; direct messaging is admin-to-customer only.
- Direct-message read status is stored but not shown in the admin UI.
- Image generation remains on the existing Pollinations provider. Prompt-quality and provider/model changes are not included in this patch.
- This patch does not include the previously proposed 20 additional features beyond these listed items.
- Database migrations and live endpoint tests could not run in this environment because `psycopg2` and a live database are unavailable.

## Deployment
Replace only the files listed in this patch, preserving their paths. Do not replace the database, environment variables, or payment configuration. Deploy and smoke-test registration/login, the new tour, Settings ID copy, admin direct messages, and coupon admin screens. Roll back if migration logs report failure.
