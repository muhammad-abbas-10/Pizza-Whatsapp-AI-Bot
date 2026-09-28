const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { detectMessageLanguage } = require("../src/message-language");

const workflowPath = path.resolve(__dirname, "../../workflow.json");
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));

function find(name) {
  const node = workflow.nodes.find((entry) => entry.name === name);
  if (!node) throw new Error(`Missing workflow node: ${name}`);
  return node;
}

const upsertSession = find("Upsert Customer and Session");
upsertSession.parameters.query = upsertSession.parameters.query
  .replace("RETURNING id, whatsapp_phone, name, preferred_language", "RETURNING id, whatsapp_phone, name")
  .replace("    customer.preferred_language,\n", "");

const router = find("Route Simple Messages");
router.parameters.jsCode = `${detectMessageLanguage.toString()}
const claim = $('Claim Latest Customer Turn').item.json;
const session = $('Upsert Customer and Session').item.json || {};
const text = String(claim.combined_text || '').trim().toLowerCase();
const latest = String(claim.latest_text || text).trim();
const clean = (value) => String(value || '').toLowerCase().replace(/[!?.,]+/g, '').replace(/\\s+/g, ' ').trim();
const compact = clean(text);
const latestCompact = clean(latest);
const isGreeting = (value) => /^(hi|hii+|hy|hyy+|hello|hey|salam|salaam|assalam(?:\\s*[ou]\\s*alaikum)?|aoa|السلام علیکم|سلام)$/u.test(value);
const isHelp = (value) => /^(help|how to order|what can you do|options|madad|help karo|مدد|څنګه آرډر وکړم)$/u.test(value);
// The latest message controls response language. History is consulted only
// when that message is genuinely ambiguous (for example, "ok").
const response_language = detectMessageLanguage(latest, session.recent_messages);
const staleBacklog = Number(claim.batch_span_seconds || 0) > 15;
const greeting = isGreeting(compact) || (staleBacklog && isGreeting(latestCompact));
const help = isHelp(compact) || (staleBacklog && isHelp(latestCompact));
const replies = {
  english: {
    greeting: 'Hi! Welcome to Pizza Bar 🍕 What would you like to order today?',
    help: 'You can say: “show pizza deals”, “add a large Chicken Fajita”, “delivery”, “confirm my order”, or “cancel order”. 🍕',
  },
  roman_urdu: {
    greeting: 'Salam! Pizza Bar mein khush aamdeed 🍕 Aaj kya order karna hai?',
    help: 'Aap keh sakte hain: “pizza deals dikhao”, “large Chicken Fajita add karo”, “delivery”, “order confirm karo”, ya “order cancel karo”. 🍕',
  },
  urdu: {
    greeting: 'السلام علیکم! پیزا بار میں خوش آمدید 🍕 آج کیا آرڈر کرنا ہے؟',
    help: 'آپ کہہ سکتے ہیں: “پیزا ڈیلز دکھائیں”، “لارج چکن فجیٹا شامل کریں”، “ڈیلیوری”، “آرڈر کنفرم کریں”، یا “آرڈر منسوخ کریں”۔ 🍕',
  },
  pashto: {
    greeting: 'سلام! پیزا بار ته ښه راغلاست 🍕 نن څه آرډر کول غواړئ؟',
    help: 'تاسو ویلی شئ: “د پیزا ډیلونه وښایئ”، “لوی Chicken Fajita اضافه کړئ”، “ډیليوري”، “آرډر تایید کړئ”، یا “آرډر لغوه کړئ”. 🍕',
  },
};
const selected = replies[response_language] || replies.english;
let reply_text = '';
if (greeting) reply_text = selected.greeting;
if (help) reply_text = selected.help;
return $input.all().map((item) => ({ json: { ...item.json, fast_reply: greeting || help, reply_text, response_language, latest_customer_message: latest } }));`;

const agent = find("Pizza Ordering Agent");
agent.parameters.text = `=Customer's LATEST message (authoritative for response language): "{{ $('Claim Latest Customer Turn').item.json.latest_text }}"

Current batched messages (use for intent/context):
"{{ $('Claim Latest Customer Turn').item.json.combined_text }}"

Detected current response language:
{{ $('Route Simple Messages').item.json.response_language }}`;

const system = agent.parameters.options.systemMessage;
const languageStart = [
  system.indexOf("2. LANGUAGE — MANDATORY"),
  system.indexOf("2. LANGUAGE — CURRENT MESSAGE IS AUTHORITATIVE"),
].find((index) => index >= 0) ?? -1;
const languageEnd = system.indexOf("3. RESPONSE STYLE");
if (languageStart === -1 || languageEnd === -1 || languageEnd <= languageStart) {
  throw new Error("Could not locate Pizza Ordering Agent language section");
}
const languageSection = `2. LANGUAGE — CURRENT MESSAGE IS AUTHORITATIVE
==================================================

For EVERY turn, reply in the language/style of the customer's LATEST message.

LATEST_MESSAGE:
{{ $('Claim Latest Customer Turn').item.json.latest_text }}

DETECTED_CURRENT_LANGUAGE:
{{ $('Route Simple Messages').item.json.response_language }}

This per-turn detected language is authoritative for the response language:

* english → reply in English.
* roman_urdu → reply in Roman Urdu.
* urdu → reply in Urdu script.
* pashto → reply in Pashto.

Never let SESSION, preferred_language, RECENT_MESSAGES, an earlier customer
message, or an earlier bot response override a clear latest message.

The customer may switch languages on every message. Switch immediately with
them, even if the entire earlier conversation used another language.

Use RECENT_MESSAGES for order context and references, not to choose language
when LATEST_MESSAGE is linguistically clear.

Only when LATEST_MESSAGE is genuinely ambiguous (for example "ok", a number,
or an emoji) may the most recent clear customer language be used as fallback.

For mixed-language messages, use the dominant style of LATEST_MESSAGE. Do not
translate into another language unless the customer explicitly asks.

Examples:

* "Show me the menu" after Urdu history → English response.
* "menu dikhao" after English history → Roman Urdu response.
* "پیزا کتنے کا ہے؟" → Urdu-script response.
* "زه پیزا غواړم" → Pashto response.
* "Can you mujhe menu bhej sakte ho?" → Roman Urdu response.

Do not announce or explain language detection.

==================================================
`;
agent.parameters.options.systemMessage = `${system.slice(0, languageStart)}${languageSection}${system.slice(languageEnd)}`
  .replace(
    "3. Current SESSION state\n4. Current customer message\n5. Recent conversation context\n6. General conversational assumptions",
    "3. Current customer message (including its response language)\n4. Current SESSION state\n5. Recent conversation context\n6. General conversational assumptions"
  );

const feedbackThankYou = find("Build Feedback Thank You");
feedbackThankYou.parameters.jsCode = `${detectMessageLanguage.toString()}
const session = $('Upsert Customer and Session').item.json || {};
const source = String($('Claim Latest Customer Turn').item.json.latest_text || $('Claim Latest Customer Turn').item.json.combined_text || '');
const language = detectMessageLanguage(source, session.recent_messages);
const replies = {
  english: 'Thank you for your feedback! ❤️🍕 We really appreciate it.',
  roman_urdu: 'Aap ke feedback ka bohat shukriya! ❤️🍕 Hum iski bohat qadar karte hain.',
  urdu: 'آپ کی رائے کا بہت شکریہ! ❤️🍕 ہم واقعی اس کی قدر کرتے ہیں۔',
  pashto: 'ستاسو د نظر څخه مننه! ❤️🍕 موږ یې ډېر قدر کوو.',
};
return [{ json: { ...$input.first().json, reply_text: replies[language] || replies.english, response_language: language } }];`;

workflow.versionId = crypto.randomUUID();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Updated ${path.basename(workflowPath)} for per-message language switching.`);
