const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
const backend = fs.readFileSync(path.join(root, "backend/src/admin-routes.js"), "utf8");
const frontend = fs.readFileSync(path.join(root, "frontend/src/main.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "database/migration/019_admin_address_clarification.sql"), "utf8");

const find = (name) => workflow.nodes.find((entry) => entry.name === name);

assert(backend.includes('/admin/orders/:id/address-clarification'));
assert(backend.includes('admin_address_clarification:${orderId}:${requestId}'));
assert(backend.includes('SELECT id, customer_id, order_type, status FROM orders WHERE id = $1 FOR UPDATE'));
assert(!backend.includes("graph.facebook.com"), "Backend must not send directly to WhatsApp");
assert(frontend.includes('Address Not Clear'));
assert(frontend.includes('Send to Customer'));
assert(frontend.includes('admin_message: adminMessage'));
assert(!frontend.includes('WHATSAPP_TOKEN'));
assert(migration.includes("'admin_address_clarification'"));
assert(migration.includes("delivery_status IN ('pending', 'processing')"));

const adminPrompt = find("Admin Customer Message Agent");
assert(adminPrompt.parameters.text.includes("admin_message:"));
assert(adminPrompt.parameters.options.systemMessage.includes("ADMIN-INITIATED ADDRESS CLARIFICATION"));
assert.equal((adminPrompt.parameters.options.systemMessage.match(/admin_address_clarification →/g) || []).length, 1);
assert.equal((adminPrompt.parameters.options.systemMessage.match(/ADMIN-INITIATED ADDRESS CLARIFICATION/g) || []).length, 1);
const customerPrompt = find("Pizza Ordering Agent").parameters.options.systemMessage;
assert(customerPrompt.includes("staff request for a clearer address"));
assert(customerPrompt.includes("Never create a new order"));

const safeCode = find("Build Safe Admin Customer Message").parameters.jsCode;
const build = new Function("$", "$input", safeCode);
const render = (preferredLanguage, output = "", recentMessages = []) => build(
  (name) => {
    assert.equal(name, "Claim Admin Customer Event");
    return { item: { json: {
      event_type: "admin_address_clarification",
      order_id: 194,
      preferred_language: preferredLanguage,
      recent_messages: recentMessages,
      admin_note: "Please provide a clearer delivery address.",
    } } };
  },
  { first: () => ({ json: { output } }) }
)[0].json;

for (const language of ["english", "roman_urdu", "urdu", "pashto"]) {
  const result = render(language);
  assert(result.customer_message.includes("194"));
  assert.equal(result.ai_fallback_used, true);
}
const safeEnglish = render("english", "Could you please share a clearer delivery address for Order #194, including a nearby landmark?");
assert.equal(safeEnglish.ai_fallback_used, false);
const leaked = render("english", "The admin dashboard says to clarify the address for Order #194.");
assert.equal(leaked.ai_fallback_used, true);

console.log("Admin address clarification UI, outbox, n8n isolation, language fallback, and reply-update rules: PASS");
