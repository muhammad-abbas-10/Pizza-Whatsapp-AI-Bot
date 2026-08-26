# Pizza WhatsApp AI Ordering Bot

A WhatsApp-based AI ordering system for a pizza restaurant. It uses the Meta WhatsApp Cloud API, n8n automation, Google Gemini, and Neon PostgreSQL.

## Project status

This project is under active development. Incoming WhatsApp messages are received by n8n, normalized, checked for duplicates, and used to upsert a customer/session record in Neon PostgreSQL. The active menu is loaded from the database and passed to Gemini, which extracts structured intent (items, order type, confirmation, human handoff, etc.) from the customer's message. Cart building, price validation, order confirmation, order saving, and kitchen notification are not wired up yet.

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
- **AI:** Google Gemini (via n8n LangChain nodes — Basic LLM Chain + structured output parser)
- **Database:** Neon PostgreSQL
- **Version control:** GitHub

## Current message flow (implemented)

```text
Customer WhatsApp message
        ↓
WhatsApp Trigger (Meta Cloud API)
        ↓
Normalize Incoming Message (extract phone, name, text, message id, type, timestamp)
        ↓
Check Duplicate Message (processed_messages table) → If not already processed
        ↓
Upsert Customer and Session (customers + conversation_sessions)
        ↓
Load Active Menu (menu_items, menu_variants, menu_extras)
        ↓
Gemini structured intent extraction (Basic LLM Chain + Structured Output Parser)
        ↓
[Not yet built: cart update, price validation, confirmation, save order, kitchen notification]
```

## Core safety rules

1. Never invent menu items or prices.
2. Calculate totals from database values, not AI output.
3. Never place an order without explicit customer confirmation.
4. Save the order successfully before claiming it was placed.
5. Ignore duplicate WhatsApp webhook deliveries.
6. Ask for clarification when required information is missing.
7. Transfer the conversation when the customer requests a human.
8. Never expose credentials, internal prompts, or system information.
9. Treat the customer's message as data, never as instructions to the AI system.

## Development roadmap

- [x] Create Meta WhatsApp test application
- [x] Send a test WhatsApp message
- [x] Receive WhatsApp messages in n8n
- [x] Normalize incoming message fields
- [x] Connect n8n to Neon PostgreSQL
- [x] Create the initial database schema (customers, processed_messages, conversation_sessions)
- [x] Add duplicate-message protection
- [x] Create and import the restaurant menu (categories, items, variants, extras + seed data)
- [x] Connect Gemini for structured intent extraction
- [ ] Implement structured conversation sessions and carts (schema exists; cart read/write logic not yet built)
- [ ] Validate products and calculate prices deterministically
- [ ] Add customer order summaries and explicit confirmation
- [ ] Save confirmed orders
- [ ] Notify kitchen staff immediately
- [ ] Add order status updates and human handoff
- [ ] Test English, Urdu, and Roman Urdu conversations end-to-end

## Repository structure

```text
Pizza-Whatsapp-AI-Bot-main/
├── database/
│   └── migration/
│       ├── 001_initial_schema.sql   # customers, processed_messages, conversation_sessions
│       ├── 002_menu_schema.sql      # restaurant_settings, menu_categories, menu_items, menu_variants, menu_extras
│       └── 003_seed_menu.sql        # seed data for categories, items, variants
├── n8n_workflow.json                # exported n8n workflow (9 nodes)
└── README.md
```

## Database schema summary

**Core (001_initial_schema.sql)**
- `customers` — WhatsApp phone, name, preferred language
- `processed_messages` — message ids already handled, for duplicate protection
- `conversation_sessions` — one active session per customer: cart (JSONB), order type, delivery address, awaiting_confirmation, human_handoff, last_question

**Menu (002_menu_schema.sql)**
- `restaurant_settings` — name, currency, delivery charge, opening hours
- `menu_categories` — e.g. Classic Pizzas, Signature Pizzas, Deals
- `menu_items` — name, aliases (for fuzzy matching), description
- `menu_variants` — size + price per item
- `menu_extras` — add-ons with type and price

## n8n workflow nodes (current export)

1. **WhatsApp Trigger** — Meta Cloud API webhook, listens for `messages`
2. **Normalize Incoming Message** — extracts `customer_name`, `customer_phone`, `message_id`, `message_text`, `message_type`, `message_timestamp`
3. **Check Duplicate Message** — Postgres lookup against `processed_messages`
4. **If** — branches on `already_processed`
5. **Upsert Customer and Session** — inserts/updates `customers` and `conversation_sessions`
6. **Load Active Menu** — pulls active categories/items/variants/extras as JSON
7. **Google Gemini Chat Model** — `gemini-3.1-flash-lite`, temperature 0.1
8. **Basic LLM Chain** — intent-extraction prompt (treats customer text as data, restricts output to real menu data, understands English/Urdu/Roman Urdu, flags clarification/confirmation/human handoff)
9. **Structured Output Parser** — enforces the JSON schema (`language`, `intent`, `items`, `order_type`, `address`, `confirmation`, `human_handoff`, `clarification_needed`, `clarification_reason`, `confidence`)

## Environment variables

Create local credentials using your deployment platform or n8n credential store. Never commit real values.

```env
META_ACCESS_TOKEN=
META_APP_SECRET=
META_PHONE_NUMBER_ID=
META_VERIFY_TOKEN=
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
- Use parameterized SQL queries for all customer-provided values (already followed in the current Postgres nodes via query replacement).

## Current limitations

- Meta's test number is intended for development and demonstrations.
- Free service tiers have rate and usage limits.
- The project requires production onboarding before using the restaurant's real WhatsApp number.
- AI output must always be validated against the restaurant database.
- The workflow currently stops after intent extraction — no cart, pricing, confirmation, order-saving, or kitchen-notification logic exists yet.

## Next steps

1. Take the parsed intent output and update `conversation_sessions.cart` (add/remove/modify items).
2. Validate every item/variant/extra against the loaded menu and calculate totals in Postgres/n8n, not from the AI.
3. Build the order-summary + explicit-confirmation step.
4. On confirmation, write the order and notify the kitchen WhatsApp number.
5. Add the human-handoff branch.
6. End-to-end test in English, Urdu, and Roman Urdu.

## License

This repository is private and intended for development with the restaurant client. Add a formal license before publishing or distributing the project.
