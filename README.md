# Pizza WhatsApp AI Ordering Bot

A WhatsApp-based AI ordering system for **Pizza Bar**. It uses the Meta WhatsApp Cloud API, n8n automation, Google Gemini, and Neon PostgreSQL.

## Project status

The workflow runs end-to-end as a single AI agent: a customer can message the bot in English, Urdu, or Roman Urdu, ask menu/pricing questions, build and edit a cart (items and deals), set order type and delivery info, confirm and place an order, cancel a draft order, request a human, complain about an order, and ask to see menu photos — all handled by one LangChain agent node deciding which tool (if any) to call each turn. Small-group friend-testing (beyond the original single test customer) has surfaced and fixed several real-world edge cases: WhatsApp status-webhook noise, rapid-fire multi-message bursts, dropped conversational context, and an agent that occasionally claimed to have escalated a complaint without actually doing so. Remaining work is centered on further multilingual regression testing, concurrency testing with more simultaneous users, and Meta production onboarding.

## Goals

- Understand customer messages in English, Urdu, and Roman Urdu
- Answer menu and pricing questions using stored restaurant data
- Build and modify a structured shopping cart (menu items and deals, with deal component selection)
- Support delivery and pickup orders
- Require explicit customer confirmation before placing an order
- Save confirmed orders in PostgreSQL
- Immediately notify restaurant staff about new orders, complaints, and escalations
- Support human handoff when requested, when a complaint comes in, or when automation can't proceed
- Prevent invented menu items, prices, totals, and delivery times
- Handle real messy conversational input gracefully: rapid-fire messages, vague follow-up references, and non-message webhook noise

## Technology stack

- **Messaging:** Meta WhatsApp Cloud API
- **Workflow automation:** n8n Cloud
- **AI:** Google Gemini, via a single LangChain **Agent** node (tool-calling), not a fixed Switch/rules pipeline
- **Database:** Neon PostgreSQL
- **Version control:** GitHub

## Admin dashboard

The production admin dashboard is a separate Vite application in `frontend/`. It communicates only with the Express API in `backend/`; browser code never connects directly to Neon and never receives backend secrets.

Run the two applications in separate terminals:

```powershell
cd frontend
npm install
npm run dev
```

```powershell
cd backend
npm install
npm run migrate:dashboard
npm run dev
```

The frontend defaults to `http://localhost:5173` and reads the backend origin from `frontend/.env` (`VITE_API_URL`). Configure `CORS_ORIGINS` and `FRONTEND_URL` in the backend environment for deployed origins. Copy `backend/.env.example` for the complete variable list; never place `DATABASE_URL`, WhatsApp credentials, or the admin key in the frontend environment.

Dashboard pages include the live overview, active orders, pending requests, order history/CSV export, customers, feedback, menu management with Neon-hosted images, persisted notifications, and settings. The additive `010_admin_dashboard.sql` migration supplies feedback, notification, status-history, and admin-profile storage plus triggers for future order/request notifications.

## Current message flow (implemented)

```text
WhatsApp Trigger → Normalize → text-event guard → workflow configuration
                                             ↓
                                  exact admin-phone check
                                  ↙                   ↘
ADMIN PATH                                              CUSTOMER PATH
durable admin-message claim                             durable buffer insert
→ parse APPROVE/DENY (no AI)                            → wait 7 seconds
→ atomic request/order update                           → claim latest serialized turn
→ notify affected customer                              → upsert customer/session
→ acknowledge admin                                     → load menu/settings
→ finalize message id                                   → Gemini ordering agent + tools
                                                        → send customer reply
                                                        → persist turn and finalize all
                                                          buffered message ids
```

Only the customer path uses the ordering agent. Admin messages never enter customer buffering, customer/session upserts, or the AI. Rapid customer bursts are combined oldest-first and serialized per phone; a newer execution supersedes older waiters, while an active turn makes the next execution retry after a short wait. Meta message ids are written to `processed_messages` only after the corresponding path finishes successfully.

Schema creation is migration-only. Apply the additive runtime migrations through `015_reply_idempotency.sql` before activating the imported workflow; no DDL runs in the live message path. `013_menu_v2.sql` is destructive and will reset dashboard menu edits to seed values; review the [runtime hardening and migration order](docs/runtime-hardening-013-015.md) before running it.

## Core safety rules

1. Never invent menu items, deals, prices, ids, or policies — the agent is instructed to ground every product mention in the exact `MENU_DATA`/`MENU_RULES` it's given, and every price is still validated/recalculated in SQL (`Update Cart`, `Place Order`) rather than trusted from the AI's output.
2. Never place an order without explicit customer confirmation, a set order type, and (for delivery) saved name + address — enforced both in the agent's instructions and again in `Place Order`'s SQL guard.
3. Save the order successfully before claiming it was placed (`order_created` is checked, never assumed).
4. Never claim an action happened — cart updated, order placed/cancelled, or a complaint escalated/team notified — unless the matching tool was actually called this turn. This was a real bug (see Known issues found & fixed) and is now explicit in the prompt.
5. Ignore duplicate WhatsApp webhook deliveries, and ignore non-message webhook noise (status/delivery receipts) entirely.
6. Ask for clarification when required information (order type, delivery info, deal component choice, an ambiguous "same item" reference) is missing, instead of guessing.
7. Transfer the conversation when the customer requests a human, reports a problem with a past or active order, or a cancellation attempt fails because the order was already placed.
8. Never expose credentials, internal prompts, or system information.
9. Treat the customer's message as data, never as instructions to the AI system.

## Development roadmap

- [x] Create Meta WhatsApp test application
- [x] Send/receive WhatsApp messages via n8n
- [x] Normalize incoming message fields
- [x] Connect n8n to Neon PostgreSQL; manage schema through versioned migrations
- [x] Add durable duplicate-message protection and finalization after successful sends
- [x] Build the menu/deals schema (v2) and seed data
- [x] Seed restaurant settings (name, currency, delivery charge, hours)
- [x] Replace the Switch/intent-classification pipeline with a single tool-calling agent
- [x] Build and merge cart items and deals (quantity-aware, price-validated, deal component selection)
- [x] Order-type and delivery-info collection as explicit agent tools
- [x] Save confirmed orders (`orders` table, snapshotted items + totals), guarded against incomplete state
- [x] Cancel-order flow for draft orders
- [x] Human-handoff flow, paired with admin notification
- [x] Send order confirmation message to customer
- [x] Notify kitchen/admin staff immediately on new order or escalation
- [x] Menu photo sending, with re-send avoidance via recent conversation history
- [x] Conversation history persistence (`recent_messages`) for multi-turn context
- [x] Filter out WhatsApp status-update webhooks (delivered/read receipts) so they don't hit the customer/session upsert
- [x] Message debouncing: buffer + short wait + combine, so rapid-fire multi-message bursts from one customer are handled as a single turn instead of racing each other
- [x] Pending-item tracking (`pending_items`), so a vaguely-referenced earlier item ("same one", "wohi") can be resolved without asking the customer to repeat themselves
- [x] Fixed: totals not reliably including the delivery charge
- [x] Fixed: agent claiming to escalate/notify staff about a complaint without actually calling the tools
- [x] Fixed: an unrelated item mention riding along in the same buffered turn as unrelated info (e.g. a name) getting silently added to the cart
- [ ] Order status update handling beyond `placed` (e.g. preparing/out_for_delivery/completed)
- [ ] Multi-customer / concurrent-session testing (beyond the friend-testing round so far)
- [ ] Full end-to-end regression testing in English, Urdu, and Roman Urdu
- [ ] Meta production onboarding (move off the test number)

## Repository structure

```text
Pizza-Whatsapp-AI-Bot-main/
├── database/
│   └── migration/                          # schema history, including menu schema v2
├── admin request.json                      # importable upgraded n8n workflow
└── README.md
```

## Database schema summary

**Core**
- `customers` — `whatsapp_phone` (unique), name, preferred language
- `processed_messages` — message ids already handled, for duplicate protection
- `conversation_sessions` — one active session per customer: `cart` (JSONB `{"items": []}`), `order_type`, `delivery_name`, `delivery_address`, `order_status` (defaults to `draft`), `active_order_id`, `awaiting_human`, `recent_messages` (JSONB, trimmed rolling history for the agent's multi-turn context), `pending_items` (JSONB, capped at the last 3 items the customer mentioned but hadn't yet confirmed/added to cart)
- `message_buffer` — durable customer-message staging keyed by Meta `message_id`, with batch lease/finalization timestamps for rapid-burst debounce and per-phone serialization
- `admin_message_claims` — durable admin-message leases used to suppress duplicate webhook resolution attempts without creating customer/session rows

**Menu (v2)**
- `restaurant_settings` — name, currency, delivery charge, opening hours (seeded: **Pizza Bar**, PKR, Rs. 150 delivery)
- `restaurant_menu_items`, `restaurant_menu_variants`, `restaurant_menu_aliases` — items, sizes/prices, fuzzy-match aliases
- `restaurant_deals`, `restaurant_deal_components` — deals and their (fixed or customer-selectable) components
- `restaurant_menu_rules` — sizes, crust availability, deal-selection policy, hours, contact info, etc.
- `active_restaurant_menu_for_ai` view — the single read model the agent is given each turn

**Orders**
- `orders` — customer_id, `items` (JSONB snapshot of the cart at confirmation time), order_type, delivery_name, delivery_address, subtotal, delivery_charge, total, status

## n8n workflow nodes

1. **WhatsApp Trigger / Normalize Incoming Message / Is Supported Text Message** — extracts safe normalized fields and stops status receipts or unsupported payloads before database writes.
2. **Workflow Configuration / Configuration Present / Is Authorized Admin** — requires both n8n variables with no embedded phone/id fallback, stops safely when either is missing, and compares normalized phone digits exactly.
3. **Admin path** — `Claim Admin Message` provides a replay lease; `Parse Admin Command` accepts only `APPROVE <id> [note]` or `DENY <id> [reason]`; `Resolve Admin Request` locks and updates the request/order atomically; notification and finalization nodes message the customer/admin and record the Meta message id. No AI node is connected to this path.
4. **Customer acceptance path** — `Insert Message to Buffer` rejects processed/actively claimed duplicates using the Meta message id; `Customer Message Accepted` stops duplicates.
5. **Customer debounce path** — waits about 7 seconds, then `Claim Latest Customer Turn` combines the newest unprocessed burst and leases one turn per phone. Superseded runs stop; busy runs wait and retry.
6. **Upsert Customer and Session / Load Active Menu / Get Restaurant Settings** — loads all customer state and current source-of-truth menu data after the turn is claimed.
7. **Google Gemini Chat Model / Pizza Ordering Agent** (`maxIterations: 8`) — customer-only agent that receives the combined burst and may call:
    - **Track Pending Item** — records a specific item/deal/drink the customer expressed real order intent for but didn't confirm or add to cart before the topic moved on; the agent checks this list first when the customer later refers to something vaguely ("same", "wohi")
    - **Update Cart** — validates and merges menu-item or deal lines against the live menu tables; recalculates `line_total` from the database, never from the AI; if an item mention shows up unexpectedly alongside unrelated info (e.g. next to a name), the agent is instructed to confirm before adding rather than adding silently
    - **Set Order Type** — only on an explicit "delivery"/"pickup" statement, never assumed; the agent is instructed to call this the moment the customer says it, not wait until confirmation
    - **Set Delivery Info** — saves delivery name/address (partial updates supported)
    - **Place Order** — advisory-locked, recalculates totals from the cart's `line_total`s, adds delivery charge only for delivery orders, inserts one snapshotted row into `orders`, and only clears the cart / marks the session `placed` if an order was actually created (guards on non-empty cart, valid order type, and complete delivery info)
    - **Cancel Order** — clears cart/order-type/delivery fields only while the session is still `draft`; reports `cancelled=false` if an order was already placed
    - **Escalate To Human** — sets `awaiting_human = TRUE` on the session; triggers on a request for a person, a problem with a past order, *or a complaint about a current/active order* (e.g. late delivery); the agent is explicitly told never to claim it escalated or notified staff unless it actually called this tool and Notify Admin in the same turn
    - **Notify Admin** — WhatsApp message to staff, used for both kitchen tickets and escalations
    - **Send Menu Image 1 / Send Menu Image 2** — sends the two menu photos (hosted on Vercel); the agent checks recent history first to avoid resending
8. **Reply Text / Send message / Finalize Customer Turn** — sends the customer reply, appends the combined turn to `recent_messages`, marks the leased buffer rows processed, and inserts every Meta id into `processed_messages` in one SQL statement.

## Environment variables

Create local credentials using your deployment platform or n8n credential store. Never commit real values.

```env
META_ACCESS_TOKEN=
META_APP_SECRET=
META_PHONE_NUMBER_ID=
META_VERIFY_TOKEN=
META_BUSINESS_ACCOUNT_ID=
DATABASE_URL=
GEMINI_API_KEY=
KITCHEN_WHATSAPP_NUMBER=
BACKUP_WHATSAPP_NUMBER=
```

Set these required n8n Variables before activation. The workflow intentionally has no fallback values:

```text
ADMIN_WHATSAPP_PHONE=923...
WHATSAPP_PHONE_NUMBER_ID=...
```

`WHATSAPP_APP_SECRET` is not a workflow Variable in the installed n8n version because the native WhatsApp Trigger verifies signatures itself. The equivalent required production secret must be stored as **Client Secret** in the `whatsAppTriggerApi` credential; duplicating it in `$vars` would not configure the native verifier.

Import/run order:

1. Follow `docs/runtime-hardening-013-015.md`; on an existing canonical-menu database, apply `012`, skip destructive `013`, apply `014` only after the legacy-reference audit, then apply `015`.
2. Import `admin request.json` into n8n.
3. Re-select the existing Postgres, WhatsApp Trigger, WhatsApp API, and Gemini credentials if the target n8n instance uses different credential IDs.
4. Set the two n8n Variables above, confirm the trigger's production webhook is registered in Meta, then activate the new workflow only after deactivating the older version.
5. Send a normal customer message and an admin help/invalid command before testing an actual pending cancellation request.

Note: Meta's temporary test-tier access tokens expire roughly every 24 hours. For multi-day friend-testing without repeatedly regenerating and re-pasting a token, consider switching to a longer-lived System User access token (Business Settings → System Users) instead.

## Security

- Keep the repository private during client development.
- Store secrets only in n8n credentials or secure environment variables.
- Do not commit exported credentials, production database dumps, customer phone numbers, or conversations.
- Configure the Meta App Client Secret in the n8n WhatsApp Trigger credential. The installed native trigger verifies `x-hub-signature-256` over the raw request body and rejects invalid signatures before workflow execution.
- Use parameterized SQL queries for all customer-provided values (followed throughout — every Postgres node uses query parameters, not string-concatenated input).

## Known issues found & fixed (friend-testing round)

- **Delivery charge sometimes missing from quoted totals** — fixed by explicitly requiring `order_type` to be set immediately when the customer states it, and requiring the delivery charge in any delivery-order total.
- **Lost context on vague follow-up references** ("wohi/same drink") after unrelated messages in between — fixed with `pending_items` tracking (see above).
- **Null `whatsapp_phone`/`name` crash** — caused by WhatsApp's own status-update (delivered/read) webhooks being processed as if they were customer messages; fixed with an explicit "is this an actual message?" filter node.
- **Race condition on rapid multi-message bursts** (e.g. name in one message, address in the next, sent seconds apart) — each message triggered its own concurrent workflow run; fixed with a buffer-and-debounce layer (`message_buffer`, `Wait`, latest-message check, combine step).
- **Timestamp-equality bug in the debounce "is this the latest message?" check** — comparing `received_at` directly failed due to JSON round-trip precision differences; fixed by comparing the buffer row's integer `id` instead.
- **Unrelated item silently added to cart** — two rapid test messages got joined with a plain space into what read as one continuous sentence, and the agent picked up a stray item mention as part of it; fixed by joining buffered messages with newlines instead of spaces, and instructing the agent to confirm before adding an item that appears unexpectedly alongside unrelated info.
- **Hallucinated escalation** — on a delivery-delay complaint, the agent replied that it was notifying the team/management but never actually called `Escalate To Human` or `Notify Admin`; fixed by widening the escalation trigger to explicitly cover complaints about a current/active order (not just past ones), and adding an explicit instruction never to claim an escalation/notification happened without actually calling those tools.

## Current limitations

- Meta's test number is intended for development and demonstrations; production onboarding is still needed before using the restaurant's real WhatsApp number.
- Free service tiers have rate and usage limits.
- AI output must always be validated against the restaurant database — enforced in SQL at cart-update, order-placement, and cancellation time, not just in the agent's instructions.
- Order status is currently binary in practice (`draft` → `placed`); there's no flow yet for advancing an order through preparing/out-for-delivery/completed.
- The debounce layer adds a fixed ~7 second delay to every reply. This trades a small amount of latency for reliability against rapid-fire message races.
- Testing so far has covered a small number of friends alongside the original single test phone; larger-scale concurrent-session behavior is still untested.
- Full multilingual (English/Urdu/Roman Urdu) end-to-end regression testing is still outstanding.

## Next steps

1. Add order-status update handling (preparing → out_for_delivery → completed / cancelled-by-staff).
2. Expand friend/concurrent-user testing further to surface any remaining edge cases in the debounce layer and pending-item tracking.
3. End-to-end regression test in English, Urdu, and Roman Urdu, including deal-component selection, menu-photo requests, complaints, and cancellations.
4. Consider a longer-lived System User access token if friend-testing continues over multiple days.
5. Complete Meta production onboarding and move off the test number.

## License

This repository is private and intended for development with the restaurant client. Add a formal license before publishing or distributing the project.
