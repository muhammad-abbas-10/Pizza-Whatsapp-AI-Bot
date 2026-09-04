# Runtime hardening and migration order (013–016)

## Migration order

For a new database, review and apply `001` through `012`, then choose the menu path deliberately:

- `013_menu_v2.sql` drops/recreates and reseeds the canonical v2 menu. Do not run it over live dashboard menu edits without a backup and explicit intent.
- `014_drop_legacy_menu_schema.sql` removes only the old `menu_categories`, `menu_items`, `menu_variants`, and `menu_extras` tables. Run it only after verifying no deployed older workflow still references them.
- `015_reply_idempotency.sql` adds the outbound customer reply marker/recovery index. It is required and safe to re-run.
- `016_dashboard_customer_status_events.sql` adds Oven, canonical transition functions, status provenance, the dashboard event outbox, ownership enforcement, failure visibility, and retry state. It is required by the current backend/workflow.

Useful commands from `backend/`:

```text
npm run migrate:workflow-runtime
npm run migrate:reply-idempotency
npm run migrate:dashboard-status
```

`migrate:drop-legacy-menu` is intentionally separate because it is destructive.

## Customer reply recovery

The customer sequence remains:

```text
Send message → Record Reply Sent → Finalize Customer Turn
```

If execution fails after provider delivery but before buffer finalization, the exact reclaimed batch sees its stored `reply_text`/`replied_at`, skips Gemini and WhatsApp, and completes database finalization.

## Dashboard event recovery

The backend commits business state and `customer_notification_events` before calling n8n. n8n claims a row as `processing` and increments attempts before AI/WhatsApp delivery. Ordinary duplicate calls cannot acquire that row. A failed provider call is marked `failed` and becomes explicitly retryable. A crashed execution can be reclaimed after the two-minute lease; a stale event becomes `superseded` if the order has advanced.

The event lifecycle and dashboard failure notification are PostgreSQL state, not local memory or a Vercel background task.

## Required configuration

Backend:

```text
DATABASE_URL
ADMIN_API_KEY
N8N_ADMIN_WEBHOOK_URL
N8N_ADMIN_WEBHOOK_TIMEOUT_MS (optional, default 15000)
CORS_ORIGINS
FRONTEND_URL
```

n8n Variables:

```text
WHATSAPP_PHONE_NUMBER_ID
```

n8n credentials provide Postgres, WhatsApp Trigger, WhatsApp API, and Gemini authentication. The WhatsApp Trigger credential's Meta Client Secret performs native webhook-signature verification.

## Verification commands

```text
cd backend
npm test
npm run test:admin-status-db

cd ../frontend
npm test
npm run build
```

The database suite strips the migration's outer transaction and applies it inside its own transaction, exercises the schema, then rolls back. It does not persist test rows or migration state.

## External delivery boundary

PostgreSQL can atomically own/record local work, but it cannot share a transaction with Meta. The claim prevents concurrent and ordinary retry duplicates. A process failure after Meta accepts a send but before the provider ID is recorded remains an ambiguous external-system boundary; the event stays visible as processing until recovery rather than falling back to admin WhatsApp.
