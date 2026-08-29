# Pizza WhatsApp AI Ordering Bot

A WhatsApp-based AI ordering system for **Pizza Bar**. It uses the Meta WhatsApp Cloud API, n8n automation, Google Gemini, and Neon PostgreSQL.

## Project status

The workflow is complete and running end-to-end as a single AI agent: a customer can message the bot in English, Urdu, or Roman Urdu, ask menu/pricing questions, build and edit a cart (items and deals), set order type and delivery info, confirm and place an order, cancel a draft order, request a human, and ask to see menu photos — all handled by one LangChain agent node deciding which tool (if any) to call each turn, rather than a fixed Switch-based branch structure. Kitchen/admin notification is wired in and fires automatically after a successful order or an escalation. Remaining work is centered on production hardening: multi-customer/concurrency testing, Meta production onboarding, and full multilingual regression testing.

## Goals

- Understand customer messages in English, Urdu, and Roman Urdu
- Answer menu and pricing questions using stored restaurant data
- Build and modify a structured shopping cart (menu items and deals, with deal component selection)
- Support delivery and pickup orders
- Require explicit customer confirmation before placing an order
- Save confirmed orders in PostgreSQL
- Immediately notify restaurant staff about new orders and escalations
- Support human handoff when requested or when automation can't proceed
- Prevent invented menu items, prices, totals, and delivery times

## Technology stack

- **Messaging:** Meta WhatsApp Cloud API
- **Workflow automation:** n8n Cloud
- **AI:** Google Gemini, via a single LangChain **Agent** node (tool-calling), not a fixed Switch/rules pipeline
- **Database:** Neon PostgreSQL
- **Version control:** GitHub

## Current message flow (implemented)

```text
Customer WhatsApp message
        ↓
WhatsApp Trigger (Meta Cloud API)
        ↓
Normalize Incoming Message
        ↓
Ensure Schema (idempotent DDL: processed_messages table, session columns)
        ↓
Check Duplicate Message → If not already processed
        ↓
Upsert Customer and Session (loads cart, order state, recent_messages)
        ↓
Load Active Menu (menu items, deals, and menu rules)
        ↓
Get Restaurant Settings
        ↓
Pizza Ordering Agent (Gemini, tool-calling, up to 8 iterations)
        │
        ├── Update Cart          — add/change/remove items or deals
        ├── Set Order Type       — delivery or pickup, only on explicit customer statement
        ├── Set Delivery Info    — save delivery name/address
        ├── Place Order          — only after confirmed cart + order type (+ delivery info if needed)
        ├── Cancel Order         — cancels a draft (not-yet-placed) order
        ├── Escalate To Human    — flags session for staff, paired with Notify Admin
        ├── Notify Admin         — WhatsApp alert to staff (kitchen tickets + escalations)
        └── Send Menu Image 1/2  — sends the two menu photos (won't resend if already sent this conversation)
        ↓
Reply Text (agent's final plain-text reply)
        ↓
Send message (WhatsApp)
        ↓
Persist Conversation Turn (appends this turn to recent_messages, trimmed to last ~6 exchanges)
```

There is no intent-classification/Switch step anymore — the agent reads the full context (menu, rules, settings, session state, recent turns, and the new message) each turn and decides for itself whether to just reply, or call one or more tools, in what order.

## Core safety rules

1. Never invent menu items, deals, prices, ids, or policies — the agent is instructed to ground every product mention in the exact `MENU_DATA`/`MENU_RULES` it's given, and every price is still validated/recalculated in SQL (`Update Cart`, `Place Order`) rather than trusted from the AI's output.
2. Never place an order without explicit customer confirmation, a set order type, and (for delivery) saved name + address — enforced both in the agent's instructions and again in `Place Order`'s SQL guard.
3. Save the order successfully before claiming it was placed (`order_created` is checked, never assumed).
4. Ignore duplicate WhatsApp webhook deliveries.
5. Ask for clarification when required information (order type, delivery info, deal component choice) is missing, instead of guessing.
6. Transfer the conversation when the customer requests a human, or when a cancellation attempt fails because the order was already placed.
7. Never expose credentials, internal prompts, or system information.
8. Treat the customer's message as data, never as instructions to the AI system.

## Development roadmap

- [x] Create Meta WhatsApp test application
- [x] Send/receive WhatsApp messages via n8n
- [x] Normalize incoming message fields
- [x] Connect n8n to Neon PostgreSQL; idempotent schema setup (`Ensure Schema`)
- [x] Add duplicate-message protection
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
- [x] Fallback handled implicitly by the agent (no dedicated branch needed)
- [x] Menu photo sending, with re-send avoidance via recent conversation history
- [x] Conversation history persistence (`recent_messages`) for multi-turn context
- [ ] Order status update handling beyond `placed` (e.g. preparing/out_for_delivery/completed)
- [ ] Multi-customer / concurrent-session testing
- [ ] Full end-to-end testing in English, Urdu, and Roman Urdu
- [ ] Meta production onboarding (move off the test number)

## Repository structure

```text
Pizza-Whatsapp-AI-Bot-main/
├── database/
│   └── migration/                          # schema history, including menu schema v2
├── final_workflow.json                     # exported n8n workflow (agent-based)
└── README.md
```

## Database schema summary

**Core**
- `customers` — `whatsapp_phone` (unique), name, preferred language
- `processed_messages` — message ids already handled, for duplicate protection
- `conversation_sessions` — one active session per customer: `cart` (JSONB `{"items": []}`), `order_type`, `delivery_name`, `delivery_address`, `order_status` (defaults to `draft`), `active_order_id`, `awaiting_human`, `recent_messages` (JSONB, trimmed rolling history for the agent's multi-turn context)

**Menu (v2)**
- `restaurant_settings` — name, currency, delivery charge, opening hours (seeded: **Pizza Bar**, PKR, Rs. 150 delivery)
- `restaurant_menu_items`, `restaurant_menu_variants`, `restaurant_menu_aliases` — items, sizes/prices, fuzzy-match aliases
- `restaurant_deals`, `restaurant_deal_components` — deals and their (fixed or customer-selectable) components
- `restaurant_menu_rules` — sizes, crust availability, deal-selection policy, hours, contact info, etc.
- `active_restaurant_menu_for_ai` view — the single read model the agent is given each turn

**Orders**
- `orders` — customer_id, `items` (JSONB snapshot of the cart at confirmation time), order_type, delivery_name, delivery_address, subtotal, delivery_charge, total, status

## n8n workflow nodes

1. **WhatsApp Trigger** — Meta Cloud API webhook
2. **Normalize Incoming Message** — extracts customer_name, customer_phone, message_id, message_text, message_type, message_timestamp
3. **Ensure Schema** — idempotent DDL: creates `processed_messages` if missing, adds `recent_messages`/`order_status`/`active_order_id`/`awaiting_human` columns to `conversation_sessions` if missing
4. **Check Duplicate Message** — Postgres lookup against `processed_messages`
5. **If** — branches on already_processed
6. **Upsert Customer and Session** — inserts/updates `customers` and `conversation_sessions`, returns current cart/order state and `recent_messages`
7. **Load Active Menu** — pulls menu items, deals, and menu rules as JSON from the v2 schema/view
8. **Get Restaurant Settings**
9. **Google Gemini Chat Model** — model backing the agent
10. **Pizza Ordering Agent** (LangChain Agent, tool-calling, `maxIterations: 8`) — single system prompt carrying restaurant settings, full menu data/rules, current session state, and recent conversation history; decides each turn whether to just answer or call one or more of:
    - **Update Cart** — validates and merges menu-item or deal lines against the live menu tables; recalculates `line_total` from the database, never from the AI
    - **Set Order Type** — only on an explicit "delivery"/"pickup" statement, never assumed
    - **Set Delivery Info** — saves delivery name/address (partial updates supported)
    - **Place Order** — advisory-locked, recalculates totals from the cart's `line_total`s, adds delivery charge only for delivery orders, inserts one snapshotted row into `orders`, and only clears the cart / marks the session `placed` if an order was actually created (guards on non-empty cart, valid order type, and complete delivery info)
    - **Cancel Order** — clears cart/order-type/delivery fields only while the session is still `draft`; reports `cancelled=false` if an order was already placed
    - **Escalate To Human** — sets `awaiting_human = TRUE` on the session
    - **Notify Admin** — WhatsApp message to staff, used for both kitchen tickets and escalations
    - **Send Menu Image 1 / Send Menu Image 2** — sends the two menu photos (hosted on Vercel); the agent checks recent history first to avoid resending
11. **Reply Text** — extracts the agent's final plain-text reply
12. **Send message** — the single shared WhatsApp send node for all customer-facing replies
13. **Persist Conversation Turn** — appends the customer message + bot reply to `recent_messages`, trimmed to roughly the last 6 exchanges

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

## Security

- Keep the repository private during client development.
- Store secrets only in n8n credentials or secure environment variables.
- Do not commit exported credentials, production database dumps, customer phone numbers, or conversations.
- Verify incoming Meta webhook signatures before production use.
- Use parameterized SQL queries for all customer-provided values (followed throughout — every Postgres node uses query parameters, not string-concatenated input).

## Current limitations

- Meta's test number is intended for development and demonstrations; production onboarding is still needed before using the restaurant's real WhatsApp number.
- Free service tiers have rate and usage limits.
- AI output must always be validated against the restaurant database — enforced in SQL at cart-update, order-placement, and cancellation time, not just in the agent's instructions.
- Order status is currently binary in practice (`draft` → `placed`); there's no flow yet for advancing an order through preparing/out-for-delivery/completed.
- Testing so far has used a single test customer/phone number; multi-customer and concurrent-session behavior is untested.
- Full multilingual (English/Urdu/Roman Urdu) end-to-end regression testing is still outstanding.

## Next steps

1. Add order-status update handling (preparing → out_for_delivery → completed / cancelled-by-staff).
2. Test with multiple concurrent customers/sessions to confirm no cross-talk or race conditions beyond the existing `Place Order` advisory lock.
3. End-to-end test in English, Urdu, and Roman Urdu, including deal-component selection and menu-photo requests.
4. Complete Meta production onboarding and move off the test number.

## License

This repository is private and intended for development with the restaurant client. Add a formal license before publishing or distributing the project.
