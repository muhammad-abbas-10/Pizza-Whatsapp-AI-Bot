const assert = require("assert/strict");
const vm = require("vm");
const { detectMessageLanguage } = require("../src/message-language");
const { loadWorkflow } = require("./workflow-fixture");

const workflow = loadWorkflow();
const node = (name) => {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert(found, `Missing workflow node ${name}`);
  return found;
};

const sequence = [
  ["Show me the menu.", "english"],
  ["menu dikhao", "roman_urdu"],
  ["I want the large pizza.", "english"],
  ["پیزا کتنے کا ہے؟", "urdu"],
  ["How long will delivery take?", "english"],
  ["زه یو لوی پیزا غواړم", "pashto"],
  ["Show me the pizza deals", "english"],
];

const history = [];
for (const [message, expected] of sequence) {
  assert.equal(detectMessageLanguage(message, history), expected, message);
  history.push({ role: "customer", text: message }, { role: "bot", text: "test" });
}

assert.equal(detectMessageLanguage("Can you mujhe menu bhej sakte ho?", history), "roman_urdu");
assert.equal(detectMessageLanguage("Yes, place the order.", [{ role: "customer", text: "پیزا چاہیے" }]), "english");
assert.equal(detectMessageLanguage("ok", [{ role: "customer", text: "پیزا چاہیے" }]), "urdu");
assert.equal(detectMessageLanguage("haan", [{ role: "customer", text: "Show menu" }]), "roman_urdu");

const router = node("Route Simple Messages");
assert(router.parameters.jsCode.includes(detectMessageLanguage.toString()));

function runRouter(message, recentMessages = []) {
  const claim = { combined_text: message, latest_text: message, batch_span_seconds: 0 };
  const input = [{ json: { marker: true } }];
  return vm.runInNewContext(`(function () { ${router.parameters.jsCode} })()`, {
    $: (name) => name === "Claim Latest Customer Turn"
      ? { item: { json: claim } }
      : { item: { json: { recent_messages: recentMessages } } },
    $input: { all: () => input },
  })[0].json;
}

assert.equal(runRouter("hello", [{ role: "customer", text: "پیزا چاہیے" }]).response_language, "english");
assert.match(runRouter("salam").reply_text, /Salam/);
assert.match(runRouter("سلام").reply_text, /پیزا بار/u);
assert.equal(runRouter("زه پیزا غواړم").response_language, "pashto");

const agent = node("Pizza Ordering Agent");
assert.match(agent.parameters.text, /LATEST message \(authoritative for response language\)/);
assert.match(agent.parameters.options.systemMessage, /Recent conversation is context only, never transactional truth/);
assert.match(agent.parameters.options.systemMessage, /Reply in the language\/style of the latest customer message/);
assert.doesNotMatch(node("Upsert Customer and Session").parameters.query, /customer\.preferred_language/);
assert(!workflow.nodes.some((entry) => /memory/i.test(entry.type)), "Unexpected AI memory node is connected");

console.log("Per-message English, Roman Urdu, Urdu, Pashto, mixed, short-message, and rapid-switch language routing: PASS");
