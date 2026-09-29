const fs = require("fs");
const path = require("path");

const workflowPath = path.resolve(__dirname, "../..", process.argv[2] || "workflow.json");
let raw = fs.readFileSync(workflowPath, "utf8");
let workflow = JSON.parse(raw);

function find(name) {
  const found = workflow.nodes.find((node) => node.name === name);
  if (!found) throw new Error(`Workflow node not found: ${name}`);
  return found;
}

function replaceJsonPropertyInNode(source, nodeName, propertyName, value) {
  const token = `"name": ${JSON.stringify(nodeName)}`;
  const firstNameIndex = source.indexOf(token);
  if (firstNameIndex === -1 || source.indexOf(token, firstNameIndex + token.length) !== -1) {
    throw new Error(`Expected exactly one node named ${nodeName}`);
  }

  const nodeStart = source.lastIndexOf("\n    {", firstNameIndex);
  const nodeEnd = source.indexOf("\n    }", firstNameIndex);
  if (nodeStart === -1 || nodeEnd === -1) throw new Error(`Could not isolate node ${nodeName}`);

  const before = source.slice(0, nodeStart + 1);
  const block = source.slice(nodeStart + 1, nodeEnd + 6);
  const after = source.slice(nodeEnd + 6);
  const escapedProperty = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const propertyPattern = new RegExp(`^(\\s*"${escapedProperty}"\\s*:\\s*)[^\\r\\n]*(\\r?)$`, "m");
  const matches = [...block.matchAll(new RegExp(propertyPattern.source, "gm"))];
  if (matches.length !== 1) {
    throw new Error(`Expected one ${propertyName} property in ${nodeName}; found ${matches.length}`);
  }

  const match = matches[0];
  const previousLine = match[0];
  const comma = previousLine.replace(/\r$/, "").trimEnd().endsWith(",") ? "," : "";
  const replacement = `${match[1]}${JSON.stringify(value)}${comma}${match[2]}`;
  return before + block.slice(0, match.index) + replacement + block.slice(match.index + previousLine.length) + after;
}

function appendNode(source, node) {
  if (source.includes(`"name": ${JSON.stringify(node.name)}`)) return source;
  const anchor = "\n  ],\n  \"pinData\":";
  const index = source.indexOf(anchor);
  if (index === -1) throw new Error("Could not find the end of the workflow node list");
  const rendered = JSON.stringify(node, null, 2).split("\n").map((line) => `    ${line}`).join("\n");
  return source.slice(0, index) + `,\n${rendered}` + source.slice(index);
}

function appendToolConnection(source, nodeName) {
  if (source.includes(`"${nodeName}": {`)) return source;
  const anchor = "\n  },\n  \"active\":";
  const index = source.lastIndexOf(anchor);
  if (index === -1) throw new Error("Could not find the end of workflow connections");
  const connection = `    "${nodeName}": {\n      "ai_tool": [\n        [\n          {\n            "node": "Pizza Ordering Agent",\n            "type": "ai_tool",\n            "index": 0\n          }\n        ]\n      ]\n    }`;
  return source.slice(0, index) + `,\n${connection}` + source.slice(index);
}

const agent = find("Pizza Ordering Agent");
const updateCart = find("Update Cart");
const menuLookup = find("Menu Lookup");
const loadActiveMenu = find("Load Active Menu");
const cancelOrder = find("Cancel Order");
const replaceDraftCart = find("Replace Draft Cart");
const cancellationReplyGuard = find("Guard Cancellation Reply");

const lineBreak = agent.parameters.options.systemMessage.includes("\r\n") ? "\r\n" : "\n";
const dealRules = [
  "==================================================",
  "6A. DEAL COMPONENT RESOLUTION — NO SIZE AMBIGUITY",
  "==================================================",
  "",
  "A live deal component is the complete authority for its selection. A selectable component asks the customer only for the product name or drink brand. Its allowed_item_rule fixes every other constraint.",
  "",
  "* A rule with size or size_label fixes the required live variant. Resolve that matching variant yourself; never ask the customer to repeat or choose that size.",
  "* A drink component with allowed_brands asks only for the brand. If its live rule says size=345ml, select the 345ml variant automatically. Do not list drink sizes or ask a size question.",
  "* Non-selectable components are included automatically. Never ask the customer to choose them and never include them in selected_components.",
  "* For each selectable component, selected_components contains exactly { selection_group, choice }, where choice is the exact live menu item name. The database resolves and validates the required variant from the deal rule.",
  "",
  "Preserve every already-confirmed deal choice while resolving another one. If a customer says \"fajita and 7UP\" for a deal whose pizza slot is fixed to Small and drink slot is fixed to 345ml, retain 7UP, ask only which Fajita product they mean, then add the deal after they answer. Do not mention standalone component prices; the deal price is authoritative.",
  "",
  "If a deal exposes multiple labeled selection groups (for example Pizza 1/Pizza 2, Drink 1/Drink 2, or Dip 1/Dip 2), each is an independent required choice. Never assume the same item for another slot. Ask only for each missing labeled choice, preserve every exact group-to-choice mapping, and do not add the deal until every required slot is known.",
  "",
  "When a named product matches several live records, ask only which exact record is intended. A fixed deal size never makes the product name ambiguous, and a matching product name never makes the fixed size a new customer question.",
  "",
  "For an incomplete deal, use Set Pending Deal Configuration with the exact live deal ID and every confirmed choice. On the next turn, SESSION.pending_items is authoritative for that in-progress deal. When every selectable choice is known, call Update Cart exactly once; it clears the pending configuration only after a validated cart update.",
  "",
].join(lineBreak);

let systemMessage = agent.parameters.options.systemMessage;
if (!systemMessage.includes("6A. DEAL COMPONENT RESOLUTION — NO SIZE AMBIGUITY")) {
  const insertion = `${lineBreak}==================================================${lineBreak}7. DRAFT CART OPERATIONS`;
  const index = systemMessage.indexOf(insertion);
  if (index === -1) throw new Error("Could not find the draft-cart section in the agent prompt");
  systemMessage = systemMessage.slice(0, index) + lineBreak + dealRules + systemMessage.slice(index);
}

const multiSlotRule = "If a deal exposes multiple labeled selection groups (for example Pizza 1/Pizza 2, Drink 1/Drink 2, or Dip 1/Dip 2), each is an independent required choice. Never assume the same item for another slot. Ask only for each missing labeled choice, preserve every exact group-to-choice mapping, and do not add the deal until every required slot is known.";
if (!systemMessage.includes("each is an independent required choice")) {
  const anchor = `${lineBreak}When a named product matches several live records`;
  const index = systemMessage.indexOf(anchor);
  if (index === -1) throw new Error("Could not find the product-ambiguity rule in the agent prompt");
  systemMessage = systemMessage.slice(0, index) + `${lineBreak}${multiSlotRule}${lineBreak}` + systemMessage.slice(index);
}

systemMessage = systemMessage.replace(
  /\* Include every required selected_component\.\r?\n\* Never invent a missing choice\./,
  "* Include every required selected_component. Each entry must use the exact live selection_group and exact live item name: { selection_group, choice }.\n* Never invent a missing choice or an item variant. The deal rule, not the customer, supplies any fixed size."
).replace(
  /\* Accept success only when the returned result confirms the validated cart\./,
  "* Accept success only when updated=true, error is null, rejected_item_count=0, and the returned cart contains the intended deal."
);
if (!systemMessage.includes("Set Pending Deal Configuration")) {
  throw new Error("The deal-resolution rules were not installed in the agent prompt");
}

let dealQuery = updateCart.parameters.query;
const updateStart = dealQuery.indexOf("mutation_valid AS (") >= 0
  ? dealQuery.indexOf("mutation_valid AS (")
  : dealQuery.indexOf("updated AS (");
if (updateStart === -1) throw new Error("Could not find Update Cart mutation query");
const safeMutationTail = `mutation_valid AS (
  SELECT jsonb_array_length(ip.items) > 0
      AND jsonb_array_length(ip.items) = (SELECT COUNT(*) FROM validated_new_items) AS valid
  FROM input_payload ip
),
updated AS (
  UPDATE conversation_sessions cs
  SET cart = jsonb_build_object(
        'items',
        (SELECT COALESCE(jsonb_agg(to_jsonb(fi) ORDER BY fi.record_type, COALESCE(fi.menu_item_id, fi.deal_id), fi.variant_id, fi.selected_components::text), '[]'::jsonb) FROM final_items fi)
      ),
      order_status = 'draft',
      active_order_id = NULL,
      pending_items = '[]'::jsonb,
      cart_updated_at = NOW(),
      updated_at = NOW()
  FROM locked_session ls
  CROSS JOIN mutation_valid mv
  WHERE cs.id = ls.id AND mv.valid
  RETURNING cs.cart
)
SELECT
  EXISTS (SELECT 1 FROM updated) AS updated,
  CASE
    WHEN jsonb_array_length(ip.items) = 0 THEN 'empty_cart_operation'
    WHEN NOT mv.valid THEN 'invalid_or_incomplete_cart_operation'
    ELSE NULL
  END AS error,
  COALESCE((SELECT cart FROM updated), (SELECT cart FROM locked_session)) AS cart,
  jsonb_array_length(ip.items) AS input_item_count,
  (SELECT COUNT(*)::int FROM validated_new_items) AS accepted_item_count,
  jsonb_array_length(ip.items) - (SELECT COUNT(*)::int FROM validated_new_items) AS rejected_item_count
FROM input_payload ip
CROSS JOIN mutation_valid mv;`;
dealQuery = dealQuery.slice(0, updateStart) + safeMutationTail;

const dealToolDescription = "Cart tool for DEALS only. Add, set, or remove a deal using its exact live deal_id. For an add or set, items_json must contain {record_type:'deal', deal_id, quantity, selected_components}. selected_components must contain exactly one {selection_group, choice} object for every selectable live component; choice is the exact live menu item name. Multiple labeled groups (Pizza 1/Pizza 2, Drink 1/Drink 2, or Dip 1/Dip 2) are independent choices and each requires its own entry. Do not add IDs, sizes, variants, garlic bread, mayo dip, or any other non-selectable included component there: the database resolves fixed variants from allowed_item_rule. The operation is atomic. Trust success only when updated=true, error is null, rejected_item_count=0, and the returned cart contains the intended deal.";
const dealToolInput = "={{ [ $fromAI('items_json', 'JSON array of deal operations. Example: [{\"record_type\":\"deal\",\"deal_id\":123,\"quantity\":1,\"selected_components\":[{\"selection_group\":\"pizza_selection\",\"choice\":\"Chicken Fajita\"},{\"selection_group\":\"drink_selection\",\"choice\":\"7UP\"}]}]. Use exact live IDs, selection_group values, and item names. Fixed deal sizes are not customer inputs.', 'string'), $('Upsert Customer and Session').item.json.customer_id ] }}";

let activeMenuQuery = loadActiveMenu.parameters.query;
if (!activeMenuQuery.includes("normalized_message")) {
  activeMenuQuery = activeMenuQuery.replace(
    "  SELECT LOWER($1::text) AS message\n), relevant AS (",
    "  SELECT LOWER($1::text) AS message,\n         regexp_replace(LOWER($1::text), '[^a-z0-9]+', '', 'g') AS normalized_message\n), relevant AS ("
  );
  const start = activeMenuQuery.indexOf("  WHERE i.message LIKE");
  const end = activeMenuQuery.indexOf("\n  ORDER BY m.sort_order", start);
  if (start === -1 || end === -1) throw new Error("Could not add normalized matching to Load Active Menu");
  const normalizedWhere = `  WHERE i.message LIKE '%' || LOWER(m.name) || '%'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(COALESCE(m.aliases, '[]'::jsonb)) alias
       WHERE length(alias) >= 3 AND i.message LIKE '%' || LOWER(alias) || '%'
     )
     OR (
       length(i.normalized_message) >= 3
       AND (
         regexp_replace(LOWER(m.name), '[^a-z0-9]+', '', 'g') LIKE '%' || i.normalized_message || '%'
         OR i.normalized_message LIKE '%' || regexp_replace(LOWER(m.name), '[^a-z0-9]+', '', 'g') || '%'
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(COALESCE(m.aliases, '[]'::jsonb)) alias
           WHERE regexp_replace(LOWER(alias), '[^a-z0-9]+', '', 'g') LIKE '%' || i.normalized_message || '%'
              OR i.normalized_message LIKE '%' || regexp_replace(LOWER(alias), '[^a-z0-9]+', '', 'g') || '%'
         )
       )
     )`;
  activeMenuQuery = activeMenuQuery.slice(0, start) + normalizedWhere + activeMenuQuery.slice(end);
}

let lookupQuery = menuLookup.parameters.query;
if (!lookupQuery.includes("search_normalized")) {
  lookupQuery = lookupQuery.replace(
    "  SELECT LOWER(BTRIM($1::text)) AS search_text,\n         LOWER(BTRIM($2::text)) AS category_text",
    "  SELECT LOWER(BTRIM($1::text)) AS search_text,\n         LOWER(BTRIM($2::text)) AS category_text,\n         regexp_replace(LOWER(BTRIM($1::text)), '[^a-z0-9]+', '', 'g') AS search_normalized"
  );
  const categoryBranch = "    ))\n    OR (i.category_text <> '' AND (";
  if (!lookupQuery.includes(categoryBranch)) throw new Error("Could not add normalized matching to Menu Lookup");
  const normalizedBranch = `    ))
    OR (i.search_normalized <> '' AND (
      regexp_replace(LOWER(m.name), '[^a-z0-9]+', '', 'g') LIKE '%' || i.search_normalized || '%'
      OR i.search_normalized LIKE '%' || regexp_replace(LOWER(m.name), '[^a-z0-9]+', '', 'g') || '%'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(m.aliases, '[]'::jsonb)) a
        WHERE regexp_replace(LOWER(a), '[^a-z0-9]+', '', 'g') LIKE '%' || i.search_normalized || '%'
           OR i.search_normalized LIKE '%' || regexp_replace(LOWER(a), '[^a-z0-9]+', '', 'g') || '%'
      )
    ))
    OR (i.category_text <> '' AND (`;
  lookupQuery = lookupQuery.replace(categoryBranch, normalizedBranch);
}

let cancelOrderQuery = cancelOrder.parameters.query;
if (!cancelOrderQuery.includes("pending_items = CASE")) {
  cancelOrderQuery = cancelOrderQuery.replace(
    "    active_order_id = CASE WHEN order_status = 'draft' THEN NULL ELSE active_order_id END,",
    "    active_order_id = CASE WHEN order_status = 'draft' THEN NULL ELSE active_order_id END,\n    pending_items = CASE WHEN order_status = 'draft' THEN '[]'::jsonb ELSE pending_items END,"
  );
  if (!cancelOrderQuery.includes("pending_items = CASE")) throw new Error("Could not clear pending deal state on cancellation");
}

let replaceDraftCartQuery = replaceDraftCart.parameters.query;
if (!replaceDraftCartQuery.includes("pending_items = '[]'::jsonb")) {
  replaceDraftCartQuery = replaceDraftCartQuery.replace(
    "      active_order_id = NULL,\n      cart_updated_at = NOW(),",
    "      active_order_id = NULL,\n      pending_items = '[]'::jsonb,\n      cart_updated_at = NOW(),"
  );
  if (!replaceDraftCartQuery.includes("pending_items = '[]'::jsonb")) throw new Error("Could not clear pending deal state on cart replacement");
}

if (
  cancellationReplyGuard.parameters.jsCode.includes("containsOrderSuccessClaim")
  && (cancellationReplyGuard.parameters.jsCode.includes("\b")
    || cancellationReplyGuard.parameters.jsCode.includes("orders*#s*d+"))
) {
  const correctedOrderSuccessClaim = String.raw`const containsOrderSuccessClaim = /(?:order\s*#\s*\d+|order\s+(?:has\s+been\s+)?(?:placed|confirmed)|placed\s+successfully|successfully\s+placed)/i.test(outputText)
  && !/\b(?:not|hasn't|has not|wasn't|was not)\b.{0,30}\b(?:placed|confirmed)\b/i.test(outputText);`;
  const repairedGuard = cancellationReplyGuard.parameters.jsCode.replace(
    /const containsOrderSuccessClaim = \/[\s\S]*?;\n(?=if \(!placementStep && !handoffStep && session\.order_status === 'draft' && containsOrderSuccessClaim\) \{)/,
    `${correctedOrderSuccessClaim}\n`
  );
  if (repairedGuard === cancellationReplyGuard.parameters.jsCode) {
    throw new Error("Could not repair the order-success reply guard");
  }
  cancellationReplyGuard.parameters.jsCode = repairedGuard;
}

const pendingDealQuery = `WITH input_payload AS (
  SELECT $1::bigint AS deal_id,
         CASE WHEN jsonb_typeof($2::jsonb) = 'array' THEN $2::jsonb ELSE '[]'::jsonb END AS selected_components
),
locked_session AS (
  SELECT id
  FROM conversation_sessions
  WHERE customer_id = $3::bigint
  FOR UPDATE
),
deal AS (
  SELECT d.id, d.name
  FROM restaurant_deals d
  JOIN input_payload ip ON ip.deal_id = d.id
  WHERE d.active = TRUE
),
required AS (
  SELECT c.selection_group, c.component_label, c.quantity, c.size_label, c.allowed_item_rule, c.component_order
  FROM restaurant_deal_components c
  JOIN deal d ON d.id = c.deal_id
  WHERE c.selectable = TRUE
),
selection_rows AS (
  SELECT selection AS component
  FROM input_payload ip
  CROSS JOIN LATERAL jsonb_array_elements(ip.selected_components) AS raw(selection)
  WHERE jsonb_typeof(selection) = 'object'
),
choice_validity AS (
  SELECT sr.component,
         EXISTS (
           SELECT 1
           FROM required r
           JOIN restaurant_menu_items choice
             ON choice.active = TRUE
            AND LOWER(choice.name) = LOWER(sr.component->>'choice')
           WHERE r.selection_group = sr.component->>'selection_group'
             AND CASE
               WHEN r.allowed_item_rule->>'allowed' = 'any_active_pizza' THEN
                 choice.item_type LIKE 'pizza%'
                 AND EXISTS (
                   SELECT 1 FROM restaurant_menu_variants variant
                   WHERE variant.menu_item_id = choice.id
                     AND variant.active = TRUE
                     AND LOWER(variant.variant_label) = LOWER(COALESCE(r.allowed_item_rule->>'size', r.allowed_item_rule->>'size_label'))
                 )
               WHEN r.allowed_item_rule->>'allowed' = 'active_wing_items' THEN choice.name ILIKE '%wing%'
               WHEN r.allowed_item_rule->>'allowed' = 'active_sauces' THEN choice.item_type = 'sauce'
               WHEN jsonb_typeof(r.allowed_item_rule->'allowed_brands') = 'array' THEN
                 choice.item_type = 'drink'
                 AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements_text(r.allowed_item_rule->'allowed_brands') brand
                   WHERE LOWER(brand) = LOWER(choice.name)
                 )
                 AND EXISTS (
                   SELECT 1 FROM restaurant_menu_variants variant
                   WHERE variant.menu_item_id = choice.id
                     AND variant.active = TRUE
                     AND LOWER(variant.variant_label) = LOWER(COALESCE(r.allowed_item_rule->>'size', r.allowed_item_rule->>'size_label'))
                 )
               ELSE FALSE
             END
         ) AS valid
  FROM selection_rows sr
),
validation AS (
  SELECT EXISTS (SELECT 1 FROM deal)
      AND jsonb_array_length(ip.selected_components) = (SELECT COUNT(*) FROM selection_rows)
      AND (SELECT COUNT(DISTINCT component->>'selection_group') FROM selection_rows) = (SELECT COUNT(*) FROM selection_rows)
      AND (SELECT COUNT(*) FROM selection_rows) <= (SELECT COUNT(*) FROM required)
      AND NOT EXISTS (SELECT 1 FROM choice_validity WHERE NOT valid) AS valid
  FROM input_payload ip
),
required_context AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'selection_group', selection_group,
    'label', component_label,
    'quantity', quantity,
    'size_label', size_label,
    'allowed_item_rule', allowed_item_rule
  ) ORDER BY component_order), '[]'::jsonb) AS components
  FROM required
),
pending AS (
  UPDATE conversation_sessions cs
  SET pending_items = jsonb_build_array(jsonb_build_object(
        'kind', 'deal_configuration',
        'deal_id', d.id,
        'deal_name', d.name,
        'selected_components', COALESCE((SELECT jsonb_agg(component ORDER BY component->>'selection_group') FROM selection_rows), '[]'::jsonb),
        'required_components', rc.components
      )),
      updated_at = NOW()
  FROM locked_session ls
  CROSS JOIN deal d
  CROSS JOIN validation v
  CROSS JOIN required_context rc
  WHERE cs.id = ls.id AND v.valid
  RETURNING cs.pending_items
)
SELECT
  EXISTS (SELECT 1 FROM pending) AS pending_saved,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM deal) THEN 'deal_not_found'
    WHEN NOT (SELECT valid FROM validation) THEN 'invalid_deal_selection'
    ELSE NULL
  END AS error,
  COALESCE((SELECT pending_items FROM pending), '[]'::jsonb) AS pending_items,
  (SELECT components FROM required_context) AS required_components,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'selection_group', r.selection_group,
      'label', r.component_label,
      'quantity', r.quantity,
      'size_label', r.size_label,
      'allowed_item_rule', r.allowed_item_rule
    ) ORDER BY r.component_order)
    FROM required r
    WHERE NOT EXISTS (
      SELECT 1 FROM selection_rows sr
      WHERE sr.component->>'selection_group' = r.selection_group
    )
  ), '[]'::jsonb) AS missing_components
FROM validation;`;

const pendingNodeName = "Set Pending Deal Configuration";
const pendingNode = {
  id: "b6ae8b04-c60e-4d56-9aee-31cd2af3e24b",
  name: pendingNodeName,
  type: "n8n-nodes-base.postgresTool",
  typeVersion: 2.7,
  position: [3040, 528],
  parameters: {
    descriptionType: "manual",
    toolDescription: "Persist an incomplete configurable deal so later customer messages cannot lose already-confirmed choices. Use only after an exact live deal and every supplied choice have been identified. Supply the exact deal_id and a JSON array of zero or more exact {selection_group, choice} entries; include all previously confirmed choices every time. Every labeled selection group is an independent choice, even when two groups allow the same kind of item. The database validates each supplied choice and returns missing_components. Fixed sizes and non-selectable components are not inputs. Trust persistence only when pending_saved=true and error is null.",
    operation: "executeQuery",
    query: pendingDealQuery,
    options: {
      queryReplacement: "={{ [ $fromAI('deal_id', 'Exact active deal ID from RELEVANT_MENU or Menu Lookup', 'number'), $fromAI('selected_components_json', 'JSON array of all confirmed deal choices. Each entry is {selection_group, choice}; use [] when no customer choice is known yet.', 'string', '[]'), $('Upsert Customer and Session').item.json.customer_id ] }}",
    },
  },
  credentials: updateCart.credentials,
};

agent.parameters.options.systemMessage = systemMessage;
agent.parameters.options.maxIterations = 8;
updateCart.parameters.query = dealQuery;
updateCart.parameters.toolDescription = dealToolDescription;
updateCart.parameters.options.queryReplacement = dealToolInput;
loadActiveMenu.parameters.query = activeMenuQuery;
menuLookup.parameters.query = lookupQuery;
cancelOrder.parameters.query = cancelOrderQuery;
replaceDraftCart.parameters.query = replaceDraftCartQuery;

for (const [nodeName, propertyName, value] of [
  ["Pizza Ordering Agent", "systemMessage", agent.parameters.options.systemMessage],
  ["Pizza Ordering Agent", "maxIterations", agent.parameters.options.maxIterations],
  ["Update Cart", "query", updateCart.parameters.query],
  ["Update Cart", "toolDescription", updateCart.parameters.toolDescription],
  ["Update Cart", "queryReplacement", updateCart.parameters.options.queryReplacement],
  ["Load Active Menu", "query", loadActiveMenu.parameters.query],
  ["Menu Lookup", "query", menuLookup.parameters.query],
  ["Cancel Order", "query", cancelOrder.parameters.query],
  ["Replace Draft Cart", "query", replaceDraftCart.parameters.query],
  ["Guard Cancellation Reply", "jsCode", cancellationReplyGuard.parameters.jsCode],
  [pendingNodeName, "toolDescription", pendingNode.parameters.toolDescription],
  [pendingNodeName, "query", pendingNode.parameters.query],
  [pendingNodeName, "queryReplacement", pendingNode.parameters.options.queryReplacement],
]) {
  raw = replaceJsonPropertyInNode(raw, nodeName, propertyName, value);
}

raw = appendNode(raw, pendingNode);
raw = appendToolConnection(raw, pendingNodeName);
workflow = JSON.parse(raw);

const configuredAgent = find("Pizza Ordering Agent");
const configuredCart = find("Update Cart");
const configuredPending = find(pendingNodeName);
const configuredGuard = find("Guard Cancellation Reply");
if (!configuredAgent.parameters.options.systemMessage.includes("NO SIZE AMBIGUITY")) throw new Error("Deal prompt update failed");
if (!configuredCart.parameters.query.includes("invalid_or_incomplete_cart_operation")) throw new Error("Cart result contract update failed");
if (!configuredPending.parameters.query.includes("pending_saved")) throw new Error("Pending-deal tool update failed");
if (configuredGuard.parameters.jsCode.includes("\b")) throw new Error("Order-success reply guard contains control characters");
if (!workflow.connections[pendingNodeName]?.ai_tool) throw new Error("Pending-deal tool was not connected");

fs.writeFileSync(workflowPath, raw);
console.log(`Updated ${path.basename(workflowPath)} with deterministic deal selection safeguards.`);
