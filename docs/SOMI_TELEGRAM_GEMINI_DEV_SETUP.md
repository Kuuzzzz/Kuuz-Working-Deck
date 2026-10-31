# Somi Store Assistant — development setup

This guide is for the isolated branch `feature/somi-telegram-gemini-dev`. Do not deploy this branch to the production Worker or attach it to the live store database until reviewed.

## Current status

- Worker routes: `GET /health`, `POST /telegram/webhook`.
- Gemini replies are enabled for Telegram text messages after the webhook and secrets are configured.
- Telegram authorization is an explicit allowlist in `TELEGRAM_ALLOWED_USER_IDS`.
- Store CRUD and dashboard synchronization are NOT implemented yet. The database migration is a schema foundation only.
- Existing production data and dashboard are not modified.

## Required Worker secrets / variables

Set these on a separate development Worker, not the production Worker:

- Secret `GEMINI_API_KEY`: Gemini API key.
- Secret `TELEGRAM_BOT_TOKEN`: BotFather token.
- Secret `TELEGRAM_WEBHOOK_SECRET`: random URL-safe value, at least 32 characters.
- Variable `TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric Telegram user IDs, e.g. `111111111,222222222` (replace with actual IDs; never guess).

Use Cloudflare Dashboard → Workers & Pages → development Worker → Settings → Variables and Secrets. Mark all three credentials as Secret. The allowlist is not a credential but must contain only the two approved IDs.

## Register the webhook

After deploying the development Worker and setting its secrets, register the webhook from a trusted local terminal. Do not paste the bot token into chat or commit it to Git.

```bash
export TELEGRAM_BOT_TOKEN='YOUR_BOTFATHER_TOKEN'
export TELEGRAM_WEBHOOK_SECRET='YOUR_RANDOM_SECRET'
export WORKER_URL='https://YOUR-DEV-WORKER.YOUR-SUBDOMAIN.workers.dev'
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\" ${WORKER_URL}/telegram/webhook\",\"secret_token\":\" ${TELEGRAM_WEBHOOK_SECRET}\"}"
```

Check webhook status:

```bash
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

## Important next implementation milestones

1. Create a dedicated development D1 database and bind it as `DB` in the development Worker.
2. Apply `migrations/0001_somi_store_dev.sql` to that development database only.
3. Implement validated customer/order/payment/delivery APIs and conversation state machine.
4. Update the dashboard to use the shared API with migration/import and backup; preserve local data until verified.
5. Add idempotency for Telegram updates, audit logs, delete confirmation, role checks and Khmer/English guided flows.
6. Test both authorized accounts and dashboard synchronization before production review.

Never run the migration against production or switch the live dashboard to the new API without a backup and explicit review.
