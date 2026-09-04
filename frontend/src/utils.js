export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function money(value, currency = "PKR") {
  return new Intl.NumberFormat("en-PK", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(value || 0));
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateTime(value) {
  const date = validDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi",
  }).format(date);
}

export function dateOnly(value) {
  const date = validDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeZone: "Asia/Karachi" }).format(date);
}

export function relativeTime(value) {
  const date = validDate(value);
  if (!date) return "—";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const ranges = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [size, unit] of ranges) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, "second");
}

export function statusLabel(status) {
  return ({
    received: "Received", preparing: "Preparing", oven: "Oven", out_for_delivery: "Out for delivery",
    completed: "Delivered", cancelled: "Cancelled", approved: "Approved", denied: "Denied",
    pending: "Pending", active: "Active", inactive: "Inactive", delivery: "Delivery", pickup: "Pickup",
  })[status] || String(status || "Unknown").replaceAll("_", " ");
}

export function itemSummary(items, max = 2) {
  if (!Array.isArray(items) || !items.length) return "No item details";
  const labels = items.slice(0, max).map((item) => `${item.quantity || 1}× ${item.item_name || item.name || "Item"}`);
  if (items.length > max) labels.push(`+${items.length - max} more`);
  return labels.join(", ");
}

export function queryString(values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== "" && value !== null && value !== undefined) params.set(key, value);
  });
  const result = params.toString();
  return result ? `?${result}` : "";
}

export function percentChange(current, previous) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  if (!before) return now ? 100 : 0;
  return Math.round(((now - before) / before) * 100);
}
