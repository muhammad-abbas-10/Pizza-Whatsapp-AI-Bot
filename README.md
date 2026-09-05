# 🍕 Pizza WhatsApp AI Bot

<div align="center">

### AI-powered WhatsApp ordering and restaurant operations—connected end to end

[![Production](https://img.shields.io/badge/deployment-live-22c55e?style=for-the-badge&logo=vercel&logoColor=white)](https://pizza-whatsapp-ai-bot.vercel.app/)
![Frontend](https://img.shields.io/badge/frontend-Vite%20%2B%20Vanilla%20JS-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Backend](https://img.shields.io/badge/backend-Express%205-000000?style=for-the-badge&logo=express&logoColor=white)
![Database](https://img.shields.io/badge/database-Neon%20PostgreSQL-00E599?style=for-the-badge&logo=postgresql&logoColor=white)

![Automation](https://img.shields.io/badge/automation-n8n-EA4B71?style=flat-square&logo=n8n&logoColor=white)
![AI](https://img.shields.io/badge/AI-Google%20Gemini-8E75B2?style=flat-square&logo=googlegemini&logoColor=white)
![Messaging](https://img.shields.io/badge/messaging-WhatsApp-25D366?style=flat-square&logo=whatsapp&logoColor=white)
![Runtime](https://img.shields.io/badge/runtime-Node.js-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)

> A deployed ordering platform where customers build and confirm orders through WhatsApp while restaurant staff manage live operations from a dedicated admin dashboard.

### [🌐 Open the live admin dashboard →](https://pizza-whatsapp-ai-bot.vercel.app/)

</div>

---

## 🚀 Live deployment

| Component | Status | Location |
|---|---:|---|
| Admin dashboard | 🟢 Live | [pizza-whatsapp-ai-bot.vercel.app](https://pizza-whatsapp-ai-bot.vercel.app/) |
| Express API | 🟢 Live | [Database health check](https://pizza-whatsapp-ai-bot.vercel.app/health) |
| Menu image API | 🟢 Live | [Image catalogue](https://pizza-whatsapp-ai-bot.vercel.app/images) |
| Database | 🟢 Connected | Neon PostgreSQL |
| Automation | 🟢 Configured | n8n workflow; production webhook is private |
| Messaging | 🟢 Integrated | Meta WhatsApp Cloud API; no public bot URL |

The Vite SPA and Express API are deployed as two Vercel services behind one origin. `/admin/*`, `/images*`, `/health`, and `/dashboard` are routed to the backend; all other paths are served by the frontend.

## Product overview

### Customer experience

Customers chat with Pizza Bar through WhatsApp in English, Urdu, or Roman Urdu. The automation can answer menu questions from live database records, add or change items, configure supported deals, maintain a cart, collect delivery or pickup details, require explicit confirmation, place an order, send menu images, and submit eligible cancellation requests for staff review.

Prices, variants, deal selections, quantities, and active menu records are revalidated in PostgreSQL before an order is committed. The AI is never treated as the source of truth for price or availability.

### Restaurant operations

Staff sign in to a responsive dark dashboard with a private admin key. The dashboard provides live metrics, active order handling, cancellation decisions, historical exports, customer insights, feedback summaries, menu controls, operational notifications, and restaurant settings—all backed by the same production database used by the ordering workflow.

## ✨ Core features

| 🤖 Menu-aware AI ordering | 💬 Multilingual WhatsApp | 🛒 Database-validated cart |
|---|---|---|
| Gemini receives only relevant live menu and session context. | Replies follow the customer's English, Urdu, or Roman Urdu style. | SQL verifies records, variants, deal choices, quantities, and prices. |

| 📊 Operations dashboard | 🔄 Safe status workflow | 🙋 Human decisions |
|---|---|---|
| Live KPIs, order activity, status counts, and recent records. | Canonical transitions, optimistic UI updates, history, and stale-action protection. | Cancellation requests can be approved or denied with an optional note. |

| 🔔 Durable notifications | 🍕 Menu management | 👥 Customer intelligence |
|---|---|---|
| Persistent outbox events, delivery states, retries, and failure alerts. | Create items, edit prices, and control item or deal availability. | Order count, spend, last activity, conversation state, and history. |

| 🗂️ History and export | ⭐ Feedback reporting | 🖼️ Menu image delivery |
|---|---|---|
| Filter completed/cancelled orders and export CSV safely. | Rating filters, averages, five-star share, and linked customer records. | Validated image uploads and cached delivery directly from PostgreSQL. |

## 🧩 Technology stack

<table align="center">
  <tr>
    <td align="center" width="25%"><img src="https://cdn.simpleicons.org/html5/E34F26" width="42" alt="HTML5"/><br/><sub><b>HTML5</b></sub></td>
    <td align="center" width="25%"><img src="https://cdn.simpleicons.org/css/663399" width="42" alt="CSS"/><br/><sub><b>CSS</b></sub></td>
    <td align="center" width="25%"><img src="https://cdn.simpleicons.org/javascript/F7DF1E" width="42" alt="JavaScript"/><br/><sub><b>JavaScript</b></sub></td>
    <td align="center" width="25%"><img src="https://cdn.simpleicons.org/vite/646CFF" width="42" alt="Vite"/><br/><sub><b>Vite 7</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://cdn.simpleicons.org/nodedotjs/5FA04E" width="42" alt="Node.js"/><br/><sub><b>Node.js</b></sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/express/808080" width="42" alt="Express"/><br/><sub><b>Express 5</b></sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/postgresql/4169E1" width="42" alt="PostgreSQL"/><br/><sub><b>PostgreSQL</b></sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/neon/00E599" width="42" alt="Neon"/><br/><sub><b>Neon</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://cdn.simpleicons.org/n8n/EA4B71" width="42" alt="n8n"/><br/><sub><b>n8n</b></sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/googlegemini/8E75B2" width="42" alt="Google Gemini"/><br/><sub><b>Google Gemini</b></sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/whatsapp/25D366" width="42" alt="WhatsApp"/><br/><sub><b>WhatsApp</b></sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/vercel/808080" width="42" alt="Vercel"/><br/><sub><b>Vercel</b></sub></td>
  </tr>
</table>

The frontend is framework-free, modular JavaScript rendered by Vite. It does **not** use React. The backend uses CommonJS, Express, `pg`, Multer, CORS, and Vercel's database-pool lifecycle integration.

## 🏗️ System architecture

```mermaid
flowchart LR
    Customer[Customer]
    WA[Meta WhatsApp<br/>Cloud API]
    N8N[n8n automation]
    Gemini[Google Gemini]
    DB[(Neon PostgreSQL)]
    Browser[Restaurant staff]

    subgraph Vercel
      SPA[Vite admin SPA]
      API[Express API]
    end

    Customer <--> WA
    WA -->|incoming message| N8N
    N8N -->|customer reply| WA
    N8N <--> Gemini
    N8N <--> DB

    Browser --> SPA
    SPA -->|same-origin /admin requests| API
    API <--> DB
    API -->|persisted event ID| N8N
```

- Customer ordering is handled inside n8n using WhatsApp, Gemini, and direct parameterized PostgreSQL operations.
- The admin SPA communicates only with the authenticated Express API; database and automation credentials never enter the browser bundle.
- Admin status changes commit to Neon first. The backend then asks n8n to deliver the corresponding persisted customer event.

## 🔁 End-to-end order flow

```mermaid
sequenceDiagram
    actor Customer
    participant WA as WhatsApp Cloud API
    participant Flow as n8n workflow
    participant AI as Gemini
    participant DB as Neon PostgreSQL
    actor Admin
    participant API as Express API

    Customer->>WA: Send menu or order message
    WA->>Flow: WhatsApp trigger
    Flow->>DB: Deduplicate, buffer, load session and live menu
    Flow->>AI: Message + relevant menu + session context
    AI-->>Flow: Intent and tool calls
    Flow->>DB: Validate cart and commit confirmed order
    Flow-->>WA: Confirmation or follow-up
    WA-->>Customer: Customer reply

    Admin->>API: Load active orders
    API->>DB: Read committed order data
    Admin->>API: Advance status with expected status + request ID
    API->>DB: Lock, validate, update history, create outbox event
    API->>Flow: Dispatch persisted event identifiers
    Flow->>DB: Atomically claim event and load authoritative customer
    Flow->>AI: Phrase exact status in the customer's language
    Flow-->>WA: Send protected status update
    WA-->>Customer: Order status notification
```

## 📊 Admin dashboard

The dashboard is the restaurant's operational control centre.

| Module | Implemented capability |
|---|---|
| **Dashboard** | Today's orders and revenue, pending requests, active customers, 1/7/30-day activity, status distribution, and recent records. |
| **Orders** | Search/filter active orders, inspect items and customer details, advance valid statuses, view status history, and retry failed customer delivery. |
| **Pending Requests** | Search/filter staff decisions, review linked orders, approve or deny cancellation requests, add notes, and retry decision notifications. |
| **Order History** | Search/filter completed and cancelled orders by status, fulfilment type, and date; export the selected date range as CSV. |
| **Customers** | View customer activity, aggregate order/spend statistics, preferred language, recent orders, feedback, and conversation state. |
| **Feedback** | Review ratings and messages, filter by star rating, and monitor aggregate rating metrics. |
| **Menu** | Browse live items, variants, deals, and menu images; add items, change prices, and toggle availability. |
| **Notifications** | Track new orders, customer requests, delivery failures, and system events; mark one or all as read. |
| **Settings** | Edit restaurant name, currency, delivery charge, opening-hours JSON, and the administrator display name. |

The hash-based SPA navigation preserves the deployed single-page experience without creating duplicate server routes.

## 🧭 Order status management

PostgreSQL migration `016_dashboard_customer_status_events.sql` defines the authoritative state machine:

```mermaid
stateDiagram-v2
    [*] --> received
    received --> preparing
    received --> cancelled
    preparing --> oven
    preparing --> cancelled
    oven --> out_for_delivery: delivery
    oven --> completed: pickup
    out_for_delivery --> completed
    completed --> [*]
    cancelled --> [*]
```

| Internal value | Dashboard label | Customer meaning |
|---|---|---|
| `received` | Received | Order accepted and placed |
| `preparing` | Preparing | Restaurant is preparing the order |
| `oven` | Oven | Order is in the oven |
| `out_for_delivery` | Out for delivery | Delivery has left the restaurant |
| `completed` | Completed | Delivered or collected |
| `cancelled` | Cancelled | Order was cancelled |

Cancellation is permitted only while an order is `received` or `preparing`. Each admin change carries an expected current status and unique request ID, preventing stale views and double-clicks from creating conflicting transitions.

## 🗄️ Data model

Neon PostgreSQL is the shared source of truth for ordering, dashboard operations, and workflow durability.

| Domain | Primary tables and views |
|---|---|
| Customers and conversations | `customers`, `conversation_sessions`, `processed_messages`, `message_buffer`, `admin_message_claims` |
| Orders and decisions | `orders`, `order_status_history`, `admin_requests` |
| Menu | `restaurant_settings`, `restaurant_menu_rules`, `restaurant_menu_items`, `restaurant_menu_variants`, `restaurant_menu_aliases`, `restaurant_deals`, `restaurant_deal_components` |
| AI menu context | `restaurant_menu_for_ai`, `active_restaurant_menu_for_ai` views |
| Operations | `admin_notifications`, `customer_notification_events`, `feedback`, `admin_profile` |
| Media | `menu_images` |

Key relationships keep orders attached to their customer, requests attached to the correct order/customer, menu variants attached to items, deal components attached to deals, and outbound status events attached to the authoritative order/customer pair. Database triggers create order history and dashboard notifications; constraints and functions enforce lifecycle rules.

> `013_menu_v2.sql` rebuilds and seeds the canonical menu. Review the runtime-hardening notes before applying it to a database with production menu edits.

## 🖼️ Image storage

Menu images are stored in `menu_images.image_data` as PostgreSQL `BYTEA`; this project does not use an external object-storage provider.

- `POST /images/upload` accepts **2–3** authenticated images per request, up to 10 MB each.
- JPEG, PNG, GIF, and WebP are accepted only after MIME and file-signature checks.
- `GET /images` returns active image metadata and URLs.
- `GET /images/:id` streams the bytes with the stored MIME type and a one-hour public cache header.
- The n8n menu-image nodes currently reference the deployed `/images/1` and `/images/2` resources.

## 🧠 AI ordering system

The workflow uses `models/gemini-3.1-flash-lite` through n8n's Google Gemini chat-model node with a low-temperature, bounded-output configuration.

The ordering agent receives restaurant settings, relevant active menu records, menu rules, the persisted customer session, recent messages, and the latest debounced customer turn. It can invoke narrowly scoped PostgreSQL tools to look up menu records, update the cart, choose delivery or pickup, collect delivery details, place an explicitly confirmed order, request cancellation approval, or escalate a complaint.

Safety is layered around the model:

- Live database records—not model memory—define item IDs, variants, prices, deals, and policy.
- Tool results must confirm an operation before the assistant may claim it succeeded.
- Customer text is treated as untrusted data and internal prompts, credentials, and database details are forbidden in replies.
- Admin status messages use a separate agent branch with no ordering tools.
- A deterministic post-agent guard rejects contradictory, missing, overlong, or internal-detail status text and substitutes a safe localized fallback.

## ⚙️ n8n automation

The tracked [workflow.json](workflow.json) contains one active workflow definition with two isolated execution paths.

### Customer ordering path

```text
WhatsApp Trigger
  → normalize and buffer incoming message
  → deduplicate / debounce / claim latest customer turn
  → upsert customer and conversation session
  → load relevant active menu and restaurant settings
  → fast-path simple greetings or invoke Gemini ordering agent
  → execute validated PostgreSQL tools
  → send WhatsApp response
  → persist reply and finalize the claimed turn
```

### Admin status path

```text
Private admin-order-status webhook
  → validate event envelope
  → atomically claim persisted notification event
  → load authoritative order, customer, language, and history
  → produce and safety-check a localized status message
  → send WhatsApp update
  → persist provider ID or failure for dashboard retry
```

Implemented reliability controls include message buffering, duplicate-message protection, customer-turn claims, reply idempotency, a two-minute recovery lease for outbound events, stale-event superseding, status/request idempotency keys, failure visibility, and deliberate retry actions.

## ☁️ Deployment architecture

| Layer | Production service | Repository configuration |
|---|---|---|
| Frontend | Vercel Vite service | `frontend/`, built with `npm run build` to `dist` |
| Backend | Vercel Express service | `backend/api/index.js` |
| Routing | Vercel multi-service project | Root `vercel.json` |
| Database | Neon PostgreSQL | Ordered SQL migrations in `database/migration/` |
| Automation | n8n | `workflow.json` import |
| AI | Google Gemini | n8n Gemini credential and model node |
| Messaging | Meta WhatsApp Cloud API | n8n WhatsApp Trigger and send/tool credentials |

The same-origin Vercel layout means production normally needs no `VITE_API_URL`: the frontend safely defaults to `window.location.origin`, and Vercel rewrites API traffic to the backend service.

## 🔐 Environment variables

Real `.env` files are gitignored and no example env files are currently tracked. Create the files below locally; configure the equivalent values in the deployment platform without committing secrets.

### Backend — `backend/.env`

```env
PORT=3000
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
ADMIN_API_KEY=replace-with-a-long-random-secret
N8N_ADMIN_WEBHOOK_URL=https://YOUR_N8N_HOST/webhook/admin-order-status
N8N_ADMIN_WEBHOOK_TIMEOUT_MS=15000
CORS_ORIGINS=http://localhost:5173
FRONTEND_URL=http://localhost:5173
```

| Variable | Purpose | Required |
|---|---|:---:|
| `DATABASE_URL` | Neon PostgreSQL connection string | ✅ |
| `ADMIN_API_KEY` | Shared secret accepted through `x-admin-key` | ✅ |
| `N8N_ADMIN_WEBHOOK_URL` | Private n8n production webhook for persisted customer events | ✅ for status delivery |
| `N8N_ADMIN_WEBHOOK_TIMEOUT_MS` | Webhook timeout; defaults to 15,000 ms | Optional |
| `CORS_ORIGINS` | Comma-separated browser origins; production should include the deployed frontend | ✅ in production |
| `FRONTEND_URL` | Dashboard redirect target and additional allowed origin | ✅ in production |
| `PORT` | Local Express port; defaults to `3000` | Optional |

### Frontend — `frontend/.env`

```env
# Local split-server development only
VITE_API_URL=http://localhost:3000
```

`VITE_API_URL` is optional in the same-origin Vercel deployment. The client also refuses to use a loopback API URL from a non-loopback page. Never place `DATABASE_URL`, `ADMIN_API_KEY`, webhook URLs, Meta tokens, or WhatsApp credentials in a `VITE_*` variable.

### n8n credentials

Configure credentials inside n8n for PostgreSQL, the WhatsApp Trigger, WhatsApp sending, and Google Gemini. Recheck the WhatsApp Phone Number ID fields after import. Credential secrets are intentionally not documented or stored as environment examples in this repository.

## 🧑‍💻 Local development

### Prerequisites

- Node.js and npm compatible with Vite 7
- A PostgreSQL/Neon database
- n8n, Gemini, and Meta WhatsApp credentials only when testing the complete messaging flow

### 1. Clone and install

```bash
git clone https://github.com/muhammad-abbas-10/Pizza-Whatsapp-AI-Bot.git
cd Pizza-Whatsapp-AI-Bot

cd backend
npm install

cd ../frontend
npm install
```

The repository is private at the time of writing, so cloning requires authorized GitHub access.

### 2. Configure the database and backend

Create `backend/.env` from the variables above. For a fresh database, apply migrations in numeric order. From `backend/` on PowerShell:

```powershell
Get-ChildItem ../database/migration/*.sql |
  Sort-Object Name |
  ForEach-Object { node scripts/run-migration.js $_.Name }
```

For an existing database, review [runtime-hardening-013-016.md](docs/runtime-hardening-013-016.md) before running menu migration `013` or legacy cleanup `014`; then apply only the migrations appropriate to that environment. Performance indexes are in migration `017`.

### 3. Start both applications

Backend terminal:

```bash
cd backend
npm run dev
```

Frontend terminal:

```bash
cd frontend
npm run dev
```

Open the Vite URL, enter the configured `ADMIN_API_KEY`, and keep the key only in the current browser tab's session storage.

### 4. Validate

```bash
cd backend
npm test

cd ../frontend
npm test
npm run build
```

Database-backed integration scripts are available separately and require a configured test database. They use rollback-oriented checks where documented and do not intentionally send live WhatsApp messages.

## 🚢 Production deployment

### Vercel

1. Import the repository into Vercel and select the **Services** application preset.
2. Keep the root directory at the repository root. The root `vercel.json` defines the `frontend` and `backend` services plus same-origin rewrites.
3. Add the backend environment variables from the table above. Set both `FRONTEND_URL` and `CORS_ORIGINS` to the final HTTPS dashboard origin.
4. Leave `VITE_API_URL` unset for the current same-origin architecture. If a separate API domain is introduced later, set it to that HTTPS origin before building the frontend.
5. Deploy, then verify `/`, `/health`, and `/images`.

### Neon

1. Create or select the production database and keep its connection string server-side.
2. Apply the migration set in numeric order for a fresh installation, or use the runtime-hardening guide for an existing database.
3. Confirm `/health` reports a connected database before enabling production traffic.

### n8n, Gemini, and WhatsApp

1. Import `workflow.json` into n8n and deactivate any older competing workflow before activation.
2. Reconnect the target instance's PostgreSQL, WhatsApp Trigger, WhatsApp API, and Google Gemini credentials.
3. Verify the WhatsApp Phone Number ID on every send/tool node and confirm `/images/1` and `/images/2` resolve if menu-image delivery is enabled.
4. Activate the workflow and configure Meta's production webhook to use the native **WhatsApp Trigger**.
5. Copy the production URL for **Admin Order Status Webhook** (`/webhook/admin-order-status`) into `N8N_ADMIN_WEBHOOK_URL`, then redeploy the backend environment.
6. Exercise one test order and one forward status change, checking the dashboard event lifecycle before production use.

The WhatsApp Trigger credential must be configured with the Meta application secret needed for webhook signature verification. Keep all provider credentials in their native secure stores.

## 🛡️ Security model

- **Admin access:** all `/admin/*` routes require a server-configured shared key through `x-admin-key`; equality is checked with `crypto.timingSafeEqual`.
- **Session scope:** the browser stores the admin key in `sessionStorage`, not persistent local storage.
- **Attempt throttling:** each warm backend instance blocks an address after 10 failed key attempts within 15 minutes. This is an in-memory control, not a distributed rate limiter.
- **CORS:** origins are normalized and matched against an explicit allowlist; production credentials are never exposed through CORS configuration.
- **Request hardening:** JSON is limited to 1 MB; image count, size, MIME, and binary signature are validated; defensive response headers deny framing and MIME sniffing.
- **Data integrity:** SQL inputs are parameterized, sensitive changes use transactions and row locks, and PostgreSQL constraints enforce ownership and valid status transitions.
- **Notification safety:** the browser never receives the n8n webhook URL. n8n validates identifiers, atomically claims the database event, and loads the authoritative phone from the order/customer relationship.
- **Idempotency:** unique request IDs, expected-status checks, persisted claims, and event states suppress common double-click, retry, and concurrency duplicates.

This implementation uses a shared admin API key—not JWT or username/password authentication. Public `GET /images` routes intentionally serve active menu media; image upload remains authenticated.

## ⚡ Performance design

- A module-level `pg.Pool` is reused by warm Vercel functions and registered with `attachDatabasePool`; connection and idle timeouts prevent hanging clients.
- Migration `017_admin_read_performance.sql` indexes recent order, status/date, update activity, and active-session reads.
- List endpoints paginate orders, requests, customers, feedback, and notifications; the dashboard aggregates its cards and recent records in one bounded query.
- Independent detail queries run in parallel where appropriate.
- The browser API client applies route-specific TTLs, stale-while-revalidate rendering, in-flight GET deduplication, 10-second timeouts, and abort-on-navigation.
- A lightweight `/admin/activity` poll runs every 15 seconds only when the tab is visible and idle, refreshing the active page only when its version changes.
- Mutations clear client caches; HTTP responses use private cache policies, while image bytes receive a public one-hour cache.

## 📁 Project structure

```text
Pizza-Whatsapp-Bot/
├── backend/
│   ├── api/
│   │   └── index.js                 # Express/Vercel entrypoint and image API
│   ├── scripts/                     # migrations, smoke tests, workflow/test tools
│   ├── src/
│   │   ├── admin-routes.js          # authenticated operational API
│   │   └── customer-notification-events.js
│   ├── package.json
│   ├── server.js                    # local server entrypoint
│   └── vercel.json
├── database/
│   └── migration/                   # ordered migrations 001–017
├── docs/
│   ├── n8n-workflow-audit.md
│   ├── runtime-hardening-013-015.md
│   └── runtime-hardening-013-016.md
├── frontend/
│   ├── scripts/
│   │   └── test-api-performance.js
│   ├── src/
│   │   ├── api.js                   # fetch, cache, timeout, and auth client
│   │   ├── main.js                  # SPA routes, rendering, and interactions
│   │   ├── styles.css               # responsive design system
│   │   └── utils.js
│   ├── index.html
│   ├── package.json
│   └── vercel.json
├── workflow.json                    # n8n customer + admin-status workflow
├── vercel.json                      # production multi-service routing
└── README.md
```

## 🔌 API overview

All `/admin/*` endpoints require `x-admin-key`. Query parameters support the filters and pagination used by the dashboard.

| Area | Method and endpoint | Purpose |
|---|---|---|
| System | `GET /health` | Check API-to-database connectivity |
| System | `GET /dashboard` | Redirect to the configured frontend |
| Session | `GET /admin/session` | Restaurant profile, admin profile, integrations, and unread count |
| Activity | `GET /admin/activity` | Lightweight version markers for background refresh |
| Dashboard | `GET /admin/dashboard` | KPIs, activity, statuses, and recent records |
| Orders | `GET /admin/orders` · `GET /admin/orders/:id` | Paginated list and order details |
| Orders | `PATCH /admin/orders/:id/status` | Apply one canonical status transition |
| Orders | `POST /admin/orders/:id/notifications/:eventId/retry` | Retry a failed persisted event |
| History | `GET /admin/order-history/export.csv` | Download filtered terminal orders |
| Requests | `GET /admin/requests` · `GET /admin/requests/:id` | List and inspect customer requests |
| Requests | `POST /admin/requests/:id/approve` · `/deny` · `/reject` | Resolve a staff decision |
| Requests | `POST /admin/requests/:id/notify` | Retry its customer notification |
| Customers | `GET /admin/customers` · `GET /admin/customers/:id` | Customer list, statistics, and details |
| Feedback | `GET /admin/feedback` · `POST /admin/feedback` | Report or persist authenticated feedback |
| Menu | `GET /admin/menu` · `POST /admin/menu/items` | Read menu or create a menu item |
| Menu | `PATCH /admin/menu/:kind/:id` | Edit/toggle an item or deal |
| Menu | `PATCH /admin/menu/items/:itemId/variants/:variantId` | Update a variant price |
| Menu | `DELETE /admin/menu/:kind/:id` | Soft-deactivate an item or deal |
| Notifications | `GET /admin/notifications` | Paginated operational notifications |
| Notifications | `PATCH /admin/notifications/:id/read` · `POST /admin/notifications/read-all` | Update read state |
| Settings | `GET /admin/settings` · `PATCH /admin/settings` | Read or update restaurant/admin settings |
| Images | `GET /images` · `GET /images/:id` | Public active image metadata and bytes |
| Images | `POST /images/upload` | Authenticated 2–3 image upload |

### Status-update contract

```http
PATCH /admin/orders/:id/status
x-admin-key: <admin-secret>
Content-Type: application/json

{
  "status": "oven",
  "expected_status": "preparing",
  "request_id": "<uuid>"
}
```

The response separates the committed order state from customer-notification delivery. A successful database transition therefore remains truthful even if downstream WhatsApp delivery needs a retry.

## ✅ Project status

**Deployed and operational.** The customer ordering workflow, AI/menu tools, WhatsApp integration, responsive admin dashboard, Express API, Neon schema, durable status notifications, and Vercel multi-service deployment are implemented. The public dashboard, health check, and image catalogue were verified during this README update.

## 🛣️ Future improvements

These are optional extensions, not missing core functionality:

- Multi-branch tenancy and role-based staff accounts
- Online payment-provider integration
- Dedicated object storage/CDN for a larger media catalogue
- Centralized observability and a distributed authentication rate limiter
- Deeper forecasting and kitchen-performance analytics

## 🤝 Contributing

This repository is currently private. Authorized collaborators can open an issue, create a focused branch, run the backend/frontend validation commands, and submit a pull request with migration or workflow implications documented clearly. Never commit `.env` files, credential secrets, access tokens, or customer data; review workflow identifiers before sharing an export.

## 📄 License

No repository-level `LICENSE` file is currently present. The backend package metadata declares `ISC`, but that declaration is not a substitute for a project-wide license file. Treat the repository as private, all-rights-reserved client software unless the owner adds an explicit license.

---

<div align="center">

### 🍕 Pizza WhatsApp AI Bot

AI ordering, reliable automation, and restaurant operations in one connected platform.

**[🌐 Live Dashboard](https://pizza-whatsapp-ai-bot.vercel.app/) · [📦 Repository](https://github.com/muhammad-abbas-10/Pizza-Whatsapp-AI-Bot)**

</div>
