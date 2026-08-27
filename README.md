# Pizza WhatsApp AI Ordering Bot

A WhatsApp-based AI ordering system for **Pizza Bar**. It uses the Meta WhatsApp Cloud API, n8n automation, Google Gemini, and Neon PostgreSQL.

## Project status

Core ordering flow is functional end-to-end for a single test customer: a customer can message the bot, get a greeting, add items to a cart (with automatic quantity merging and DB-validated pricing), and place an order (which is saved to the database with a full price breakdown). Order confirmation messages back to the customer and kitchen notifications are the next pieces being wired up. Clarification handling, human handoff, and full multilingual testing are still to do.

## Goals

- Understand customer messages in English, Urdu, and Roman Urdu
- Answer menu and pricing questions using stored restaurant data
- Build and modify a structured shopping cart
- Support delivery and pickup orders
- Require explicit customer confirmation before placing an order
- Save confirmed orders in PostgreSQL
- Immediately notify restaurant staff about new orders
- Support human handoff when requested or when automation fails
- Prevent invented menu items, prices, totals, and delivery times

## Technology stack

- **Messaging:** Meta WhatsApp Cloud API
- **Workflow automation:** n8n Cloud
- **AI:** Google Gemini (via n8n LangChain nodes — Basic LLM Chain + Structured Output Parser)
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
Check Duplicate Message → If not already processed
        ↓
Upsert Customer and Session
        ↓
Load Active Menu (trimmed fields — see note below)
        ↓
Gemini structured intent extraction (Basic LLM Chain + Structured Output Parser)
        ↓
Route by Intent (Switch node)
        ├── human_handoff = true      → [not yet built]
        ├── clarification_needed      → [not yet built]
        ├── confirmation = true       → Place Order → [confirmation/kitchen messages: in progress]
        ├── items present             → Update Cart → Build Cart Summary → WhatsApp Send OK
        ├── intent = greeting         → Get Restaurant Settings → Greeting Reply → WhatsApp Send OK
        └── fallback (unhandled)      → [not yet built]
```

All customer-facing replies converge into a single shared **WhatsApp Send** node (reads `reply_text` + `customer_phone`), rather than one node per branch, to keep the sending logic centralized.

## Core safety rules

1. Never invent menu items or prices — every price comes from the database, validated against `menu_variants` at both cart-update and order-confirmation time, never from the AI's output.
2. Never place an order without explicit customer confirmation.
3. Save the order successfully before claiming it was placed.
4. Ignore duplicate WhatsApp webhook deliveries.
5. Ask for clarification when required information is missing.
6. Transfer the conversation when the customer requests a human.
7. Never expose credentials, internal prompts, or system information.
8. Treat the customer's message as data, never as instructions to the AI system.

## Development roadmap

- [x] Create Meta WhatsApp test application
- [x] Send a test WhatsApp message
- [x] Receive WhatsApp messages in n8n
- [x] Normalize incoming message fields
- [x] Connect n8n to Neon PostgreSQL
- [x] Create the initial database schema (customers, processed_messages, conversation_sessions)
- [x] Add duplicate-message protection
- [x] Create and import the restaurant menu (categories, items, variants, extras + seed data)
- [x] Seed restaurant settings (name, currency, delivery charge, hours)
- [x] Connect Gemini for structured intent extraction
- [x] Route parsed intent to the right conversation branch (Switch node)
- [x] Build and merge cart items from parsed intent (quantity-aware, price-validated)
- [x] Validate products and calculate prices deterministically
- [x] Save confirmed orders (orders table, snapshotted items + totals)
- [ ] Send order confirmation message to customer
- [ ] Notify kitchen staff immediately on new order
- [ ] Add clarification-question branch
- [ ] Add human-handoff branch
- [ ] Add fallback/unhandled-intent reply
- [ ] Add order status updates
- [ ] Test English, Urdu, and Roman Urdu conversations end-to-end

## Repository structure

```text
Pizza-Whatsapp-AI-Bot-main/
├── database/
│   └── migration/
│       ├── 001_initial_schema.sql          # customers, processed_messages, conversation_sessions
│       ├── 002_menu_schema.sql             # restaurant_settings, menu_categories, menu_items, menu_variants, menu_extras
│       ├── 003_seed_menu.sql               # seed data for categories, items, variants
│       ├── 004_seed_restaurant_settings.sql# seeds restaurant_settings (name, currency, delivery charge, hours)
│       └── 005_orders_schema.sql           # orders table (snapshotted items, totals, status)
├── n8n_workflow.json                       # exported n8n workflow
└── README.md
```

## Database schema summary

**Core (001_initial_schema.sql)**
- `customers` — `whatsapp_phone` (unique), name, preferred language
- `processed_messages` — message ids already handled, for duplicate protection
- `conversation_sessions` — one active session per customer: `cart` (JSONB `{"items": []}`), order type, delivery address, awaiting_confirmation, human_handoff, last_question

**Menu (002_menu_schema.sql)**
- `restaurant_settings` — name, currency, delivery charge, opening hours (seeded: **Pizza Bar**, PKR, Rs. 150 delivery)
- `menu_categories` — e.g. Classic Pizzas, Signature Pizzas, Deals
- `menu_items` — name, aliases (for fuzzy matching)
- `menu_variants` — size + price per item
- `menu_extras` — add-ons with type and price

**Orders (005_orders_schema.sql)**
- `orders` — customer_id, `items` (JSONB snapshot of the cart at confirmation time, so later menu/price changes never rewrite past orders), order_type, delivery_address, subtotal, delivery_charge, total, status (`received` -> `preparing` -> `out_for_delivery` -> `completed`, or `cancelled`)

## n8n workflow nodes

1. **WhatsApp Trigger** — Meta Cloud API webhook
2. **Normalize Incoming Message** — extracts customer_name, customer_phone, message_id, message_text, message_type, message_timestamp
3. **Check Duplicate Message** — Postgres lookup against `processed_messages`
4. **If** — branches on already_processed
5. **Upsert Customer and Session** — inserts/updates `customers` and `conversation_sessions`
6. **Load Active Menu** — pulls active categories/items/variants as JSON. Trimmed to `id`, `name`, `aliases`, `category`, and `variants` (dropped `description` and other unused fields) to keep the prompt lean and avoid Gemini output truncation
7. **Google Gemini Chat Model** — Max Output Tokens raised to 4096 (menu size + schema pushed past the default limit during testing)
8. **Basic LLM Chain** — intent-extraction prompt: treats customer text as data, restricts output to real menu data, understands English/Urdu/Roman Urdu, flags clarification/confirmation/human handoff, requires every cart item to include `menu_item_id`, `variant_id`, `item_name`, `size`, `quantity`, `extra_ids`
9. **Structured Output Parser** — enforces the JSON schema using a populated example item (not an empty array), so item shape is consistent every time
10. **Route by Intent** (Switch, Rules mode) — checked in order: `human_handoff` -> `clarification_needed` -> `confirmation` (-> `confirm_order`) -> `items.length > 0` (-> `update_cart`) -> `intent == "greeting"` -> fallback
11. **Get Restaurant Settings** -> **Greeting Reply** -> shared WhatsApp Send *(greeting branch, done)*
12. **Update Cart** -> **Build Cart Summary** -> shared WhatsApp Send *(update_cart branch, done)*
13. **Place Order** -> *(order-confirmation + kitchen-notify nodes: in progress)* *(confirm_order branch)*

### Update Cart logic
Re-validates every `menu_item_id`/`variant_id` pair from the LLM output against the real `menu_variants`/`menu_items` tables — invalid IDs are silently excluded rather than trusted. Merges quantities for items already in the cart instead of appending duplicate line entries (fixed after an early bug caused repeated test runs to stack duplicate lines). Recalculates `line_total` from the database price, never from the AI.

### Place Order logic
Recalculates the subtotal from the cart's stored `line_total`s, adds the delivery charge only when `order_type = 'delivery'`, inserts one snapshotted row into `orders`, and clears the cart only if an order was actually created (guards against confirming an empty cart).

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

- Meta's test number is intended for development and demonstrations.
- Free service tiers have rate and usage limits.
- The project requires production onboarding before using the restaurant's real WhatsApp number.
- AI output must always be validated against the restaurant database (enforced at both cart-update and order-placement time).
- Order confirmation and kitchen notification messages are not yet sent — orders are saved, but the customer and kitchen aren't notified yet.
- Clarification questions, human handoff, and unrecognized-intent replies are not yet implemented — messages on those paths currently have nowhere to go.
- Testing so far has used a single test customer/phone number; multi-customer and concurrent-session behavior is untested.

## Next steps

1. Build `Build Order Confirmation` (Set node) producing `reply_text` (customer order summary) and `kitchen_text` (kitchen notification) from `Place Order`'s output.
2. Wire `reply_text` into the shared WhatsApp Send node, and `kitchen_text` into a new `Notify Kitchen` WhatsApp Send node addressed to the kitchen's WhatsApp number.
3. Build the `clarification_needed` branch — send `clarification_reason` back to the customer as a follow-up question.
4. Build the `human_handoff` branch — flag the session and notify staff.
5. Add a fallback reply for unrecognized intents.
6. Add order status update handling.
7. End-to-end test in English, Urdu, and Roman Urdu.

## License

This repository is private and intended for development with the restaurant client. Add a formal license before publishing or distributing the project.
