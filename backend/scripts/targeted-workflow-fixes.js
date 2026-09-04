function applyTargetedWorkflowFixes(workflow, { postgresCredentials, whatsappCredentials }) {
  workflow.nodes = workflow.nodes.filter((node) => node.name !== "Reply Already Sent");
  const find = (name) => {
    const value = workflow.nodes.find((node) => node.name === name);
    if (!value) throw new Error(`Workflow node not found: ${name}`);
    return value;
  };
  const upsert = (node) => {
    const index = workflow.nodes.findIndex((value) => value.name === node.name);
    if (index < 0) workflow.nodes.push(node);
    else workflow.nodes[index] = node;
  };
  const pg = (name, id, position, query, queryReplacement, toolDescription) => ({
    parameters: {
      operation: "executeQuery",
      query,
      options: queryReplacement ? { queryReplacement } : {},
      ...(toolDescription ? { descriptionType: "manual", toolDescription } : {}),
    },
    type: toolDescription ? "n8n-nodes-base.postgresTool" : "n8n-nodes-base.postgres",
    typeVersion: 2.7,
    position,
    id,
    name,
    credentials: postgresCredentials,
  });
  const condition = (name, id, position, expression) => ({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
        conditions: [{ id, leftValue: expression, rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }],
        combinator: "and",
      },
      options: {},
    },
    type: "n8n-nodes-base.if",
    typeVersion: 2.3,
    position,
    id,
    name,
  });
  const set = (name, id, position, assignments) => ({
    parameters: { assignments: { assignments }, options: {} },
    type: "n8n-nodes-base.set",
    typeVersion: 3.5,
    position,
    id,
    name,
  });
  const send = (name, id, position, recipient, textBody) => ({
    parameters: {
      operation: "send",
      phoneNumberId: "={{ $('Workflow Configuration').item.json.whatsapp_phone_number_id }}",
      recipientPhoneNumber: recipient,
      textBody,
      additionalFields: {},
    },
    type: "n8n-nodes-base.whatsApp",
    typeVersion: 1.1,
    position,
    id,
    name,
    credentials: whatsappCredentials,
  });

  // The installed WhatsApp Trigger verifies x-hub-signature-256 against
  // req.rawBody using the WhatsApp Trigger credential's Client Secret.
  const trigger = find("WhatsApp Trigger");
  trigger.notesInFlow = true;
  trigger.notes = "Security: n8n 2.34.5 WhatsApp Trigger performs native HMAC-SHA256 verification over req.rawBody. Configure the Meta App Client Secret in the WhatsApp Trigger credential; unsigned/invalid webhooks are rejected before this workflow runs.";

  const normalize = find("Normalize Incoming Message");
  const assignments = normalize.parameters.assignments.assignments;
  if (!assignments.some((entry) => entry.name === "has_message")) {
    assignments.push({
      id: "dcfb7e91-a895-49c6-9ce8-cb855c90796c",
      name: "has_message",
      value: "={{ Boolean($json.messages?.[0]?.id) }}",
      type: "boolean",
    });
  }

  const config = find("Workflow Configuration");
  config.parameters.assignments.assignments = [
    { id: "b77416b2-1c23-4f85-8018-5e14491956d9", name: "admin_phone", value: "={{ String($vars.ADMIN_WHATSAPP_PHONE || '').replace(/\\D/g, '') }}", type: "string" },
    { id: "275487fc-63f1-46b2-835b-9d2c431632cf", name: "whatsapp_phone_number_id", value: "={{ String($vars.WHATSAPP_PHONE_NUMBER_ID || '') }}", type: "string" },
  ];
  upsert(condition("Has Message", "cd758b47-0126-49a5-ab12-c9a8591a17ef", [-352, 16], "={{ $json.has_message }}"));
  upsert(condition("Configuration Present", "e44f67a6-9b18-49fd-98fc-e47d8ff0e4cb", [-96, 16], "={{ Boolean($json.admin_phone && $json.whatsapp_phone_number_id) }}"));
  upsert({
    parameters: { mode: "runOnceForAllItems", jsCode: "console.error('Workflow configuration missing: set ADMIN_WHATSAPP_PHONE and WHATSAPP_PHONE_NUMBER_ID in n8n variables. No WhatsApp message was sent.');\nreturn [];" },
    type: "n8n-nodes-base.code", typeVersion: 2, position: [128, 144],
    id: "bc9bff84-b129-445a-8646-8872dd85f9d4", name: "Configuration Error Reply",
  });
  upsert(set("Unsupported Message Reply", "cf4f6fc0-6d14-4a4a-abd3-15ad8618159e", [144, 128], [
    { id: "21bead9c-4537-4aba-9959-95005577b914", name: "reply_text", value: "I can only read text messages right now — could you type that for me?", type: "string" },
  ]));
  upsert(send("Send Unsupported Message", "a2c99e21-46ed-40cc-af63-3cce557e1d16", [368, 128], "={{ $('Normalize Incoming Message').item.json.customer_phone }}", "={{ $json.reply_text }}"));

  const claimTurnSql = `WITH serialized AS (
  SELECT pg_advisory_xact_lock(hashtextextended('customer-turn:' || $1::text, 0))
), current_row AS (
  SELECT mb.* FROM message_buffer mb CROSS JOIN serialized
  WHERE mb.id = $2::bigint AND mb.customer_phone = $1::text
), active_batch AS (
  SELECT EXISTS (SELECT 1 FROM message_buffer mb
    WHERE mb.customer_phone = $1::text AND mb.processed = FALSE
      AND mb.batch_key IS NOT NULL
      AND mb.batch_claimed_at >= NOW() - INTERVAL '5 minutes') AS present
), latest_available AS (
  SELECT MAX(mb.id) AS id FROM message_buffer mb
  WHERE mb.customer_phone = $1::text AND mb.processed = FALSE
    AND mb.message_id IS NOT NULL
    AND (mb.batch_key IS NULL OR mb.batch_claimed_at < NOW() - INTERVAL '5 minutes')
), decision AS (
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM current_row WHERE processed = FALSE) THEN 'superseded'
    WHEN EXISTS (SELECT 1 FROM current_row WHERE batch_key IS NOT NULL AND batch_claimed_at >= NOW() - INTERVAL '5 minutes') THEN 'superseded'
    WHEN (SELECT present FROM active_batch) THEN 'busy'
    WHEN (SELECT id FROM latest_available) IS DISTINCT FROM (SELECT id FROM current_row) THEN 'superseded'
    ELSE 'ready' END AS mode
), claimed AS (
  UPDATE message_buffer mb
  SET batch_key = $3::text, batch_claimed_at = NOW()
  WHERE mb.customer_phone = $1::text AND mb.processed = FALSE AND mb.message_id IS NOT NULL
    AND (mb.batch_key IS NULL OR mb.batch_claimed_at < NOW() - INTERVAL '5 minutes')
    AND (SELECT mode FROM decision) = 'ready'
  RETURNING mb.id, mb.message_id, mb.message_text, mb.received_at, mb.reply_text, mb.replied_at
)
SELECT d.mode, $3::text AS batch_key,
  (SELECT string_agg(c.message_text, E'\\n' ORDER BY c.id) FROM claimed c) AS combined_text,
  (SELECT COUNT(*)::int FROM claimed) AS message_count,
  (SELECT jsonb_agg(c.message_id ORDER BY c.id) FROM claimed c) AS message_ids,
  COALESCE((SELECT COUNT(*) > 0 AND BOOL_AND(c.replied_at IS NOT NULL) FROM claimed c), FALSE) AS reply_already_sent,
  (SELECT c.reply_text FROM claimed c WHERE c.replied_at IS NOT NULL ORDER BY c.id DESC LIMIT 1) AS stored_reply_text
FROM decision d;`;
  find("Claim Latest Customer Turn").parameters.query = claimTurnSql;

  upsert(condition("Reply Already Sent For This Batch", "db9e582c-d989-4d0b-a627-0ab81af3fa27", [1328, 160], "={{ $json.reply_already_sent }}"));
  upsert(set("Restore Stored Reply", "9bdf5e89-b813-44a3-a98f-ec7616235ba0", [1552, 144], [
    { id: "ecbce292-bb1a-43a9-a608-a72b86965fe6", name: "reply_text", value: "={{ $('Claim Latest Customer Turn').item.json.stored_reply_text }}", type: "string" },
  ]));

  const recordReplySql = `WITH marked AS (
  UPDATE message_buffer
  SET reply_text = $2::text, replied_at = NOW()
  WHERE batch_key = $1::text
    AND customer_phone = $3::text
    AND processed = FALSE
    AND replied_at IS NULL
  RETURNING id
)
SELECT $2::text AS reply_text, COUNT(*)::int AS replies_recorded FROM marked;`;
  upsert(pg("Record Reply Sent", "23456a47-47f8-4b65-afd6-1b1289ee502f", [2112, 0], recordReplySql,
    "={{ [ $('Claim Latest Customer Turn').item.json.batch_key, $('Reply Text').item.json.reply_text, $('Normalize Incoming Message').item.json.customer_phone ] }}"));

  const finalize = find("Finalize Customer Turn");
  finalize.position = [2336, 0];
  finalize.parameters.options.queryReplacement = "={{ [ $('Upsert Customer and Session').item.json.customer_id, $('Claim Latest Customer Turn').item.json.combined_text || '', $json.reply_text || $('Claim Latest Customer Turn').item.json.stored_reply_text || '', $('Claim Latest Customer Turn').item.json.batch_key, $('Normalize Incoming Message').item.json.customer_phone ] }}";

  const upsertCustomer = find("Upsert Customer and Session");
  upsertCustomer.parameters.query = upsertCustomer.parameters.query.replace(
    "    session.active_order_id,\n    session.pending_items\nFROM customer\nJOIN session ON session.customer_id = customer.id;",
    "    session.active_order_id,\n    active_order.status AS active_order_status,\n    session.pending_items\nFROM customer\nJOIN session ON session.customer_id = customer.id\nLEFT JOIN orders active_order ON active_order.id = session.active_order_id;",
  );

  const choiceValid = (selected, dealAlias) => `
    NOT EXISTS (
      SELECT 1 FROM restaurant_deal_components required
      WHERE required.deal_id = ${dealAlias}.id AND required.selectable = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(${selected}) choice_json
          JOIN restaurant_menu_items choice ON choice.active = TRUE
            AND LOWER(choice.name) = LOWER(choice_json->>'choice')
          WHERE choice_json->>'selection_group' = required.selection_group
            AND CASE
              WHEN required.allowed_item_rule->>'allowed' = 'any_active_pizza' THEN
                choice.item_type = 'pizza' AND EXISTS (
                  SELECT 1 FROM restaurant_menu_variants cv WHERE cv.menu_item_id = choice.id AND cv.active = TRUE
                    AND LOWER(cv.variant_label) = LOWER(required.allowed_item_rule->>'size_label'))
              WHEN required.allowed_item_rule->>'allowed' = 'active_wing_items' THEN
                choice.name ILIKE '%wing%'
              WHEN required.allowed_item_rule->>'allowed' = 'active_sauces' THEN
                choice.item_type = 'sauce'
              WHEN jsonb_typeof(required.allowed_item_rule->'allowed_brands') = 'array' THEN
                choice.item_type = 'drink'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(required.allowed_item_rule->'allowed_brands') brand WHERE LOWER(brand) = LOWER(choice.name))
                AND EXISTS (SELECT 1 FROM restaurant_menu_variants cv WHERE cv.menu_item_id = choice.id AND cv.active = TRUE
                  AND LOWER(cv.variant_label) = LOWER(COALESCE(required.allowed_item_rule->>'size', required.allowed_item_rule->>'size_label')))
              ELSE FALSE END
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${selected}) choice_json
      WHERE jsonb_typeof(choice_json) <> 'object'
         OR NOT EXISTS (SELECT 1 FROM restaurant_deal_components known
                        WHERE known.deal_id = ${dealAlias}.id AND known.selectable = TRUE
                          AND known.selection_group = choice_json->>'selection_group')
    )
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${selected})) =
        (SELECT COUNT(*) FROM restaurant_deal_components required WHERE required.deal_id = ${dealAlias}.id AND required.selectable = TRUE)
    AND (SELECT COUNT(DISTINCT choice_json->>'selection_group') FROM jsonb_array_elements(${selected}) choice_json) =
        (SELECT COUNT(*) FROM jsonb_array_elements(${selected}))`;

  const updateCart = find("Update Cart");
  updateCart.parameters.query = updateCart.parameters.query
    .replace(
      "  JOIN restaurant_deals d ON d.id = ndi.deal_id AND d.active = TRUE\n),\nvalidated_new_items",
      `  JOIN restaurant_deals d ON d.id = ndi.deal_id AND d.active = TRUE\n  WHERE ${choiceValid("ndi.selected_components", "d")}\n),\nvalidated_new_items`,
    )
    .replace(
      "  JOIN restaurant_deals d ON d.id = edi.deal_id AND d.active = TRUE\n),\nvalidated_existing_items",
      `  JOIN restaurant_deals d ON d.id = edi.deal_id AND d.active = TRUE\n  WHERE ${choiceValid("edi.selected_components", "d")}\n),\nvalidated_existing_items`,
    );
  updateCart.parameters.toolDescription += " Every selectable deal component is validated by selection_group and choice against the deal's allowed_item_rule; incomplete, unknown, inactive, or disallowed configurations are rejected.";

  const placeOrderSql = `WITH lock_customer AS (
  SELECT pg_advisory_xact_lock(hashtext('order_create:' || $1::text))
), session_data AS (
  SELECT cs.customer_id, cs.cart, cs.order_type, cs.delivery_address, cs.delivery_name
  FROM conversation_sessions cs CROSS JOIN lock_customer
  WHERE cs.customer_id = $1::bigint
), cart_lines AS (
  SELECT item, ordinal
  FROM session_data sd
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sd.cart->'items') = 'array' THEN sd.cart->'items' ELSE '[]'::jsonb END)
    WITH ORDINALITY AS x(item, ordinal)
), valid_menu AS (
  SELECT cl.ordinal FROM cart_lines cl
  JOIN restaurant_menu_items mi ON mi.active = TRUE AND mi.id = CASE WHEN cl.item->>'menu_item_id' ~ '^[0-9]{1,18}$' THEN (cl.item->>'menu_item_id')::bigint END
  JOIN restaurant_menu_variants mv ON mv.active = TRUE AND mv.menu_item_id = mi.id
    AND mv.id = CASE WHEN cl.item->>'variant_id' ~ '^[0-9]{1,18}$' THEN (cl.item->>'variant_id')::bigint END
  WHERE cl.item->>'record_type' = 'menu_item'
), valid_deal AS (
  SELECT cl.ordinal FROM cart_lines cl
  JOIN restaurant_deals d ON d.active = TRUE AND d.id = CASE WHEN cl.item->>'deal_id' ~ '^[0-9]{1,18}$' THEN (cl.item->>'deal_id')::bigint END
  WHERE cl.item->>'record_type' = 'deal'
    AND jsonb_typeof(COALESCE(cl.item->'selected_components', '[]'::jsonb)) = 'array'
    AND ${choiceValid("COALESCE(cl.item->'selected_components', '[]'::jsonb)", "d")}
), valid_lines AS (SELECT ordinal FROM valid_menu UNION ALL SELECT ordinal FROM valid_deal),
invalid AS (
  SELECT COALESCE(array_agg(COALESCE(cl.item->>'item_name', cl.item->>'name', 'cart line #' || cl.ordinal::text) ORDER BY cl.ordinal), ARRAY[]::text[]) AS invalid_items
  FROM cart_lines cl WHERE NOT EXISTS (SELECT 1 FROM valid_lines vl WHERE vl.ordinal = cl.ordinal)
), cart_totals AS (
  SELECT sd.customer_id, sd.cart, sd.order_type, sd.delivery_address, sd.delivery_name,
    COALESCE((SELECT SUM((item->>'line_total')::numeric) FROM cart_lines), 0) AS subtotal
  FROM session_data sd
), settings AS (SELECT delivery_charge FROM restaurant_settings WHERE id = 1),
new_order AS (
  INSERT INTO orders (customer_id, items, order_type, delivery_address, delivery_name, subtotal, delivery_charge, total)
  SELECT ct.customer_id, ct.cart->'items', ct.order_type, ct.delivery_address, ct.delivery_name, ct.subtotal,
    CASE WHEN ct.order_type = 'delivery' THEN s.delivery_charge ELSE 0 END,
    ct.subtotal + CASE WHEN ct.order_type = 'delivery' THEN s.delivery_charge ELSE 0 END
  FROM cart_totals ct, settings s, invalid i
  WHERE COALESCE(jsonb_array_length(ct.cart->'items'), 0) > 0
    AND cardinality(i.invalid_items) = 0
    AND ct.order_type IN ('delivery', 'pickup')
    AND (ct.order_type = 'pickup' OR (ct.order_type = 'delivery'
      AND NULLIF(TRIM(ct.delivery_name), '') IS NOT NULL
      AND NULLIF(TRIM(ct.delivery_address), '') IS NOT NULL))
  RETURNING *
), cleared_session AS (
  UPDATE conversation_sessions SET cart = '{"items": []}'::jsonb, order_type = NULL,
    delivery_address = NULL, delivery_name = NULL, order_status = 'placed',
    active_order_id = (SELECT id FROM new_order), updated_at = NOW()
  WHERE customer_id = $1::bigint AND EXISTS (SELECT 1 FROM new_order) RETURNING 1
)
SELECT (SELECT COUNT(*) FROM new_order) > 0 AS order_created,
  (SELECT invalid_items FROM invalid) AS invalid_items, no.*
FROM (SELECT 1) AS one LEFT JOIN new_order no ON TRUE;`;
  const placeOrder = find("Place Order");
  placeOrder.parameters.query = placeOrderSql;
  placeOrder.parameters.toolDescription = "Atomically place the current draft order only after every cart line is revalidated against active menu items, matching active variants, active deals, and allowed deal component choices. If order_created=false and invalid_items is non-empty, tell the customer those lines changed/unavailable and ask them to update the cart.";

  upsert(pg(
    "Update Placed Order Delivery Info", "7be8f28d-e8fb-4eb2-903d-f5884a2d22e5", [2080, 416],
    `UPDATE orders
SET delivery_name = COALESCE(NULLIF(BTRIM($3::text), ''), delivery_name),
    delivery_address = COALESCE(NULLIF(BTRIM($4::text), ''), delivery_address),
    updated_at = NOW()
WHERE id = $2::bigint
  AND customer_id = $1::bigint
  AND status IN ('received', 'preparing')
RETURNING id, status, delivery_name, delivery_address;`,
    "={{ [ $('Upsert Customer and Session').item.json.customer_id, $('Upsert Customer and Session').item.json.active_order_id, $fromAI('delivery_name', 'Corrected delivery name, or empty string to keep it unchanged', 'string'), $fromAI('delivery_address', 'Corrected delivery address, or empty string to keep it unchanged', 'string') ] }}",
    "Use only after an order is placed (session order_status is not draft). Correct the active order's delivery name/address only while status is received or preparing. If zero rows are returned, the order is too far along to redirect: call Escalate To Human and Notify Admin instead.",
  ));
  workflow.connections["Update Placed Order Delivery Info"] = { ai_tool: [[{ node: "Pizza Ordering Agent", type: "ai_tool", index: 0 }]] };

  const escalation = find("Escalate To Human");
  escalation.parameters.query = `WITH escalated AS (
  UPDATE conversation_sessions SET awaiting_human = TRUE, updated_at = NOW()
  WHERE customer_id = $1::bigint RETURNING customer_id
), notified AS (
  INSERT INTO admin_notifications (notification_type, title, source_key, customer_id, message, created_at)
  SELECT 'customer_request', 'Escalation requested',
         'escalation:' || customer_id || ':' || gen_random_uuid(), customer_id,
         COALESCE(NULLIF(BTRIM($2::text), ''), 'Customer requested human assistance.'), NOW() FROM escalated
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM escalated) AS awaiting_human,
       (SELECT id FROM notified) AS admin_notification_id;`;
  escalation.parameters.options.queryReplacement = "={{ [ $('Upsert Customer and Session').item.json.customer_id, $fromAI('reason', 'Specific reason staff must follow up, including the customer issue and relevant order context', 'string') ] }}";
  escalation.parameters.toolDescription = "Set the conversation to awaiting human support and create a durable admin dashboard notification. Provide a specific, useful reason. A separate Notify Admin WhatsApp call is optional, not the only alert.";

  const agent = find("Pizza Ordering Agent");
  agent.continueOnFail = true;
  agent.parameters.options.systemMessage = agent.parameters.options.systemMessage.replace(
    "- RECENT_MESSAGES (last turns of this conversation, oldest first):",
    "- ACTIVE_ORDER_STATUS: {{ $('Upsert Customer and Session').item.json.active_order_status || 'none' }}\n- RECENT_MESSAGES (last turns of this conversation, oldest first):",
  );
  const additions = `

ACTIVE ORDER RULES
- active_order_status is the authoritative current database status for active_order_id. Explain it plainly when asked; never infer status from the session's older order_status field.
- If a customer corrects the delivery name or address after placement, call Update Placed Order Delivery Info. If it returns no row, explain the order can no longer be edited automatically, then call Escalate To Human and Notify Admin with a specific reason.
- Place Order revalidates every cart line. If it returns invalid_items, do not claim success; identify those items and ask the customer to update the cart.
- Escalate To Human already creates the durable dashboard alert. Use Notify Admin only when an immediate WhatsApp alert is useful.`;
  if (!agent.parameters.options.systemMessage.includes("ACTIVE ORDER RULES")) {
    agent.parameters.options.systemMessage += additions;
  }
  upsert(condition("Agent Output Valid", "78e83b64-0d25-4f56-a45d-926ad02b9575", [1648, 0], "={{ Boolean(!$json.error && $json.output) }}"));
  upsert(set("Agent Fallback Reply", "317a73b0-7626-4262-8a88-6ea7e2e29673", [1856, 128], [
    { id: "57ef067d-bbe8-49e9-8080-eed896a196e0", name: "reply_text", value: "Sorry, I’m having trouble processing that right now. Please try again in a moment.", type: "string" },
  ]));
  find("Reply Text").parameters.assignments.assignments[0].value = "={{ $json.reply_text || $json.output }}";

  // Resolution does not own the delivery lease. Both n8n and Express claim it
  // only after the business transaction commits.
  const resolve = find("Resolve Admin Request");
  resolve.parameters.query = resolve.parameters.query
    .replace(/,\n\s*notification_claim_token = CASE[\s\S]*?notification_claimed_at = CASE WHEN e\.notification_sent THEN NULL ELSE NOW\(\) END/, "")
    .replace(/,\nnotification_reclaimed AS \([\s\S]*?\n\),\nsession_updated AS/, ",\nsession_updated AS")
    .replace(/,\n\s*COALESCE\(rr\.notification_claim_token, nr\.notification_claim_token, e\.notification_claim_token\) AS notification_claim_token/, "")
    .replace("  LEFT JOIN notification_reclaimed nr ON nr.id = e.id\n", "")
    .replace("    AND notification_sent = FALSE\n    AND notification_claim_token = admin_message_id)", "    AND notification_sent = FALSE)");

  const claimNotificationSql = `UPDATE admin_requests
SET notification_claim_token = $2::text,
    notification_claimed_at = NOW()
WHERE id = $1::bigint
  AND status IN ('approved', 'denied')
  AND notification_sent = FALSE
  AND (
    notification_claim_token IS NULL
    OR notification_claimed_at < NOW() - INTERVAL '2 minutes'
  )
RETURNING id;`;
  const claimNotification = pg("Claim Customer Notification", "c6889fc9-6801-4971-a018-fbe503d1d701", [1504, -464], claimNotificationSql,
    "={{ [ $('Resolve Admin Request').item.json.matched_request_id, $('Normalize Incoming Message').item.json.message_id ] }}");
  claimNotification.alwaysOutputData = true;
  claimNotification.notesInFlow = true;
  claimNotification.notes = "Shared lease: SQL must stay equivalent to CUSTOMER_NOTIFICATION_CLAIM_SQL in backend/src/admin-routes.js.";
  upsert(claimNotification);
  upsert(condition("Notification Claimed", "e234abf6-e7ad-4532-af20-7404cb503319", [1712, -464], "={{ Boolean($json.id) }}"));
  const customerSend = find("Send Admin Decision to Customer");
  customerSend.position = [1920, -528];
  const recordNotification = find("Record Customer Decision Notification");
  recordNotification.position = [2128, -528];
  recordNotification.parameters.options.queryReplacement = "={{ [ $('Resolve Admin Request').item.json.matched_request_id, $json.messages?.[0]?.id || null, $('Normalize Incoming Message').item.json.message_id ] }}";
}

module.exports = applyTargetedWorkflowFixes;
