const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const workflowPath = path.resolve(
  __dirname,
  "../..",
  process.argv[2] || "workflow.json"
);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));

function node(name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  if (!found) throw new Error(`Workflow node not found: ${name}`);
  return found;
}

function upsertNode(nextNode) {
  const index = workflow.nodes.findIndex((entry) => entry.name === nextNode.name);
  if (index === -1) workflow.nodes.push(nextNode);
  else workflow.nodes[index] = nextNode;
}

function toolEdge(name) {
  workflow.connections[name] = {
    ai_tool: [[{ node: "Pizza Ordering Agent", type: "ai_tool", index: 0 }]],
  };
}

const upsertSession = node("Upsert Customer and Session");
upsertSession.parameters.query = `WITH customer AS (
  INSERT INTO customers (whatsapp_phone, name, updated_at)
  VALUES ($1, NULLIF(BTRIM($2::text), ''), NOW())
  ON CONFLICT (whatsapp_phone)
  DO UPDATE SET
    name = COALESCE(NULLIF(EXCLUDED.name, ''), customers.name),
    updated_at = NOW()
  RETURNING id, whatsapp_phone, name
),
session AS (
  INSERT INTO conversation_sessions (customer_id)
  SELECT id FROM customer
  ON CONFLICT (customer_id)
  DO UPDATE SET
    cart = CASE
      WHEN conversation_sessions.order_status = 'draft'
       AND COALESCE(conversation_sessions.cart_updated_at, conversation_sessions.updated_at) < NOW() - INTERVAL '4 hours'
        THEN '{"items":[]}'::jsonb
      ELSE conversation_sessions.cart
    END,
    order_type = CASE
      WHEN conversation_sessions.order_status = 'draft'
       AND COALESCE(conversation_sessions.cart_updated_at, conversation_sessions.updated_at) < NOW() - INTERVAL '4 hours'
        THEN NULL
      ELSE conversation_sessions.order_type
    END,
    delivery_address = CASE
      WHEN conversation_sessions.order_status = 'draft'
       AND COALESCE(conversation_sessions.cart_updated_at, conversation_sessions.updated_at) < NOW() - INTERVAL '4 hours'
        THEN NULL
      ELSE conversation_sessions.delivery_address
    END,
    delivery_name = CASE
      WHEN conversation_sessions.order_status = 'draft'
       AND COALESCE(conversation_sessions.cart_updated_at, conversation_sessions.updated_at) < NOW() - INTERVAL '4 hours'
        THEN NULL
      ELSE conversation_sessions.delivery_name
    END,
    pending_items = CASE
      WHEN conversation_sessions.order_status = 'draft'
       AND COALESCE(conversation_sessions.cart_updated_at, conversation_sessions.updated_at) < NOW() - INTERVAL '4 hours'
        THEN '[]'::jsonb
      ELSE conversation_sessions.pending_items
    END,
    awaiting_confirmation = CASE
      WHEN conversation_sessions.order_status = 'draft'
       AND COALESCE(conversation_sessions.cart_updated_at, conversation_sessions.updated_at) < NOW() - INTERVAL '4 hours'
        THEN FALSE
      ELSE conversation_sessions.awaiting_confirmation
    END,
    active_order_id = CASE
      WHEN conversation_sessions.order_status = 'draft'
       AND (
         COALESCE(conversation_sessions.cart_updated_at, conversation_sessions.updated_at) < NOW() - INTERVAL '4 hours'
         OR EXISTS (
           SELECT 1 FROM orders active_order
           WHERE active_order.id = conversation_sessions.active_order_id
             AND active_order.status IN ('completed', 'cancelled')
         )
       ) THEN NULL
      ELSE conversation_sessions.active_order_id
    END,
    updated_at = NOW()
  RETURNING *
)
SELECT
  customer.id AS customer_id,
  customer.whatsapp_phone,
  customer.name,
  session.id AS session_id,
  session.cart,
  session.cart_updated_at,
  session.order_type,
  session.delivery_address,
  session.awaiting_confirmation,
  session.awaiting_human,
  session.delivery_name,
  session.recent_messages,
  session.order_status,
  session.active_order_id,
  session.awaiting_feedback_order_id,
  active_order.status AS active_order_status,
  session.pending_items
FROM customer
JOIN session ON session.customer_id = customer.id
LEFT JOIN orders active_order ON active_order.id = session.active_order_id;`;

const menuCart = node("Update Menu Item Cart");
menuCart.parameters.query = menuCart.parameters.query.replace(
  "SET cart = fc.cart, order_status = 'draft', updated_at = NOW()",
  "SET cart = fc.cart, order_status = 'draft', active_order_id = NULL, cart_updated_at = NOW(), updated_at = NOW()"
);
if (!menuCart.parameters.query.includes("active_order_id = NULL, cart_updated_at = NOW()")) {
  throw new Error("Menu cart query was not updated");
}

const dealCart = node("Update Cart");
dealCart.parameters.query = dealCart.parameters.query.replace(
  "      order_status = 'draft',\n      updated_at = NOW()",
  "      order_status = 'draft',\n      active_order_id = NULL,\n      cart_updated_at = NOW(),\n      updated_at = NOW()"
);
if (!dealCart.parameters.query.includes("active_order_id = NULL")) {
  throw new Error("Deal cart query was not updated");
}

const replacePrefixEnd = dealCart.parameters.query.indexOf("existing_items_raw AS");
if (replacePrefixEnd === -1) throw new Error("Could not build Replace Draft Cart validation query");
const replacePrefix = dealCart.parameters.query.slice(0, replacePrefixEnd);
const replaceDraftCartQuery = `${replacePrefix}replacement_items AS (
  SELECT
    line_key, record_type, menu_item_id, variant_id, deal_id,
    MAX(item_name) AS item_name, MAX(category) AS category, MAX(size) AS size,
    SUM(quantity)::int AS quantity, MAX(price) AS price, selected_components
  FROM validated_new_items
  GROUP BY line_key, record_type, menu_item_id, variant_id, deal_id, selected_components
  HAVING SUM(quantity) BETWEEN 1 AND 100
),
input_valid AS (
  SELECT jsonb_array_length(ip.items) > 0
      AND jsonb_array_length(ip.items) = (SELECT COUNT(*) FROM validated_new_items)
      AND (SELECT COUNT(*) FROM replacement_items) > 0 AS valid
  FROM input_payload ip
),
final_items AS (
  SELECT record_type, menu_item_id, variant_id, deal_id, item_name, category, size,
         quantity, price, selected_components, price * quantity AS line_total
  FROM replacement_items
),
updated AS (
  UPDATE conversation_sessions cs
  SET cart = jsonb_build_object(
        'items',
        (SELECT COALESCE(jsonb_agg(to_jsonb(fi) ORDER BY fi.record_type, COALESCE(fi.menu_item_id, fi.deal_id), fi.variant_id, fi.selected_components::text), '[]'::jsonb) FROM final_items fi)
      ),
      order_status = 'draft',
      active_order_id = NULL,
      cart_updated_at = NOW(),
      updated_at = NOW()
  FROM locked_session ls CROSS JOIN input_valid iv
  WHERE cs.id = ls.id AND iv.valid
  RETURNING cs.cart
)
SELECT
  EXISTS (SELECT 1 FROM updated) AS updated,
  CASE WHEN (SELECT valid FROM input_valid) THEN NULL ELSE 'invalid_or_incomplete_replacement_cart' END AS error,
  (SELECT cart FROM updated) AS cart,
  jsonb_array_length(ip.items) AS input_item_count,
  (SELECT COUNT(*)::int FROM replacement_items) AS replacement_item_count
FROM input_payload ip;`;

upsertNode({
  id: "4f7d13a3-7122-4c4a-97c4-a11c0de00001",
  name: "Replace Draft Cart",
  type: "n8n-nodes-base.postgresTool",
  typeVersion: 2.7,
  position: [3040, 720],
  parameters: {
    descriptionType: "manual",
    toolDescription: "Replace the ENTIRE draft cart atomically with the exact intended items. Use this tool when the customer says only, just, instead, no I only want, or otherwise rejects other cart items. The JSON array must include every item the customer wants to keep and nothing else. Use exact live menu/deal IDs, variants, quantities, and required deal selected_components. Trust only updated=true and the returned cart; never say the cart contains only an item unless the returned cart proves it.",
    operation: "executeQuery",
    query: replaceDraftCartQuery,
    options: {
      queryReplacement: "={{ [ $fromAI('items_json', 'JSON array containing the entire intended replacement cart. Include record_type, menu_item_id and variant_id for menu items, or deal_id and selected_components for deals; include positive quantity for every item.', 'string'), $('Upsert Customer and Session').item.json.customer_id ] }}",
    },
  },
  credentials: dealCart.credentials,
});
toolEdge("Replace Draft Cart");

const placeOrder = node("Place Order");
placeOrder.parameters.query = placeOrder.parameters.query
  .replace(
    /delivery_address = NULL, delivery_name = NULL, order_status = 'placed'(?:, cart_updated_at = NOW\(\))*,\s*active_order_id =/,
    "delivery_address = NULL, delivery_name = NULL, order_status = 'placed', cart_updated_at = NOW(),\n    active_order_id ="
  )
  .replace(
    "SELECT (SELECT COUNT(*) FROM new_order) > 0 AS order_created,\n  (SELECT invalid_items FROM invalid) AS invalid_items, no.*\nFROM (SELECT 1) AS one LEFT JOIN new_order no ON TRUE;",
    `SELECT (SELECT COUNT(*) FROM new_order) > 0 AS order_created,
  (SELECT invalid_items FROM invalid) AS invalid_items,
  CASE
    WHEN no.id IS NOT NULL THEN NULL
    WHEN COALESCE(jsonb_array_length(ct.items), 0) = 0 THEN 'cart_empty'
    WHEN cardinality(i.invalid_items) > 0 THEN 'invalid_cart'
    WHEN ct.order_type NOT IN ('delivery', 'pickup') THEN 'order_type_required'
    WHEN ct.order_type = 'delivery' AND NULLIF(TRIM(ct.delivery_name), '') IS NULL THEN 'delivery_name_required'
    WHEN ct.order_type = 'delivery' AND NULLIF(TRIM(ct.delivery_address), '') IS NULL THEN 'delivery_address_required'
    ELSE 'order_not_created'
  END AS checkout_error,
  ct.order_type AS checkout_order_type,
  ct.delivery_name AS checkout_delivery_name,
  ct.delivery_address AS checkout_delivery_address,
  no.*
FROM (SELECT 1) AS one
CROSS JOIN cart_totals ct
CROSS JOIN invalid i
LEFT JOIN new_order no ON TRUE;`
  );
if (!placeOrder.parameters.query.includes("checkout_error")) {
  throw new Error("Place Order query was not updated");
}

const cancelOrder = node("Cancel Order");
cancelOrder.parameters.query = cancelOrder.parameters.query.replace(
  "SET cart = CASE WHEN order_status = 'draft' THEN '{\"items\": []}'::jsonb ELSE cart END,\n    order_type",
  "SET cart = CASE WHEN order_status = 'draft' THEN '{\"items\": []}'::jsonb ELSE cart END,\n    cart_updated_at = CASE WHEN order_status = 'draft' THEN NOW() ELSE cart_updated_at END,\n    active_order_id = CASE WHEN order_status = 'draft' THEN NULL ELSE active_order_id END,\n    order_type"
);

const handoff = node("Escalate To Human");
handoff.parameters.query = `WITH active_order AS (
  SELECT cs.customer_id,
         CASE WHEN o.status NOT IN ('completed', 'cancelled') THEN o.id ELSE NULL END AS order_id
  FROM conversation_sessions cs
  LEFT JOIN orders o ON o.id = cs.active_order_id
  WHERE cs.customer_id = $1::bigint
),
escalated AS (
  UPDATE conversation_sessions
  SET awaiting_human = TRUE, updated_at = NOW()
  WHERE customer_id = $1::bigint
  RETURNING customer_id
),
created AS (
  INSERT INTO admin_requests (customer_id, order_id, request_type, question)
  SELECT e.customer_id, ao.order_id, 'human_handoff',
         COALESCE(NULLIF(BTRIM($2::text), ''), 'Customer requested human assistance.')
  FROM escalated e
  LEFT JOIN active_order ao ON ao.customer_id = e.customer_id
  ON CONFLICT (customer_id) WHERE request_type = 'human_handoff' AND status = 'pending' DO NOTHING
  RETURNING id, customer_id, order_id
),
request_record AS (
  SELECT id, customer_id, order_id FROM created
  UNION ALL
  SELECT r.id, r.customer_id, r.order_id
  FROM admin_requests r
  WHERE r.customer_id = $1::bigint
    AND r.request_type = 'human_handoff'
    AND r.status = 'pending'
  ORDER BY id DESC
  LIMIT 1
),
notified AS (
  INSERT INTO admin_notifications (
    notification_type, title, source_key, request_id, order_id, customer_id, message, created_at
  )
  SELECT 'customer_request', 'Customer handoff #' || rr.id,
         'human_handoff:' || rr.id, rr.id, rr.order_id, rr.customer_id,
         COALESCE(NULLIF(BTRIM($2::text), ''), 'Customer requested human assistance.'), NOW()
  FROM request_record rr
  ON CONFLICT (source_key) DO UPDATE
    SET message = EXCLUDED.message, read_at = NULL
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM escalated) AS awaiting_human,
       (SELECT id FROM request_record) AS request_id,
       EXISTS (SELECT 1 FROM created) AS request_created,
       EXISTS (SELECT 1 FROM request_record) AS dashboard_request_visible,
       (SELECT order_id FROM request_record) AS order_id,
       (SELECT id FROM notified) AS admin_notification_id;`;
handoff.parameters.toolDescription = "Create or reuse one visible Pending Request for a customer complaint or request for staff. Use it for wrong items, delivery problems, complaints, or human assistance. Say the restaurant team will review it only when dashboard_request_visible=true and request_id exists.";

const agent = node("Pizza Ordering Agent");
const reliabilityRules = `
==================================================
11A. FULL-CART REPLACEMENT — CRITICAL
==================================================

When the customer says "only", "just", "instead", "no, I only want", or otherwise rejects other cart items, they are changing the ENTIRE draft cart.

Call Replace Draft Cart exactly once with every item the customer wants to keep and no other items. Do not use Update Menu Item Cart or Update Cart to handle that full-cart replacement.

After the tool returns, the returned cart is authoritative. Never say "only X" unless that returned cart contains exactly X and no extra line. Never proceed to checkout when the replacement result is missing, updated=false, or contains an unexpected item.

==================================================
11B. HISTORIC ORDER IDs ARE NOT NEW ORDERS
==================================================

When SESSION.order_status is draft, SESSION.active_order_id and SESSION.active_order_status may describe a historic order only. They are never proof that the current draft was placed.

Never reuse a historic order number, total, status, delivery name, or address in a new-order response. A new order number exists only in a successful Place Order result.
`;
if (!agent.parameters.options.systemMessage.includes("FULL-CART REPLACEMENT — CRITICAL")) {
  agent.parameters.options.systemMessage = agent.parameters.options.systemMessage.replace(
    "==================================================\n12. DELIVERY / PICKUP",
    `${reliabilityRules}\n==================================================\n12. DELIVERY / PICKUP`
  );
}

const deliveryRule = `
DELIVERY ADDRESS CAPTURE — REQUIRED:

If a delivery request includes a destination, landmark, hostel, campus, area, or address, call Set Delivery Info in that same turn with delivery_address before asking for any missing name. For example, "deliver to Hostel Durrani" must save "Hostel Durrani" as delivery_address, then ask only for the name. Never discard an address supplied with a delivery request.
`;
if (!agent.parameters.options.systemMessage.includes("DELIVERY ADDRESS CAPTURE — REQUIRED")) {
  agent.parameters.options.systemMessage = agent.parameters.options.systemMessage.replace(
    "--------------------------------------------------\n12D. USE EXISTING SESSION DATA",
    `${deliveryRule}\n--------------------------------------------------\n12D. USE EXISTING SESSION DATA`
  );
}

const placementRule = `
PLACE ORDER RESULT — NON-NEGOTIABLE:

Read the Place Order result before writing the reply. Use order_created, checkout_error, id, items, total, delivery_name, delivery_address, and status from that result only.

If order_created is false, never say the order was placed and never mention any order number. For checkout_error=delivery_address_required, ask only for the delivery address. For delivery_name_required, ask only for the name. For order_type_required, ask delivery or pickup. For any other false result, say that the order was not confirmed and show the current cart or ask the missing detail.

If order_created is true, the status returned by the new order is authoritative. A newly-created order is normally received; never call it completed, delivered, preparing, or out for delivery unless the returned status says so.
`;
if (!agent.parameters.options.systemMessage.includes("PLACE ORDER RESULT — NON-NEGOTIABLE")) {
  agent.parameters.options.systemMessage = agent.parameters.options.systemMessage.replace(
    "==================================================\n16. ORDER SUCCESS RESPONSE",
    `${placementRule}\n==================================================\n16. ORDER SUCCESS RESPONSE`
  );
}

const guard = node("Guard Cancellation Reply");
const placementGuard = `

const findToolResult = (value, predicate, depth = 0) => {
  if (depth > 7 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try { return findToolResult(JSON.parse(trimmed), predicate, depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findToolResult(entry, predicate, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (predicate(value)) return value;
  for (const key of ['output', 'data', 'rows', 'result', 'json', 'response']) {
    const found = findToolResult(value[key], predicate, depth + 1);
    if (found) return found;
  }
  return null;
};

const placementStep = steps.find((step) => normalizeToolName(step?.action?.tool) === 'placeorder');
const placementResult = findToolResult(placementStep?.observation, (value) =>
  Object.prototype.hasOwnProperty.call(value, 'order_created')
);
const handoffStep = steps.find((step) => normalizeToolName(step?.action?.tool) === 'escalatetohuman');
const handoffResult = findToolResult(handoffStep?.observation, (value) =>
  Object.prototype.hasOwnProperty.call(value, 'dashboard_request_visible')
  && Object.prototype.hasOwnProperty.call(value, 'awaiting_human')
);
const truthy = (value) => value === true || value === 'true';

if (placementStep) {
  if (truthy(placementResult?.order_created) && placementResult?.id) {
    const orderId = String(placementResult.id);
    const status = String(placementResult.status || 'received').replace(/_/g, ' ');
    output = choose(
      'Your order has been placed successfully. Order #' + orderId + ' has been ' + status + '.',
      'Aap ka order successfully place ho gaya hai. Order #' + orderId + ' ' + status + ' hai.',
      'آپ کا آرڈر #' + orderId + ' کامیابی سے درج ہو گیا ہے۔'
    );
  } else {
    const error = String(placementResult?.checkout_error || 'order_not_created');
    if (error === 'delivery_address_required') {
      output = choose(
        'I have your name, but I still need the delivery address. Please share your hostel, area, or landmark.',
        'Aap ka naam mil gaya hai, lekin delivery address abhi chahiye. Hostel, area ya landmark share kar dein.',
        'آپ کا نام مل گیا ہے، لیکن ڈیلیوری کا پتہ ابھی درکار ہے۔ براہِ کرم ہاسٹل، علاقہ یا نشانی بتا دیں۔'
      );
    } else if (error === 'delivery_name_required') {
      output = choose(
        'Please share the name for this delivery.',
        'Is delivery ke liye apna naam share kar dein.',
        'براہِ کرم اس ڈیلیوری کے لیے اپنا نام بتا دیں۔'
      );
    } else if (error === 'order_type_required') {
      output = choose(
        'Would you like delivery or pickup?',
        'Delivery chahiye ya pickup?',
        'آپ ڈیلیوری چاہتے ہیں یا پک اپ؟'
      );
    } else {
      output = choose(
        'I could not confirm the order yet. Please confirm your cart and delivery details.',
        'Order abhi confirm nahi ho saka. Cart aur delivery details confirm kar dein.',
        'آرڈر ابھی کنفرم نہیں ہو سکا۔ براہِ کرم کارٹ اور ڈیلیوری کی تفصیل کنفرم کر دیں۔'
      );
    }
  }
}

if (!placementStep && handoffStep) {
  if (truthy(handoffResult?.dashboard_request_visible) && handoffResult?.request_id) {
    output = choose(
      'I have shared your issue with the restaurant team for review.',
      'Main ne aap ka masla restaurant team ke review ke liye share kar diya hai.',
      'میں نے آپ کا مسئلہ ریسٹورنٹ ٹیم کے جائزے کے لیے بھیج دیا ہے۔'
    );
  } else {
    output = choose(
      'I could not send your issue to the restaurant team yet. Please try again in a moment.',
      'Main abhi aap ka masla restaurant team ko nahi bhej saka. Thori dair baad dobara try karein.',
      'میں ابھی آپ کا مسئلہ ریسٹورنٹ ٹیم کو نہیں بھیج سکا۔ براہِ کرم تھوڑی دیر بعد دوبارہ کوشش کریں۔'
    );
  }
}

const outputText = String(output || '');
const containsOrderSuccessClaim = /(?:order\\s*#\\s*\\d+|order\\s+(?:has\\s+been\\s+)?(?:placed|confirmed)|placed\\s+successfully|successfully\\s+placed)/i.test(outputText)
  && !/\\b(?:not|hasn't|has not|wasn't|was not)\\b.{0,30}\\b(?:placed|confirmed)\\b/i.test(outputText);
if (!placementStep && !handoffStep && session.order_status === 'draft' && containsOrderSuccessClaim) {
  if (session.order_type === 'delivery' && !session.delivery_address) {
    output = choose(
      'I still need the delivery address before I can place the order. Please share your hostel, area, or landmark.',
      'Order place karne se pehle delivery address chahiye. Hostel, area ya landmark share kar dein.',
      'آرڈر درج کرنے سے پہلے ڈیلیوری کا پتہ درکار ہے۔ براہِ کرم ہاسٹل، علاقہ یا نشانی بتا دیں۔'
    );
  } else if (session.order_type === 'delivery' && !session.delivery_name) {
    output = choose(
      'I still need the name for this delivery before I can place the order.',
      'Order place karne se pehle is delivery ke liye naam chahiye.',
      'آرڈر درج کرنے سے پہلے اس ڈیلیوری کے لیے نام درکار ہے۔'
    );
  } else {
    output = choose(
      'I could not confirm the order yet. Please confirm your cart and order details.',
      'Order abhi confirm nahi ho saka. Cart aur order details confirm kar dein.',
      'آرڈر ابھی کنفرم نہیں ہو سکا۔ براہِ کرم کارٹ اور آرڈر کی تفصیل کنفرم کر دیں۔'
    );
  }
}
`;
if (!guard.parameters.jsCode.includes("const findToolResult")) {
  guard.parameters.jsCode = guard.parameters.jsCode.replace("\nreturn [{\n  json:", `${placementGuard}\nreturn [{\n  json:`);
}
const noToolOrderGuard = `

const outputText = String(output || '');
const containsOrderSuccessClaim = /(?:order\\s*#\\s*\\d+|order\\s+(?:has\\s+been\\s+)?(?:placed|confirmed)|placed\\s+successfully|successfully\\s+placed)/i.test(outputText)
  && !/\\b(?:not|hasn't|has not|wasn't|was not)\\b.{0,30}\\b(?:placed|confirmed)\\b/i.test(outputText);
if (!placementStep && !handoffStep && session.order_status === 'draft' && containsOrderSuccessClaim) {
  if (session.order_type === 'delivery' && !session.delivery_address) {
    output = choose(
      'I still need the delivery address before I can place the order. Please share your hostel, area, or landmark.',
      'Order place karne se pehle delivery address chahiye. Hostel, area ya landmark share kar dein.',
      'آرڈر درج کرنے سے پہلے ڈیلیوری کا پتہ درکار ہے۔ براہِ کرم ہاسٹل، علاقہ یا نشانی بتا دیں۔'
    );
  } else if (session.order_type === 'delivery' && !session.delivery_name) {
    output = choose(
      'I still need the name for this delivery before I can place the order.',
      'Order place karne se pehle is delivery ke liye naam chahiye.',
      'آرڈر درج کرنے سے پہلے اس ڈیلیوری کے لیے نام درکار ہے۔'
    );
  } else {
    output = choose(
      'I could not confirm the order yet. Please confirm your cart and order details.',
      'Order abhi confirm nahi ho saka. Cart aur order details confirm kar dein.',
      'آرڈر ابھی کنفرم نہیں ہو سکا۔ براہِ کرم کارٹ اور آرڈر کی تفصیل کنفرم کر دیں۔'
    );
  }
}
`;
if (!guard.parameters.jsCode.includes("const containsOrderSuccessClaim")) {
  guard.parameters.jsCode = guard.parameters.jsCode.replace("\nreturn [{\n  json:", `${noToolOrderGuard}\nreturn [{\n  json:`);
}
if (!guard.parameters.jsCode.includes("checkout_error")) {
  throw new Error("Order placement reply guard was not installed");
}

workflow.versionId = crypto.randomUUID();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Updated ${path.basename(workflowPath)} with draft-cart, checkout, and handoff safeguards.`);
