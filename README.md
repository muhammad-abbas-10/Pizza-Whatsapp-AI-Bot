# Pizza WhatsApp AI Ordering Bot

A WhatsApp-based AI ordering system for a pizza restaurant. It uses the official Meta WhatsApp Cloud API, n8n automation, Gemini AI, and Neon PostgreSQL.

## Project status

This project is under active development. The Meta test number can currently send incoming WhatsApp messages to an n8n workflow, and n8n is connected to Neon PostgreSQL.

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
- **AI:** Google Gemini API
- **Database:** Neon PostgreSQL
- **Version control:** GitHub

## Planned message flow

```text
Customer WhatsApp message
        ↓
Meta WhatsApp Cloud API
        ↓
n8n WhatsApp workflow
        ↓
Message validation and duplicate protection
        ↓
Customer, menu, and conversation state from Neon
        ↓
Gemini structured intent extraction
        ↓
Deterministic cart and pricing validation
        ↓
Customer confirmation
        ↓
Save order in Neon
        ↓
Notify kitchen worker immediately
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

## Development roadmap

- [x] Create Meta WhatsApp test application
- [x] Send a test WhatsApp message
- [x] Receive WhatsApp messages in n8n
- [x] Normalize incoming message fields
- [x] Connect n8n to Neon PostgreSQL
- [ ] Create the initial database schema
- [ ] Add duplicate-message protection
- [ ] Create and import the restaurant menu
- [ ] Implement structured conversation sessions and carts
- [ ] Connect Gemini for structured intent extraction
- [ ] Validate products and calculate prices deterministically
- [ ] Add customer order summaries and explicit confirmation
- [ ] Save confirmed orders
- [ ] Notify kitchen staff immediately
- [ ] Add order status updates and human handoff
- [ ] Test English, Urdu, and Roman Urdu conversations

## Repository structure

```text
pizza-whatsapp-ai-bot/
├── database/
│   ├── migrations/
│   └── seeds/
├── n8n/
│   └── workflows/
├── docs/
├── tests/
├── .env.example
├── .gitignore
└── README.md
```

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
- Use parameterized SQL queries for all customer-provided values.

## Current limitations

- Meta's test number is intended for development and demonstrations.
- Free service tiers have rate and usage limits.
- The project requires production onboarding before using the restaurant's real WhatsApp number.
- AI output must always be validated against the restaurant database.

## License

This repository is private and intended for development with the restaurant client. Add a formal license before publishing or distributing the project.
