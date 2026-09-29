require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const root = path.resolve(__dirname, "../..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const issue = (kind, details) => ({ kind, ...details });

function workflowAudit() {
  const findings = [];
  const names = new Set(workflow.nodes.map((node) => node.name));
  for (const name of [
    "Pizza Ordering Agent",
    "Menu Lookup",
    "Load Active Menu",
    "Update Cart",
    "Set Pending Deal Configuration",
  ]) {
    if (!names.has(name)) findings.push(issue("missing_workflow_node", { name }));
  }

  const agent = workflow.nodes.find((node) => node.name === "Pizza Ordering Agent");
  if (agent) {
    const prompt = agent.parameters?.options?.systemMessage || "";
    if (!prompt.includes("NO SIZE AMBIGUITY")) findings.push(issue("missing_fixed_deal_variant_rule", {}));
    if (!prompt.includes("SESSION.pending_items")) findings.push(issue("missing_pending_deal_rule", {}));
    if (!prompt.includes("independent required choice")) findings.push(issue("missing_multi_slot_deal_rule", {}));
    if (agent.parameters?.options?.maxIterations < 8) findings.push(issue("insufficient_agent_tool_iterations", { value: agent.parameters?.options?.maxIterations }));
  }

  const cart = workflow.nodes.find((node) => node.name === "Update Cart");
  if (cart) {
    const sql = cart.parameters?.query || "";
    if (!/mutation_valid AS/.test(sql) || !/invalid_or_incomplete_cart_operation/.test(sql)) {
      findings.push(issue("non_atomic_deal_cart_mutation", {}));
    }
  }

  if (!workflow.connections["Set Pending Deal Configuration"]?.ai_tool) {
    findings.push(issue("unconnected_pending_deal_tool", {}));
  }
  return findings;
}

function candidateMatches(component, item) {
  const rule = component.allowed_item_rule || {};
  const requiredSize = String(rule.size || rule.size_label || "").toLowerCase();
  const variants = item.variants.map((variant) => String(variant || "").toLowerCase());
  const hasRequiredSize = !requiredSize || variants.includes(requiredSize);

  if (rule.allowed === "any_active_pizza") return item.item_type.startsWith("pizza") && hasRequiredSize;
  if (rule.allowed === "active_wing_items") return item.name.toLowerCase().includes("wing");
  if (rule.allowed === "active_sauces") return item.item_type === "sauce";
  if (Array.isArray(rule.allowed_brands)) {
    return item.item_type === "drink"
      && rule.allowed_brands.some((brand) => String(brand).toLowerCase() === item.name.toLowerCase())
      && hasRequiredSize;
  }
  return false;
}

async function databaseAudit() {
  const findings = [];
  const client = await pool.connect();
  try {
    const itemRows = await client.query(`
        SELECT i.id, i.name, i.item_type,
               COALESCE(array_agg(v.variant_label ORDER BY v.sort_order, v.id) FILTER (WHERE v.active), ARRAY[]::text[]) AS variants
        FROM restaurant_menu_items i
        LEFT JOIN restaurant_menu_variants v ON v.menu_item_id = i.id
        WHERE i.active = TRUE
        GROUP BY i.id, i.name, i.item_type
      `);
    const componentRows = await client.query(`
        SELECT d.id AS deal_id, d.name AS deal_name, c.component_order, c.component_type,
               c.quantity, c.selection_group, c.component_label, c.selectable, c.size_label, c.allowed_item_rule
        FROM restaurant_deals d
        JOIN restaurant_deal_components c ON c.deal_id = d.id
        WHERE d.active = TRUE
        ORDER BY d.id, c.component_order
      `);
    const dealRows = await client.query(`SELECT id, name, aliases FROM active_restaurant_menu_for_ai WHERE record_type = 'deal'`);
    const aliasRows = await client.query(`
        SELECT i.name, alias.alias
        FROM restaurant_menu_aliases alias
        JOIN restaurant_menu_items i ON i.id = alias.menu_item_id
        WHERE i.active = TRUE
      `);
    const orphanVariants = await client.query(`
        SELECT i.id, i.name
        FROM restaurant_menu_items i
        WHERE i.active = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM restaurant_menu_variants v
            WHERE v.menu_item_id = i.id AND v.active = TRUE
          )
      `);

    const items = itemRows.rows.map((row) => ({ ...row, variants: row.variants || [] }));
    const byNormalizedName = new Map();
    for (const item of items) {
      const key = normalize(item.name);
      if (!byNormalizedName.has(key)) byNormalizedName.set(key, []);
      byNormalizedName.get(key).push(item.name);
    }
    for (const [normalized, names] of byNormalizedName) {
      if (names.length > 1) findings.push(issue("duplicate_normalized_item_name", { normalized, names }));
    }

    const aliasOwners = new Map();
    for (const aliasRow of aliasRows.rows) {
      const key = normalize(aliasRow.alias);
      if (!key) continue;
      if (!aliasOwners.has(key)) aliasOwners.set(key, new Set());
      aliasOwners.get(key).add(aliasRow.name);
    }
    for (const [normalized, owners] of aliasOwners) {
      if (owners.size > 1) findings.push(issue("ambiguous_menu_alias", { normalized, owners: [...owners].sort() }));
    }

    for (const row of orphanVariants.rows) findings.push(issue("active_item_without_variant", { name: row.name }));

    const componentsByDeal = new Map();
    for (const component of componentRows.rows) {
      if (!componentsByDeal.has(component.deal_id)) componentsByDeal.set(component.deal_id, []);
      componentsByDeal.get(component.deal_id).push(component);

      if (!component.selectable) continue;
      const candidates = items.filter((item) => candidateMatches(component, item));
      if (!component.selection_group) {
        findings.push(issue("selectable_component_without_group", { deal: component.deal_name, label: component.component_label }));
      }
      if (!candidates.length) {
        findings.push(issue("selectable_component_without_live_choice", {
          deal: component.deal_name,
          label: component.component_label,
          rule: component.allowed_item_rule,
        }));
      }
      if (["pizza", "drink", "dip"].includes(component.component_type) && Number(component.quantity) > 1) {
        findings.push(issue("multi_quantity_single_choice_component", {
          deal: component.deal_name,
          label: component.component_label,
          quantity: Number(component.quantity),
          selection_group: component.selection_group,
        }));
      }
    }

    for (const components of componentsByDeal.values()) {
      const groups = new Map();
      for (const component of components.filter((entry) => entry.selectable)) {
        if (!groups.has(component.selection_group)) groups.set(component.selection_group, []);
        groups.get(component.selection_group).push(component.component_label);
      }
      for (const [selectionGroup, labels] of groups) {
        if (labels.length > 1) findings.push(issue("duplicate_selection_group", {
          deal: components[0].deal_name,
          selection_group: selectionGroup,
          labels,
        }));
      }
    }

    const dealTokens = new Map();
    for (const deal of dealRows.rows) {
      const tokens = [deal.name, ...(deal.aliases || [])];
      for (const token of tokens) {
        const normalized = normalize(token);
        if (!normalized) continue;
        if (!dealTokens.has(normalized)) dealTokens.set(normalized, new Set());
        dealTokens.get(normalized).add(deal.name);
      }
    }
    for (const [normalized, names] of dealTokens) {
      if (names.size > 1) findings.push(issue("ambiguous_deal_alias", { normalized, names: [...names].sort() }));
    }

  } finally {
    client.release();
  }
  return findings;
}

async function main() {
  const findings = [...workflowAudit(), ...(await databaseAudit())];
  if (findings.length) {
    console.error(JSON.stringify({ status: "ambiguous", findings }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log("Ordering ambiguity audit: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
