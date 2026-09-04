# Pizza WhatsApp AI Ordering Bot

Pizza Bar's customer ordering system uses WhatsApp, n8n, Gemini, and Neon PostgreSQL. Restaurant staff work only in the separate Vite admin dashboard; there is no admin WhatsApp command or notification path.

## Architecture

```text
Customer WhatsApp → n8n customer flow → AI ordering agent → PostgreSQL
                                                            ↓
                                                     Admin dashboard
                                                            ↓
                                              authenticated backend API
                                                            ↓
                                            authenticated n8n status webhook
                                                            ↓
                                            AI customer-message agent
                                                            ↓
                                              Customer WhatsApp only
```

The customer path supports English, Urdu, and Roman Urdu menu questions, normal items and configurable deals, cart edits, delivery/pickup, explicit confirmation, order placement, cancellation requests, complaints, and menu images. SQL revalidates live item IDs, variants, deal selections, quantities, and prices before an order is committed.

The dashboard shows committed orders and customer requests from database triggers. Admins can advance an order through the canonical lifecycle:

```text
received → preparing → oven → out_for_delivery → completed
    └─────────┴→ cancelled
```

Pickup orders may move from `oven` directly to `completed`. Cancellation is allowed only in `received` or `preparing`; `oven` and later stages are non-cancellable. PostgreSQL functions in migration `016` are the authoritative transition and cancellation policy used by the backend and workflow.

## Reliability and security

- A confirmed order is inserted before the customer agent may claim it was placed.
- New-order and customer-request visibility uses the existing `admin_notifications` triggers; no staff WhatsApp alert is sent.
- A status transition, its history row, and a `customer_notification_events` outbox row commit in one locked transaction.
- The browser calls only the authenticated Express API and never receives the n8n secret or WhatsApp credentials.
- The backend sends n8n only `event_id` and `request_id`; n8n joins the event to `orders` and `customers` to obtain the authoritative phone.
- n8n validates `N8N_ADMIN_WEBHOOK_SECRET` before database or WhatsApp work, then atomically claims the event with a persistent two-minute recovery lease.
- Unique request/idempotency keys and conditional updates suppress double-clicks, concurrent admins, duplicate webhook calls, and competing retries.
- Delivery state is persisted as `pending`, `processing`, `sent`, `failed`, or `superseded`. Failures create a visible dashboard notification and can be retried.
- A delayed status event is marked `superseded` instead of sending stale information after the order has already advanced.
- Admin status events use a separate AI prompt and graph branch. They cannot call cart, order, handoff, or admin-request tools.
- The AI phrases a deterministic status meaning in the customer's established language. A post-agent guard replaces missing, contradictory, overlong, or internal-detail output with a safe localized fallback.

## Applications

Run the backend and frontend in separate terminals:

```powershell
cd backend
npm install
npm run dev
```

```powershell
cd frontend
npm install
npm run dev
```

The frontend reads only `VITE_API_URL`; it does not bundle server credentials. The admin enters the backend's `ADMIN_API_KEY` at sign-in and it is kept in session storage for the current tab.

Dashboard pages include overview metrics, active orders, customer cancellation requests, order history/CSV export, customers, feedback, menu management, persisted operational notifications, and settings. Order details show status history plus the latest customer-notification result and retry action.

## Database migrations

Schema creation is migration-only; the live n8n workflow contains no DDL. Apply migrations in numeric order after reviewing the existing environment.

For an already-running database that has migrations through `015`:

```powershell
cd backend
npm run migrate:dashboard-status
```

Migration `016_dashboard_customer_status_events.sql`:

- adds `oven` to `orders` and `order_status_history` constraints;
- adds canonical transition/cancellation functions;
- adds status-history source/request provenance;
- creates the durable `customer_notification_events` outbox;
- enforces the `(order_id, customer_id)` relationship with a composite foreign key;
- drives dashboard failure visibility and synchronizes legacy request notification fields.

Migration `013_menu_v2.sql` rebuilds the canonical menu seed and can overwrite menu edits. On an existing production database, follow [runtime-hardening-013-016.md](docs/runtime-hardening-013-016.md) before deciding whether to run `013` or the legacy cleanup in `014`.

## n8n deployment

1. Apply database migrations through `016`.
2. Import `admin request.json`. The export is intentionally inactive.
3. Re-select the target instance's Postgres, WhatsApp Trigger, WhatsApp API, and Gemini credentials if credential IDs differ.
4. Create these n8n Variables:

   ```text
   WHATSAPP_PHONE_NUMBER_ID=...
   N8N_ADMIN_WEBHOOK_SECRET=the-same-random-secret-used-by-the-backend
   ```

5. Activate the imported workflow only after deactivating the older version.
6. Copy the production URL of the `Admin Order Status Webhook` (`/webhook/admin-order-status`) into backend `N8N_ADMIN_WEBHOOK_URL`.
7. Confirm the Meta production webhook still targets the native `WhatsApp Trigger`.

The native trigger credential must contain the Meta App Client Secret so n8n can verify `x-hub-signature-256`. Do not put Meta or WhatsApp secrets in n8n Variables when a credential field exists.

## Environment variables

Backend (`backend/.env`; start from `backend/.env.example`):

```env
PORT=3000
DATABASE_URL=postgresql://...
ADMIN_API_KEY=a-long-random-admin-secret
N8N_ADMIN_WEBHOOK_URL=https://your-n8n.example/webhook/admin-order-status
N8N_ADMIN_WEBHOOK_SECRET=a-different-long-random-secret
N8N_ADMIN_WEBHOOK_TIMEOUT_MS=15000
CORS_ORIGINS=http://localhost:5173
FRONTEND_URL=http://localhost:5173
```

Frontend (`frontend/.env`; start from `frontend/.env.example`):

```env
VITE_API_URL=http://localhost:3000
```

Never put `DATABASE_URL`, `ADMIN_API_KEY`, the n8n webhook secret, Meta tokens, or WhatsApp credentials in a `VITE_*` variable or commit real `.env` files.

## Important API behavior

- `PATCH /admin/orders/:id/status` accepts `{ "status": "oven", "expected_status": "preparing", "request_id": "uuid" }`, locks the order, rejects stale admin views, validates the database transition, updates status/history, creates the outbox event, commits, and then dispatches n8n.
- `POST /admin/orders/:id/notifications/:eventId/retry` retries a failed order event without changing business state.
- `POST /admin/requests/:id/approve` atomically validates ownership/cancellability, cancels the order, resolves the request, and creates one cancellation event.
- `POST /admin/requests/:id/deny` leaves the order unchanged, resolves the request, and creates one denial event.
- `POST /admin/requests/:id/notify` retries the persisted decision event.

All `/admin/*` routes require `x-admin-key`. A status update can succeed while customer delivery fails; the API therefore returns the committed order and the factual notification lifecycle separately instead of pretending both succeeded.

## Testing

```powershell
cd backend
npm test
npm run test:admin-status-db
npm run test:customer-journey
npm run test:workflow-cancellation
npm run test:workflow-order-safety
npm run test:workflow-cart

cd ..\frontend
npm test
npm run build
```

`test:admin-status-db` applies migration `016` inside rollback-only transactions, checks the canonical matrix, Oven rule, new-order visibility, history provenance, wrong-customer foreign-key rejection, concurrent stale-action rejection, notification failure visibility, retry, and duplicate suppression, then rolls everything back.

The customer-journey, cancellation, and order-safety tests also apply migration `016` only inside their rollback-only transactions. The database must contain the menu fixtures installed by the project migrations. No test above activates n8n or sends a real WhatsApp message.

## Repository structure

```text
├── admin request.json
├── backend/
│   ├── api/index.js
│   ├── src/admin-routes.js
│   ├── src/customer-notification-events.js
│   └── scripts/
├── database/migration/
├── docs/
└── frontend/src/
```

## Production note

The database lease prevents concurrent and ordinary retry duplicates. Meta's send API does not expose an application idempotency key, so an infrastructure crash in the narrow interval after Meta accepts a message but before n8n records its provider ID is inherently ambiguous. Such an event remains `processing` until its lease expires and is visible for deliberate retry; no admin WhatsApp fallback is used.

This repository is private client software. Add a formal license before public distribution.
