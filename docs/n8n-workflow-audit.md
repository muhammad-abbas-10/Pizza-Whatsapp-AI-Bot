# n8n customer and dashboard-event workflow audit

## Outcome

`admin request.json` is an importable, inactive workflow named **Pizza WhatsApp - Customer and Dashboard Status Router**. It has two distinct entry points:

- `WhatsApp Trigger` accepts Meta-verified customer messages and runs the ordering/session path.
- `Admin Order Status Webhook` accepts backend-only customer-notification events and runs the authenticated status-message path.

No admin WhatsApp input, output, command parser, kitchen alert, or fallback remains.

## Customer path retained

The existing runtime-hardening behavior is preserved:

1. Normalize Meta data and stop status receipts/non-message payloads.
2. Insert the Meta message ID into the durable buffer.
3. Debounce rapid messages and serialize one active turn per phone.
4. Recover already-sent replies without repeating WhatsApp delivery.
5. Upsert customer/session data, load focused menu data, and run the ordering agent.
6. Revalidate and reprice carts/orders in PostgreSQL.
7. Send the customer reply and finalize buffer/message-id state.

Order placement still occurs inside the `Place Order` statement. The agent may claim success only after `order_created=true`; the database trigger creates the dashboard's new-order record. The agent no longer calls an admin-alert tool.

`Request Cancellation Approval` now creates/reuses a linked `admin_requests` row and returns `dashboard_request_visible`. Eligibility calls the database's `order_is_cancellable` function. It never constructs an `APPROVE`/`DENY` command or messages staff.

## Dashboard-event path

1. `Admin Order Status Webhook` receives only `event_id` and `request_id` from the backend.
2. `Authenticate Admin Status Webhook` compares `x-n8n-admin-secret` with the private n8n variable and validates the structured source/event fields.
3. Unauthorized requests return 401 before any database or messaging node.
4. `Claim Admin Customer Event` joins the event to its authoritative order/customer/session and obtains the customer phone from PostgreSQL. It atomically claims pending/failed events, recovers stale processing leases, and returns duplicates without sending.
5. If an order has already advanced past the event, the event becomes `superseded`; stale wording is not sent.
6. `Admin Customer Message Agent` receives explicit `source=admin_dashboard` context and can call no ordering tools.
7. `Build Safe Admin Customer Message` enforces the order ID, length, no internal details, and no contradictory English, Roman Urdu, or Urdu status meaning. It supplies deterministic language-matched fallback wording if AI output is unsafe/unavailable.
8. `Send Admin Status to Customer` targets only the database-loaded customer phone.
9. `Record Admin Event Result` stores `sent`/`failed`, attempt count, provider message ID/error, and clears the claim.
10. The webhook returns `unauthorized`, `not_found`, `processing`, `duplicate`, `superseded`, `sent`, or `failed` lifecycle data.

## Removed workflow nodes

- `Is Authorized Admin`
- `Claim Admin Message`
- `Admin Message Claimed`
- `Parse Admin Command`
- `Admin Command Valid`
- `Resolve Admin Request`
- `Customer Notification Required`
- `Claim Customer Notification`
- `Notification Claimed`
- `Send Admin Decision to Customer`
- `Record Customer Decision Notification`
- `Build Admin Decision Reply`
- `Build Admin Help Reply`
- `Send Admin Reply`
- `Finalize Admin Message`
- `Notify Admin`

Their database responsibilities now live in the authenticated backend transaction and persistent event table. `admin_message_claims` remains only as legacy audit schema; no live graph references it.

## Added workflow nodes

- `Admin Order Status Webhook`
- `Authenticate Admin Status Webhook`
- `Admin Webhook Authorized`
- `Reject Admin Status Webhook`
- `Claim Admin Customer Event`
- `Admin Event Claimed`
- `Respond Admin Event Not Claimed`
- `Admin Customer Message Agent`
- `Build Safe Admin Customer Message`
- `Send Admin Status to Customer`
- `Record Admin Event Result`
- `Respond Admin Event Processed`

## Security invariants

- The browser has no n8n URL secret, Meta token, WhatsApp credential, or direct WhatsApp link.
- The n8n secret exists only in backend environment configuration and the n8n Variables store.
- The event's composite foreign key enforces that its customer owns its order.
- n8n ignores any browser/customer phone even if a caller invents one; no phone is present in the backend payload.
- Admin-event AI cannot create orders, change status, mutate carts, create requests, or ask staff questions.
- Invalid secrets and wrong event/order/customer relationships result in no WhatsApp send.

## Verification

The automated architecture test parses every node/edge, verifies entry-path isolation, asserts all legacy admin nodes/strings are absent, executes webhook authentication and multilingual factual-message guards, checks backend/frontend secret boundaries, and exercises dispatcher failure/duplicate behavior. The rollback-only database test validates migration `016`, including Oven, the transition/cancellation functions, history provenance, new-order notification trigger, ownership foreign key, concurrent stale actions, visible delivery failures, retry, and duplicate suppression.

The exported workflow must still be imported, credential bindings confirmed, and smoke-tested in the target n8n/Meta deployment. Local repository tests cannot activate a cloud workflow or prove a real provider delivery.
