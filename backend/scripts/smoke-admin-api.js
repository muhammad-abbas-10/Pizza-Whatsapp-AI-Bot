require("dotenv").config();

const baseUrl = process.env.SMOKE_API_URL || "http://localhost:3000";
const key = process.env.ADMIN_API_KEY;
const results = [];

async function check(name, path, options = {}, expected = 200) {
  const headers = { ...(options.headers || {}) };
  if (options.auth !== false) headers["x-admin-key"] = key;
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (response.status !== expected) {
    throw new Error(`${name}: expected ${expected}, received ${response.status} (${body?.message || body})`);
  }
  results.push(`${name}: ${response.status}`);
  return body;
}

async function main() {
  await check("Health", "/health", { auth: false });
  await check("Authentication rejection", "/admin/session", { auth: false }, 401);
  await check("CORS rejection", "/admin/session", { auth: false, headers: { Origin: "https://untrusted.example" } }, 403);
  await check("Session", "/admin/session");
  await check("Dashboard", "/admin/dashboard?days=7");
  await check("Invalid order date", "/admin/orders?date_from=2026-02-30", {}, 400);
  await check("Invalid order date range", "/admin/orders?date_from=2026-02-02&date_to=2026-02-01", {}, 400);
  const orders = await check("Orders filters", "/admin/orders?scope=active&page=1&limit=2&search=Abbas");
  if (orders.orders[0]) await check("Order details", `/admin/orders/${orders.orders[0].id}`);
  await check("Invalid order status", "/admin/orders/1/status", { method: "PATCH", body: JSON.stringify({ status: "not-a-status" }) }, 400);
  await check("Order history", "/admin/orders?scope=history&page=1&limit=10");
  await check("Order history export", "/admin/order-history/export.csv");
  const requests = await check("Requests", "/admin/requests?page=1&limit=10");
  if (requests.requests[0]) await check("Request details", `/admin/requests/${requests.requests[0].id}`);
  await check("Invalid request details", "/admin/requests/not-a-number", {}, 400);
  await check("Missing request details", "/admin/requests/999999999", {}, 404);
  await check("Missing request decision", "/admin/requests/999999999/approve", { method: "POST", body: "{}" }, 404);
  await check("Missing notification retry", "/admin/requests/999999999/notify", { method: "POST" }, 404);
  const customers = await check("Customers", "/admin/customers?page=1&limit=10");
  if (customers.customers[0]) await check("Customer details", `/admin/customers/${customers.customers[0].id}`);
  await check("Feedback", "/admin/feedback?page=1&limit=10");
  await check("Feedback validation", "/admin/feedback", { method: "POST", body: "{}" }, 400);
  await check("Menu", "/admin/menu");
  await check("Menu validation", "/admin/menu/items", { method: "POST", body: "{}" }, 400);
  await check("Notifications", "/admin/notifications?page=1&limit=10");
  await check("Missing notification read", "/admin/notifications/999999999/read", { method: "PATCH" }, 404);
  await check("Notification filter validation", "/admin/notifications?type=invalid", {}, 400);
  await check("Settings", "/admin/settings");
  await check("Settings validation", "/admin/settings", { method: "PATCH", body: JSON.stringify({ currency: "INVALID" }) }, 400);
  await check("Settings opening-hours validation", "/admin/settings", { method: "PATCH", body: JSON.stringify({ opening_hours: [] }) }, 400);
  await check("Menu boolean validation", "/admin/menu/items/1", { method: "PATCH", body: JSON.stringify({ active: "true" }) }, 400);
  await check("Menu images", "/images", { auth: false });
  console.log(results.join("\n"));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
