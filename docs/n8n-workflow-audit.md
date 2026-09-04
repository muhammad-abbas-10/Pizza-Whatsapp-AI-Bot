# n8n WhatsApp workflow audit and production upgrade

> Update: the later FIX 1–12 hardening pass is documented in
> `docs/runtime-hardening-013-015.md`. Where this earlier audit describes
> fallback identifiers, resolution-time notification ownership, ignored media,
> or incomplete deal-component validation, the newer document and workflow
> are authoritative.

## Outcome

`admin request.json` is now an importable, inactive-by-default workflow named **Pizza WhatsApp - Customer and Admin Router**. It preserves the existing customer ordering agent and tools, but places deterministic routing, durable duplicate handling, customer-turn serialization, and a non-AI admin decision handler in front of them.

Migration `012_n8n_workflow_runtime_hardening.sql` has been applied to the configured Neon database. The exported workflow itself contains no DDL.

## Source-of-truth data model

- `customers`: normalized WhatsApp phone, display name, optional preferred language.
- `conversation_sessions`: cart, order type, delivery fields, recent messages, pending items, active order, and handoff/order state.
- `restaurant_menu_items`, `restaurant_menu_variants`, `restaurant_deals`, `restaurant_deal_components`, `restaurant_menu_rules`: live menu and deal source of truth. `active_restaurant_menu_for_ai` is the read model supplied to Gemini.
- `orders`: immutable item snapshot and totals at placement plus the operational order status.
- `admin_requests`: structured customer requests. A cancellation request links one customer and one order and moves from `pending` to `approved` or `denied`.
- `message_buffer`: customer webhook acceptance, burst buffering, batch lease, and completion state keyed by Meta message id.
- `processed_messages`: final deduplication ledger, written after a workflow path succeeds.
- `admin_message_claims`: admin webhook lease/finalization ledger. Admin messages are not customers and never create customer/session rows.
- `admin_notifications`, `order_status_history`: dashboard notification and order-status audit data.

## Critical findings in the previous export

1. **No admin route:** every sender entered the customer buffer and Gemini agent. An admin reply such as `APPROVE 27` could not deterministically update request 27.
2. **Duplicate check result was ignored:** `Check Duplicate Message` selected `already_processed`, but its only connection always continued to the buffer.
3. **No final processed-message write:** the visible success path never inserted the inbound Meta id into `processed_messages`.
4. **Premature acknowledgement:** `Combine and Mark Processed` set buffer rows to processed before customer/session loading, AI execution, WhatsApp delivery, and history persistence. A later failure could permanently lose accepted messages.
5. **Race between customer turns:** latest-message selection did not prevent a new customer turn from reaching the same session while an earlier Gemini/tool execution was still running.
6. **Schema drift in the live path:** `Ensure Schema` ran DDL for every webhook and did not represent all later migrations.
7. **README/export drift:** documentation described message and duplicate IF nodes that were absent from the exported graph.
8. **Unsafe legacy backlog:** Neon contained 352 `processed = FALSE` buffer rows without Meta message ids. Replaying them was unsafe; leaving them selectable would append old text to a future customer turn.
9. **Admin notification race:** even after atomic request resolution, two different admin messages could both attempt the customer notification unless dispatch ownership was leased.
10. **Combined-turn history mismatch:** Gemini's main prompt used the combined text, while one context line and persisted history used only the final raw message.

## Corrected routing contract

### Common entry

1. Normalize fields safely and strip non-digits from the sender phone.
2. Stop non-text/status payloads before database writes.
3. Load `ADMIN_WHATSAPP_PHONE` and `WHATSAPP_PHONE_NUMBER_ID` from n8n Variables. The export retains the previously configured values only as import-safe fallbacks.
4. Compare normalized sender digits exactly.

### Customer path

1. Insert the Meta id and text into `message_buffer`; reject ids already finalized or actively accepted.
2. Wait seven seconds.
3. Under a per-phone PostgreSQL advisory lock, only the newest waiter may claim all available messages as one batch.
4. If another batch for that phone is active, wait ten seconds and retry. A five-minute lease allows recovery after a crashed execution.
5. Run the unchanged customer/session, menu, Gemini, cart, order, cancellation-request, handoff, admin-alert, and menu-image tools.
6. Send the customer reply.
7. In one SQL statement, persist the combined customer/bot turn, mark every batch row processed, and insert every Meta id into `processed_messages`.

### Admin path

1. Claim the admin Meta id in `admin_message_claims`.
2. Parse commands with code, not Gemini. Accepted forms are:
   - `APPROVE <request_id> [optional note]`
   - `DENY <request_id> [optional reason]`
3. Invalid text receives a deterministic usage reply and never enters the customer path.
4. `Resolve Admin Request` locks the request and linked order, validates ownership/type/status, updates the order only for a valid approval, updates the request and session, records resolution provenance, and claims customer-notification ownership in one atomic SQL statement.
5. Only the command owning the notification lease may message the affected customer. Successful delivery is recorded in `admin_requests` before acknowledging the admin.
6. Duplicate/resolved/missing/non-cancellable requests return precise idempotent admin replies without repeating database side effects.
7. The inbound admin id is finalized in `processed_messages` after the admin acknowledgement succeeds.

## Changed workflow nodes

Removed/replaced:

- `Ensure Schema`
- `Check Duplicate Message`
- generic unnamed `If`
- `Check If Latest`
- `Combine and Mark Processed`
- `Persist Conversation Turn` (replaced by `Finalize Customer Turn`)

Added or materially changed:

- `Normalize Incoming Message`
- `Is Supported Text Message`
- `Workflow Configuration`
- `Is Authorized Admin`
- `Insert Message to Buffer`
- `Customer Message Accepted`
- `Debounce Customer Messages`
- `Claim Latest Customer Turn`
- `Customer Turn Ready`
- `Customer Turn Busy`
- `Wait For Active Customer Turn`
- `Finalize Customer Turn`
- `Claim Admin Message`
- `Admin Message Claimed`
- `Parse Admin Command`
- `Admin Command Valid`
- `Resolve Admin Request`
- `Customer Notification Required`
- `Send Admin Decision to Customer`
- `Record Customer Decision Notification`
- `Build Admin Decision Reply`
- `Build Admin Help Reply`
- `Send Admin Reply`
- `Finalize Admin Message`
- `Request Cancellation Approval` now returns a deterministic actionable `admin_message`.
- `Notify Admin` must send that cancellation message verbatim.
- WhatsApp send nodes read the configured phone-number id.
- Customer upsert no longer erases an existing name when Meta supplies an empty profile name.

## Database changes

Migration `012` adds:

- Meta id/type, batch lease, and processed timestamp columns to `message_buffer`.
- A partial unique index on non-null message ids and a pending-turn queue index.
- `admin_message_claims` and its status index.
- `resolved_by_phone` and `resolved_by_message_id` audit fields on `admin_requests`.
- Notification claim token/timestamp fields and an index for unsent claimed notifications.
- A one-time retirement of legacy pending buffer rows that had no Meta id. Rows remain stored for audit; they were not deleted.

## Tests performed

All database tests run against the configured Neon schema inside transactions that are rolled back.

- Workflow JSON parsing, node references, no live DDL, and strict separation of admin/customer reachability: pass.
- Admin parser: approve, deny, optional notes, and invalid conversational text: pass.
- Customer duplicate before processing and after finalization: pass.
- Two-message rapid burst, older waiter superseded, ordered newline combination: pass.
- New message while another customer turn is active waits; after finalization it becomes a separate turn: pass.
- Customer history/buffer/processed-id finalization: pass.
- Admin claim and duplicate webhook suppression: pass.
- Admin route creates no customer row: pass.
- Approval atomically cancels the linked active order and resolves the request: pass.
- Repeated approval makes no duplicate update and cannot steal the notification lease: pass.
- Denial resolves the request and leaves the order unchanged: pass.
- Missing request and completed/non-cancellable order: safe precise outcome, no customer notification: pass.
- Customer notification recording and repeat suppression: pass.
- Existing cart scenarios 1-12, deal configuration matching, decrement/removal, invalid ids, and `$1`/`$2` n8n bindings: pass.
- Existing cancellation-request creation, order linkage, ambiguity, invalid order, duplicate reuse, and actionable admin command text: pass.
- Backend and frontend syntax suites: pass.
- Migration re-run/idempotency and live schema check: pass. Unsafe legacy pending count after migration: zero.

## Import and activation

1. Keep the current cloud workflow active while reviewing the imported copy.
2. In n8n, import `admin request.json`.
3. Configure n8n Variables `ADMIN_WHATSAPP_PHONE` (international digits) and `WHATSAPP_PHONE_NUMBER_ID`.
4. Re-select credentials if credential ids differ on the target instance: Postgres, WhatsApp Trigger, WhatsApp API, and Gemini.
5. Confirm every node is valid, then deactivate the old workflow before activating the imported workflow so Meta has one active consumer.
6. Test an invalid admin sentence, a customer burst, and a real disposable pending cancellation request.

The export is intentionally `active: false` to prevent duplicate webhook consumers during import.

## Remaining limits

- The upgraded file has not been imported into the user's n8n Cloud instance from this workspace, so cloud credential resolution and real WhatsApp delivery still need the activation smoke test above.
- PostgreSQL leasing prevents normal duplicate sends across Express and n8n. No database can atomically commit Meta's remote delivery and local state; the new reply marker closes the recoverable customer-turn crash window, while a process crash after provider acceptance but before the marker remains an unavoidable external-system boundary.
- Deal `selected_components` are canonicalized and fully validated against selectable component groups, active choices, sizes, and `allowed_item_rule`; existing invalid configured deal lines are removed by the next cart validation and cannot be placed.
- Non-text messages receive a deterministic text-only guidance reply without buffering, session creation, or AI processing. Actual media understanding remains out of scope.
- Admin decision replies use `customers.preferred_language` when populated; otherwise they default to English. The customer Gemini path continues to mirror English, Urdu, or Roman Urdu from the conversation.
