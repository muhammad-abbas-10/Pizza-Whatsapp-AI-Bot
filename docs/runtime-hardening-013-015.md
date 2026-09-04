# Runtime hardening, deployment, and migration order

## Implemented behavior

- The native n8n WhatsApp Trigger verifies Meta's `x-hub-signature-256` HMAC using its credential's **Client Secret** and the raw webhook body. No hand-written crypto or workflow variable is used.
- Status-only webhook payloads stop before configuration, database, session, or AI nodes. Unsupported message types receive one deterministic text-only guidance reply and do not enter buffering or the agent.
- `ADMIN_WHATSAPP_PHONE` and `WHATSAPP_PHONE_NUMBER_ID` are required n8n Variables. There are no hardcoded fallback identifiers. Missing configuration is logged internally and sends nothing.
- Dashboard/Express and n8n use the same atomic two-minute `admin_requests` notification lease. The resolver changes business state; a separate claimant owns delivery.
- Customer reply text and `replied_at` are stored immediately after a successful WhatsApp send. A reclaimed exact batch that was already sent bypasses Gemini and WhatsApp and only finalizes database state.
- Active order status is joined directly from `orders`. Placed delivery details can be corrected only in `received` or `preparing` state.
- Cart deal choices and all placed cart lines are revalidated against active menu records. Invalid lines prevent order placement and are returned as `invalid_items`.
- Human escalation creates a durable `admin_notifications` dashboard record even when admin WhatsApp delivery is unavailable.

## Required n8n configuration

1. Set n8n Variables `ADMIN_WHATSAPP_PHONE` and `WHATSAPP_PHONE_NUMBER_ID`.
2. Open the **WhatsApp Trigger** credential and set the Meta App Client ID and **Client Secret**.
3. Re-select the Postgres, WhatsApp API, WhatsApp Trigger, and Gemini credentials after import if credential IDs differ.
4. Import `admin request.json`. It is deliberately inactive; deactivate the previous production workflow before activating this one.

The requested `WHATSAPP_APP_SECRET` role is fulfilled by the native credential's **Client Secret** field. This installed trigger does not consume `$vars.WHATSAPP_APP_SECRET`, so documenting it as a workflow Variable would create a false security signal.

## Changed workflow nodes

- Entry/routing: `WhatsApp Trigger`, `Normalize Incoming Message`, `Has Message`, `Workflow Configuration`, `Configuration Present`, `Is Supported Text Message`, `Unsupported Message Reply`, and the dedicated `Send Unsupported Message` node. A separate send node is intentional because the normal `Send message` node continues into buffer finalization, which unsupported messages must not enter.
- Customer delivery: `Claim Latest Customer Turn`, `Reply Already Sent For This Batch`, `Restore Stored Reply`, `Pizza Ordering Agent`, `Agent Output Valid`, `Agent Fallback Reply`, `Reply Text`, `Send message`, `Record Reply Sent`, and `Finalize Customer Turn`.
- Ordering tools: `Upsert Customer and Session`, `Update Cart`, `Place Order`, `Update Placed Order Delivery Info`, and `Escalate To Human`.
- Admin resolution: `Resolve Admin Request`, `Customer Notification Required`, `Claim Customer Notification`, `Notification Claimed`, `Send Admin Decision to Customer`, and `Record Customer Decision Notification`.

## Database changes

- `013_menu_v2.sql`: renamed canonical v2 menu seed with an explicit destructive/non-idempotent warning; seed content and prices are unchanged.
- `014_drop_legacy_menu_schema.sql`: optional legacy-table removal, created only after the workflow/backend reference search returned no matches.
- `015_reply_idempotency.sql`: adds `message_buffer.reply_text`, `message_buffer.replied_at`, and the recovery index.

## Security changes

- Native raw-body HMAC verification is documented on the trigger and in deployment instructions.
- Embedded admin phone and WhatsApp phone-number-id fallbacks were removed; missing required configuration stops internally without exposing details to users.

## Idempotency and concurrency changes

- Express and n8n share the same parameterized two-minute notification claim SQL, with claim-token-guarded completion.
- A successful customer send is marked before finalization; recovery recognizes the exact stored reply and bypasses both Gemini and WhatsApp sending.

## Migration order

For a brand-new database, review and apply `001` through `012` in numeric order. Then choose the menu path deliberately:

- `013_menu_v2.sql` is destructive and non-idempotent. It drops/recreates the canonical menu schema and reseeds menu data. Run it manually only for a new/reset menu database or after backing up live menu edits.
- `014_drop_legacy_menu_schema.sql` drops only `menu_categories`, `menu_items`, `menu_variants`, and `menu_extras`. Apply it only after confirming no deployed runtime still references those legacy tables.
- `015_reply_idempotency.sql` is required by the upgraded workflow. It adds reply-delivery state and its recovery index. It is safe to re-run.

For this existing Neon database, migrations `011` and `012` were already present and `015` was applied and re-run successfully. `013` and `014` were intentionally not applied automatically because they are destructive.

Useful commands from `backend/`:

```text
npm run migrate:workflow-runtime
npm run migrate:drop-legacy-menu
npm run migrate:reply-idempotency
```

## Dual admin-decision paths

Dashboard buttons and WhatsApp admin commands both resolve the same `admin_requests` rows. Both paths may attempt notification, but only the caller that obtains the shared PostgreSQL lease sends the customer message. A successful send sets `notification_sent`; subsequent Express or n8n claims return no row and do not send again.

WhatsApp admin commands remain deterministic: `APPROVE <request_id> [note]` or `DENY <request_id> [reason]`. They never enter customer buffering or Gemini.

## Reply recovery invariant

The send sequence is `Send message -> Record Reply Sent -> Finalize Customer Turn`. If the process fails after delivery but before finalization, the stale batch can be reclaimed. When every row in that exact batch has the stored reply marker, the recovery branch skips AI generation and skips WhatsApp sending, then finalizes the buffered rows with the stored reply. This deliberately avoids the duplicate-send path implied by routing recovery back through the send node.

## Verification commands

```text
npm run test:workflow-cart
npm run test:workflow-runtime
npm run test:workflow-order-safety
npm run test:notification-claim
npm run test:workflow-cancellation
npm test
```

## Tests performed

- `backend/npm test` — passed syntax checks for the server, API entry point, and shared admin routes.
- `frontend/npm test` — passed syntax checks for the frontend entry point, API client, and utilities.
- `npm run test:workflow-cart` — passed the 12 cart scenarios, `$1`/`$2` bindings, merge semantics, invalid IDs, and selectable deal-rule rejection.
- `npm run test:workflow-runtime` — passed graph separation, native-signature documentation, required configuration, admin resolution/claiming, reply-marker recovery, and SQL scenarios.
- `npm run test:workflow-order-safety` — passed active status, live cart-line validation, `invalid_items`, placed-address state guard, and durable escalation checks.
- `npm run test:notification-claim` — passed concurrent Express delivery and confirmed a following n8n-equivalent claim returns no row/no second send.
- `npm run test:workflow-cancellation` — passed placement/cancellation linkage, ambiguity, duplicate request reuse, and invalid-order guards after live cart validation.
- `015_reply_idempotency.sql` — applied and re-run successfully against the configured Neon database.

The repository cannot import or activate the cloud n8n workflow, inspect the cloud credential secret value, or perform a real Meta delivery from this local verification. Those remain deployment smoke tests; the export remains `active: false`.
