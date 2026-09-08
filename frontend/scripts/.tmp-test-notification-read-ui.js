import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const loadStart = source.indexOf("async function loadNotifications");
const renderStart = source.indexOf("\nfunction renderNotification", loadStart);
const renderEnd = source.indexOf("\nasync function loadSettings", renderStart);
const snippet = source.slice(loadStart, renderEnd);

const persisted = [
  { id: "126", notification_type: "customer_request", title: "Customer request #126", message: "Customer wants to cancel order 176.", request_id: "126", order_id: "176", read_at: null, created_at: new Date().toISOString() },
  { id: "127", notification_type: "customer_request", title: "Request B", message: "Second unread request", request_id: "127", order_id: "177", read_at: null, created_at: new Date().toISOString() },
  { id: "128", notification_type: "customer_request", title: "Request C", message: "Third unread request", request_id: "128", order_id: "178", read_at: null, created_at: new Date().toISOString() },
];
const patchCalls = [];
let detailsOpenedFor = null;
let activityRefreshes = 0;
let currentRows = [];

class NotificationRow {
  constructor(notification) {
    this.dataset = {
      notificationId: notification.id,
      readAt: notification.read_at || "",
      orderId: notification.order_id || "",
      requestId: notification.request_id || "",
    };
    this.unread = !notification.read_at;
    this.hasMarker = !notification.read_at;
    this.listener = null;
    this.classList = { remove: (name) => { if (name === "unread") this.unread = false; } };
  }

  addEventListener(type, listener) {
    if (type === "click") this.listener = listener;
  }

  querySelector(selector) {
    if (selector !== ".unread-mark" || !this.hasMarker) return null;
    return { remove: () => { this.hasMarker = false; } };
  }

  click() {
    return this.listener();
  }
}

const pageContent = {
  set innerHTML(_value) {
    currentRows = persisted.map((notification) => new NotificationRow(notification));
  },
};
const readAll = { addEventListener() {} };
const app = {
  querySelector(selector) {
    if (selector === "#page-content") return pageContent;
    if (selector === "[data-action='read-all']") return readAll;
    return null;
  },
  querySelectorAll(selector) {
    return selector === "[data-notification-id]" ? currentRows : [];
  },
};

async function api(path, options = {}) {
  if (path.startsWith("/admin/notifications?") && (!options.method || options.method === "GET")) {
    return { notifications: persisted, pagination: { page: 1, limit: 30, total: 3, pages: 1 } };
  }
  const match = path.match(/^\/admin\/notifications\/(\d+)\/read$/);
  if (options.method === "PATCH" && match) {
    patchCalls.push(match[1]);
    const notification = persisted.find((item) => item.id === match[1]);
    notification.read_at ||= new Date().toISOString();
    return { success: true, notification };
  }
  throw new Error(`Unexpected API call: ${path}`);
}

const context = vm.createContext({
  app,
  api,
  bindCommonActions() {},
  bindFilterControls() {},
  Date,
  emptyState: () => "",
  escapeHtml: (value) => String(value ?? ""),
  openOrder: (id) => { detailsOpenedFor = id; },
  navigate: () => {},
  pageHeading: () => "",
  pageLoadId: 1,
  pagination: () => "",
  queryString: () => "?page=1&limit=30",
  refreshActivity: async () => { activityRefreshes += 1; },
  relativeTime: () => "now",
  state: { route: "notifications", pages: { notifications: 1 }, filters: { notifications: { unread: "", type: "" } } },
  toast() {},
});
vm.runInContext(`${snippet}\nglobalThis.__loadNotifications = loadNotifications;`, context);

await context.__loadNotifications({ loadId: 1 });
assert.deepEqual(currentRows.map((row) => row.unread), [true, true, true]);

await currentRows[0].click();
assert.equal(detailsOpenedFor, "176", "the existing detail flow should still open");
assert.deepEqual(patchCalls, ["126"], "only the viewed notification should be persisted as read");
assert.equal(currentRows[0].unread, false, "the viewed row should lose its unread class immediately");
assert.equal(currentRows[0].hasMarker, false, "the viewed row should lose its orange marker immediately");
assert.deepEqual(currentRows.slice(1).map((row) => row.unread), [true, true], "other notifications should remain unread");
assert.equal(activityRefreshes, 1, "the unread-count refresh should be requested");

await context.__loadNotifications({ loadId: 1 });
assert.deepEqual(currentRows.map((row) => row.unread), [false, true, true], "the read state should survive a page reload");
assert.deepEqual(currentRows.map((row) => row.hasMarker), [false, true, true]);

console.log("Notification read UI synchronization acceptance test: PASS");
