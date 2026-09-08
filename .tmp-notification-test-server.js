const http = require("http");

const now = new Date().toISOString();
const notifications = [
  { id: "126", notification_type: "customer_request", title: "Customer request #126", message: "Customer wants to cancel order 176.", request_id: "126", order_id: "176", customer_id: "1", read_at: null, created_at: now },
  { id: "127", notification_type: "customer_request", title: "Request B", message: "Second unread request", request_id: "127", order_id: "177", customer_id: "2", read_at: null, created_at: now },
  { id: "128", notification_type: "customer_request", title: "Request C", message: "Third unread request", request_id: "128", order_id: "178", customer_id: "3", read_at: null, created_at: now },
];

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "x-admin-key,content-type",
    "access-control-allow-methods": "GET,PATCH,POST,OPTIONS",
  });
  response.end(JSON.stringify(body));
}

http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "OPTIONS") return send(response, 204, {});
  if (request.method === "GET" && url.pathname === "/admin/session") {
    return send(response, 200, {
      restaurant: { restaurant_name: "Pizza Bar Test", currency: "PKR" },
      admin: { display_name: "Tester" },
      unread_notifications: notifications.filter((notification) => !notification.read_at).length,
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/activity") {
    return send(response, 200, {
      unread_notifications: notifications.filter((notification) => !notification.read_at).length,
      notifications_version: now,
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/notifications") {
    return send(response, 200, { notifications, pagination: { page: 1, limit: 30, total: notifications.length, pages: 1 } });
  }
  const readMatch = url.pathname.match(/^\/admin\/notifications\/(\d+)\/read$/);
  if (request.method === "PATCH" && readMatch) {
    const notification = notifications.find((item) => item.id === readMatch[1]);
    if (!notification) return send(response, 404, { message: "Not found" });
    notification.read_at ||= new Date().toISOString();
    return send(response, 200, { success: true, notification });
  }
  const orderMatch = url.pathname.match(/^\/admin\/orders\/(\d+)$/);
  if (request.method === "GET" && orderMatch) {
    return send(response, 200, {
      success: true,
      order: {
        id: orderMatch[1], customer_name: "Acceptance Customer", customer_phone: "+920000000000",
        order_type: "delivery", delivery_address: "Test address",
        items: [{ quantity: 1, item_name: "Pizza", size: "Regular", line_total: 1000 }],
        subtotal: 1000, delivery_charge: 0, total: 1000, status: "received", allowed_transitions: [], created_at: now,
      },
      history: [],
      notifications: [],
    });
  }
  return send(response, 404, { message: "Mock route not found" });
}).listen(3100, "127.0.0.1", () => console.log("mock notification API ready on 3100"));
