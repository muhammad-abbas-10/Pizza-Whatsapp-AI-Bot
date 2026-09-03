require("dotenv").config();

const originalFetch = global.fetch;
const { sendWhatsAppMessage } = require("../src/admin-routes");

async function main() {
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const success = await sendWhatsAppMessage("+923001234567", "Test decision");
  const payload = JSON.parse(captured.options.body);
  if (!success.sent || success.messageId !== "wamid.test") throw new Error("Success response was not parsed");
  if (payload.to !== "923001234567" || payload.type !== "text" || payload.text.body !== "Test decision") {
    throw new Error("WhatsApp payload is invalid");
  }
  if (!captured.options.headers.Authorization.startsWith("Bearer ")) throw new Error("Authorization header missing");

  const invalid = await sendWhatsAppMessage("not-a-number", "Test decision");
  if (invalid.sent || invalid.reason !== "invalid_recipient") throw new Error("Invalid recipient was not rejected");

  global.fetch = async () => new Response(JSON.stringify({
    error: { message: "Mock provider rejection", type: "OAuthException", code: 100 },
  }), { status: 400, headers: { "content-type": "application/json" } });
  const failure = await sendWhatsAppMessage("923001234567", "Test decision");
  if (failure.sent || failure.message !== "Mock provider rejection" || !failure.reason.includes("whatsapp_http_400")) {
    throw new Error("Provider failure was not surfaced safely");
  }

  console.log("WhatsApp payload, success parsing, validation, and structured provider errors: passed");
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => { global.fetch = originalFetch; });
