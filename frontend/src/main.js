import "./styles.css";
import { API_BASE, api, download, getAdminKey, setAdminKey } from "./api.js";
import {
  dateOnly, dateTime, escapeHtml, itemSummary, money, percentChange,
  queryString, relativeTime, statusLabel,
} from "./utils.js";

const app = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const toastRoot = document.querySelector("#toast-root");

const routes = {
  dashboard: { label: "Dashboard", icon: "◫", subtitle: "Live restaurant performance" },
  orders: { label: "Orders", icon: "▤", subtitle: "Active kitchen and delivery queue" },
  requests: { label: "Pending Requests", icon: "◉", subtitle: "Customer decisions requiring attention" },
  history: { label: "Order History", icon: "↺", subtitle: "Completed and cancelled orders" },
  customers: { label: "Customers", icon: "♙", subtitle: "Customer activity and spending" },
  feedback: { label: "Feedback", icon: "☆", subtitle: "Customer ratings from WhatsApp" },
  menu: { label: "Menu", icon: "♨", subtitle: "Products, deals, prices and availability" },
  notifications: { label: "Notifications", icon: "♢", subtitle: "Orders, requests and system events" },
  settings: { label: "Settings", icon: "⚙", subtitle: "Restaurant and admin configuration" },
};

const state = {
  route: "dashboard",
  session: null,
  sidebarOpen: false,
  dashboardDays: 7,
  pages: { orders: 1, requests: 1, history: 1, customers: 1, feedback: 1, notifications: 1 },
  filters: {
    orders: { search: "", status: "", order_type: "", date_from: "", date_to: "" },
    requests: { search: "", status: "", type: "" },
    history: { search: "", status: "", order_type: "", date_from: "", date_to: "" },
    customers: { search: "" },
    feedback: { rating: "" },
    notifications: { unread: "", type: "" },
    menu: { category: "All", search: "" },
  },
};

let searchTimer;
let pollTimer;

function initials(name) {
  const parts = String(name || "Customer").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "C";
}

function badge(status) {
  const safe = String(status || "neutral").replace(/[^a-z_]/g, "");
  return `<span class="badge badge-${safe || "neutral"}">${escapeHtml(statusLabel(status))}</span>`;
}

function toast(message, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type === "error" ? "error" : ""}`;
  element.innerHTML = `<span>${escapeHtml(message)}</span><button type="button" aria-label="Dismiss">×</button>`;
  element.querySelector("button").addEventListener("click", () => element.remove());
  toastRoot.append(element);
  setTimeout(() => element.remove(), 5000);
}

function showModal(content, options = {}) {
  modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.label || "Dialog")}">${content}</section></div>`;
  const backdrop = modalRoot.querySelector(".modal-backdrop");
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop && options.dismissible !== false) closeModal();
  });
  modalRoot.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
}

function closeModal() {
  modalRoot.innerHTML = "";
}

function modalLoading(label = "Loading details") {
  showModal(`<div class="loading-state"><div><div class="state-icon">◌</div><div class="state-title">${escapeHtml(label)}</div></div></div>`, { label });
}

function pageLoading() {
  return `<div class="loading-state"><div class="skeleton-wrap">${Array.from({ length: 5 }, () => '<div class="skeleton"></div>').join("")}</div></div>`;
}

function emptyState(title, copy, icon = "◇") {
  return `<div class="empty-state"><div><div class="state-icon">${icon}</div><div class="state-title">${escapeHtml(title)}</div><div class="state-copy">${escapeHtml(copy)}</div></div></div>`;
}

function errorState(message) {
  return `<div class="error-state"><div><div class="state-icon">!</div><div class="state-title">Unable to load this page</div><div class="state-copy">${escapeHtml(message)}</div><button class="btn" data-action="retry-page">Try again</button></div></div>`;
}

function pageHeading(title, copy, actions = "") {
  return `<header class="page-heading"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p></div>${actions ? `<div class="cluster">${actions}</div>` : ""}</header>`;
}

function pagination(meta, route) {
  if (!meta || meta.pages <= 1) return "";
  const first = (meta.page - 1) * meta.limit + 1;
  const last = Math.min(meta.page * meta.limit, meta.total);
  return `<div class="pagination"><span>Showing ${first}–${last} of ${meta.total}</span><div class="pagination-actions"><button class="btn btn-sm" data-page-route="${route}" data-page="${meta.page - 1}" ${meta.page <= 1 ? "disabled" : ""}>Previous</button><button class="btn btn-sm" data-page-route="${route}" data-page="${meta.page + 1}" ${meta.page >= meta.pages ? "disabled" : ""}>Next</button></div></div>`;
}

function renderLogin(message = "") {
  clearInterval(pollTimer);
  app.innerHTML = `<main class="login-page"><section class="login-card">
    <div class="brand"><div class="brand-mark">🍕</div><div><div class="brand-name">Pizza Bar</div><div class="brand-tag">AI ORDER MANAGEMENT</div></div></div>
    <h1>Welcome back</h1><p>Sign in with the private admin key configured on the Pizza Bar backend.</p>
    <form id="login-form" class="stack">
      <div class="field"><label for="admin-key">Admin key</label><input class="input" id="admin-key" name="adminKey" type="password" autocomplete="current-password" required placeholder="Enter your admin key"></div>
      ${message ? `<div class="danger-text" role="alert">${escapeHtml(message)}</div>` : ""}
      <button class="btn btn-primary btn-block" type="submit">Open dashboard</button>
    </form>
  </section></main>`;
  app.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    const key = new FormData(event.currentTarget).get("adminKey").trim();
    button.disabled = true;
    button.textContent = "Connecting…";
    setAdminKey(key);
    try {
      state.session = await api("/admin/session");
      renderShell();
      navigateFromHash();
      startPolling();
    } catch (error) {
      setAdminKey("");
      renderLogin(error.message);
    }
  });
}

function renderShell() {
  const restaurant = state.session?.restaurant?.restaurant_name || "Pizza Bar";
  const admin = state.session?.admin?.display_name || "Administrator";
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><div class="brand-mark">🍕</div><div><div class="brand-name">${escapeHtml(restaurant)}</div><div class="brand-tag">AI ORDER MANAGEMENT</div></div></div>
      <nav class="nav" aria-label="Main navigation">${Object.entries(routes).map(([key, route]) => `<button class="nav-link" data-route="${key}"><span class="nav-icon">${route.icon}</span><span>${escapeHtml(route.label)}</span>${key === "notifications" ? '<span class="nav-count" id="nav-unread" hidden>0</span>' : ""}</button>`).join("")}</nav>
      <div class="sidebar-footer"><div class="admin-profile"><div class="avatar">${escapeHtml(initials(admin))}</div><div><div class="admin-name">${escapeHtml(admin)}</div><div class="online">● Active</div></div><button class="btn btn-quiet icon-btn" data-action="logout" aria-label="Log out">↪</button></div></div>
    </aside>
    <div class="sidebar-scrim" id="sidebar-scrim"></div>
    <div class="main-shell">
      <header class="topbar">
        <button class="btn icon-btn mobile-menu" data-action="toggle-sidebar" aria-label="Open navigation">☰</button>
        <div class="topbar-title"><h1 id="topbar-title"></h1><p id="topbar-subtitle"></p></div>
        <div class="search-wrap" id="global-search-wrap"><span class="search-icon">⌕</span><label class="sr-only" for="global-search">Search</label><input class="input" id="global-search" type="search" placeholder="Search this page…"></div>
        <div class="top-actions"><button class="btn icon-btn notification-button" data-route="notifications" aria-label="Notifications">♢<span class="notification-dot" id="notification-dot" hidden></span></button><button class="btn admin-mini" data-route="settings"><span class="avatar" style="width:26px;height:26px;border-radius:7px;font-size:9px">${escapeHtml(initials(admin))}</span>${escapeHtml(admin)}</button></div>
      </header>
      <main class="page" id="page-content"></main>
    </div>
  </div>`;
  updateUnread(state.session?.unread_notifications || 0);
  bindShellEvents();
}

function bindShellEvents() {
  app.querySelectorAll("[data-route]").forEach((element) => element.addEventListener("click", () => navigate(element.dataset.route)));
  app.querySelector("[data-action='toggle-sidebar']").addEventListener("click", () => setSidebar(!state.sidebarOpen));
  app.querySelector("#sidebar-scrim").addEventListener("click", () => setSidebar(false));
  app.querySelector("[data-action='logout']").addEventListener("click", () => {
    setAdminKey("");
    state.session = null;
    renderLogin();
  });
  const search = app.querySelector("#global-search");
  search.addEventListener("input", () => {
    const routeFilters = state.filters[state.route];
    if (!routeFilters || !Object.prototype.hasOwnProperty.call(routeFilters, "search")) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      routeFilters.search = search.value.trim();
      if (state.pages[state.route]) state.pages[state.route] = 1;
      loadCurrentPage();
    }, 350);
  });
}

function setSidebar(open) {
  state.sidebarOpen = open;
  app.querySelector("#sidebar")?.classList.toggle("open", open);
  app.querySelector("#sidebar-scrim")?.classList.toggle("open", open);
}

function updateUnread(count) {
  const unread = Number(count || 0);
  const navCount = app.querySelector("#nav-unread");
  const dot = app.querySelector("#notification-dot");
  if (navCount) {
    navCount.textContent = unread > 99 ? "99+" : unread;
    navCount.hidden = unread === 0;
  }
  if (dot) dot.hidden = unread === 0;
}

function navigate(route) {
  if (!routes[route]) route = "dashboard";
  window.location.hash = route;
  if (state.route === route) navigateFromHash();
}

function navigateFromHash() {
  const route = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  state.route = routes[route] ? route : "dashboard";
  setSidebar(false);
  const config = routes[state.route];
  document.title = `${config.label} · Pizza Bar`;
  app.querySelector("#topbar-title").textContent = config.label;
  app.querySelector("#topbar-subtitle").textContent = config.subtitle;
  app.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item.dataset.route === state.route));
  const searchable = state.filters[state.route] && Object.prototype.hasOwnProperty.call(state.filters[state.route], "search");
  app.querySelector("#global-search-wrap").style.visibility = searchable ? "visible" : "hidden";
  const search = app.querySelector("#global-search");
  search.value = searchable ? state.filters[state.route].search : "";
  loadCurrentPage();
}

async function loadCurrentPage() {
  const content = app.querySelector("#page-content");
  if (!content) return;
  content.innerHTML = pageLoading();
  try {
    const loaders = {
      dashboard: loadDashboard, orders: () => loadOrders("orders"), requests: loadRequests,
      history: () => loadOrders("history"), customers: loadCustomers, feedback: loadFeedback,
      menu: loadMenu, notifications: loadNotifications, settings: loadSettings,
    };
    await loaders[state.route]();
  } catch (error) {
    content.innerHTML = errorState(error.message);
    content.querySelector("[data-action='retry-page']")?.addEventListener("click", loadCurrentPage);
  }
}

async function loadDashboard() {
  const data = await api(`/admin/dashboard?days=${state.dashboardDays}`);
  if (state.route !== "dashboard") return;
  const currency = state.session?.restaurant?.currency || "PKR";
  const orderTrend = percentChange(data.stats.today_orders, data.stats.previous_orders);
  const revenueTrend = percentChange(data.stats.today_revenue, data.stats.previous_revenue);
  const maxOrders = Math.max(1, ...data.activity.map((point) => Number(point.orders)));
  const statusMap = Object.fromEntries(data.status_counts.map((item) => [item.status, Number(item.count)]));
  const totalStatuses = Math.max(1, Object.values(statusMap).reduce((sum, count) => sum + count, 0));
  const statuses = ["received", "preparing", "out_for_delivery", "completed", "cancelled"];

  app.querySelector("#page-content").innerHTML = `${pageHeading("Restaurant overview", "Live operational data from the Pizza Bar backend and Neon database.")}
    <section class="stats-grid">
      ${statCard("Today's orders", data.stats.today_orders, "▤", orderTrend, "vs yesterday", "#f26a2e")}
      ${statCard("Pending requests", data.stats.pending_requests, "◉", null, "requires attention", "#e6a83c")}
      ${statCard("Today's revenue", money(data.stats.today_revenue, currency), "↗", revenueTrend, "vs yesterday", "#47b978")}
      ${statCard("Active customers", data.stats.active_customers, "♙", null, "in the last 24 hours", "#5d8ee2")}
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-head"><div><div class="panel-title">Order activity</div><div class="panel-subtitle">Daily orders in Pakistan time</div></div><div class="segmented">${[1,7,30].map((days) => `<button class="segment ${state.dashboardDays === days ? "active" : ""}" data-dashboard-days="${days}">${days === 1 ? "Today" : `${days} days`}</button>`).join("")}</div></div><div class="panel-body"><div class="chart">${data.activity.map((point) => `<div class="chart-column"><div class="chart-track"><span class="chart-value">${point.orders}</span><div class="chart-bar" style="height:${Math.max(2, Math.round(Number(point.orders) / maxOrders * 100))}%"></div></div><div class="chart-label">${escapeHtml(new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${point.day}T00:00:00Z`)))}</div></div>`).join("")}</div></div></article>
      <article class="panel"><div class="panel-head"><div><div class="panel-title">Order status</div><div class="panel-subtitle">All-time distribution</div></div></div><div class="panel-body"><div class="status-list">${statuses.map((status, index) => { const count = statusMap[status] || 0; const colors = ["#e6a83c", "#f26a2e", "#5d8ee2", "#47b978", "#e25d5d"]; return `<div class="status-row"><div><div class="status-meta"><span>${escapeHtml(statusLabel(status))}</span><span class="status-count">${count}</span></div><div class="status-track"><div class="status-fill" style="--status-color:${colors[index]};width:${Math.round(count / totalStatuses * 100)}%"></div></div></div></div>`; }).join("")}</div></div></article>
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-head"><div><div class="panel-title">Recent orders</div><div class="panel-subtitle">Latest WhatsApp orders</div></div><button class="btn btn-sm" data-route-jump="orders">View all</button></div>${renderCompactOrders(data.recent_orders, currency)}</article>
      <article class="panel"><div class="panel-head"><div><div class="panel-title">Pending requests</div><div class="panel-subtitle">Waiting for a staff decision</div></div><button class="btn btn-sm" data-route-jump="requests">View all</button></div>${renderDashboardRequests(data.pending_requests)}</article>
    </section>
    <section class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Recent feedback</div><div class="panel-subtitle">Latest customer ratings</div></div><button class="btn btn-sm" data-route-jump="feedback">View all</button></div>${renderFeedbackList(data.recent_feedback)}</section>`;
  app.querySelectorAll("[data-dashboard-days]").forEach((button) => button.addEventListener("click", () => { state.dashboardDays = Number(button.dataset.dashboardDays); loadCurrentPage(); }));
  bindCommonActions();
}

function statCard(label, value, icon, trend, trendCopy, color) {
  const trendClass = trend > 0 ? "up" : trend < 0 ? "down" : "";
  return `<article class="stat-card" style="--stat-color:${color};--tone:${color}15"><div class="stat-head"><span>${escapeHtml(label)}</span><span class="stat-icon">${icon}</span></div><div class="stat-value mono">${escapeHtml(value)}</div><div class="trend ${trendClass}">${trend === null ? "•" : `${trend >= 0 ? "↑" : "↓"} ${Math.abs(trend)}%`} <span class="muted">${escapeHtml(trendCopy)}</span></div></article>`;
}

function renderCompactOrders(orders, currency) {
  if (!orders.length) return emptyState("No orders yet", "Confirmed WhatsApp orders will appear here.", "▤");
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${orders.map((order) => `<tr><td class="primary-cell">#${escapeHtml(order.id)}</td><td>${escapeHtml(order.customer_name || order.customer_phone)}</td><td class="muted">${escapeHtml(itemSummary(order.items))}</td><td class="mono">${escapeHtml(money(order.total, currency))}</td><td>${badge(order.status)}</td><td><button class="btn btn-sm" data-view-order="${escapeHtml(order.id)}">View</button></td></tr>`).join("")}</tbody></table></div>`;
}

function renderDashboardRequests(requests) {
  if (!requests.length) return emptyState("You're all caught up", "There are no pending customer requests.", "✓");
  return `<div>${requests.map((request) => `<div class="feedback-card"><div class="split"><div class="primary-cell">${escapeHtml(request.customer_name || request.customer_phone)}</div>${badge(request.status)}</div><div class="feedback-message">${escapeHtml(request.question)}</div><div class="split"><span class="subtle">${escapeHtml(relativeTime(request.created_at))}</span><button class="btn btn-sm" data-route-jump="requests">Review</button></div></div>`).join("")}</div>`;
}

async function loadOrders(route) {
  const filters = state.filters[route];
  const params = { ...filters, page: state.pages[route], limit: 20, scope: route === "history" ? "history" : "active" };
  const data = await api(`/admin/orders${queryString(params)}`);
  if (state.route !== route) return;
  const history = route === "history";
  const currency = state.session?.restaurant?.currency || "PKR";
  const actions = history ? '<button class="btn" data-action="export-history">⇩ Export CSV</button>' : "";
  app.querySelector("#page-content").innerHTML = `${pageHeading(history ? "Order history" : "Orders", history ? "Search completed and cancelled orders." : "Manage orders currently moving through the kitchen.", actions)}
    <div class="toolbar"><input class="input mobile-page-search" data-local-search="${route}" type="search" value="${escapeHtml(filters.search)}" placeholder="Search order, customer or phone…">
      <select class="select" data-filter="status"><option value="">All statuses</option>${(history ? ["completed", "cancelled"] : ["received", "preparing", "out_for_delivery"]).map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${escapeHtml(statusLabel(status))}</option>`).join("")}</select>
      <select class="select" data-filter="order_type"><option value="">Delivery & pickup</option><option value="delivery" ${filters.order_type === "delivery" ? "selected" : ""}>Delivery</option><option value="pickup" ${filters.order_type === "pickup" ? "selected" : ""}>Pickup</option></select>
      <input class="input date-field" data-filter="date_from" type="date" value="${escapeHtml(filters.date_from)}" aria-label="From date"><input class="input date-field" data-filter="date_to" type="date" value="${escapeHtml(filters.date_to)}" aria-label="To date">
    </div>
    <section class="panel">${data.orders.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th>Total</th><th>Type</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>${data.orders.map((order) => `<tr><td class="primary-cell">#${escapeHtml(order.id)}</td><td><div class="customer-cell"><div class="avatar">${escapeHtml(initials(order.customer_name))}</div><div><div class="primary-cell">${escapeHtml(order.customer_name || "Unnamed customer")}</div><div class="secondary-cell">${escapeHtml(order.customer_phone)}</div></div></div></td><td class="muted">${escapeHtml(itemSummary(order.items))}</td><td class="mono">${escapeHtml(money(order.total, currency))}</td><td>${escapeHtml(statusLabel(order.order_type))}</td><td>${badge(order.status)}</td><td>${escapeHtml(dateTime(order.created_at))}</td><td><div class="row-actions"><button class="btn btn-sm" data-view-order="${escapeHtml(order.id)}">View</button></div></td></tr>`).join("")}</tbody></table></div>${pagination(data.pagination, route)}` : emptyState(history ? "No historical orders found" : "No active orders found", "Try changing your search or filters.", "▤")}</section>`;
  bindFilterControls(route);
  bindLocalSearch(route);
  bindCommonActions();
  app.querySelector("[data-action='export-history']")?.addEventListener("click", async () => {
    try {
      await download(`/admin/order-history/export.csv${queryString({ date_from: filters.date_from, date_to: filters.date_to })}`, `pizza-bar-order-history-${new Date().toISOString().slice(0,10)}.csv`);
      toast("Order history exported.");
    } catch (error) { toast(error.message, "error"); }
  });
}

function bindFilterControls(route) {
  app.querySelectorAll("[data-filter]").forEach((control) => control.addEventListener("change", () => {
    state.filters[route][control.dataset.filter] = control.value;
    if (state.pages[route]) state.pages[route] = 1;
    loadCurrentPage();
  }));
}

function bindLocalSearch(route) {
  app.querySelector(`[data-local-search='${route}']`)?.addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters[route].search = event.target.value.trim();
      if (state.pages[route]) state.pages[route] = 1;
      loadCurrentPage();
    }, 350);
  });
}

async function openOrder(orderId) {
  modalLoading("Loading order");
  try {
    const data = await api(`/admin/orders/${orderId}`);
    const order = data.order;
    const currency = state.session?.restaurant?.currency || "PKR";
    const transitions = {
      received: [["preparing", "Start preparing"], ["cancelled", "Cancel order"]],
      preparing: [["out_for_delivery", "Mark out for delivery"], ["completed", "Mark delivered"], ["cancelled", "Cancel order"]],
      out_for_delivery: [["completed", "Mark delivered"], ["cancelled", "Cancel order"]],
    }[order.status] || [];
    const whatsapp = String(order.customer_phone || "").replace(/\D/g, "");
    showModal(`<div class="modal-head"><div><div class="request-number">ORDER #${escapeHtml(order.id)}</div><h2>${escapeHtml(order.customer_name || "Customer")}</h2></div><button class="btn icon-btn" data-close-modal aria-label="Close">×</button></div>
      <div class="modal-body stack"><div class="detail-grid">
        <div class="detail-block"><div class="fact-label">Customer</div><div class="fact-value">${escapeHtml(order.customer_name || "Unnamed")}<br>${escapeHtml(order.customer_phone)}</div></div>
        <div class="detail-block"><div class="fact-label">Fulfilment</div><div class="fact-value">${escapeHtml(statusLabel(order.order_type))}<br>${escapeHtml(order.delivery_address || "Pickup")}</div></div>
        <div class="detail-block wide"><div class="fact-label">Items</div><div class="line-items" style="margin-top:10px">${(order.items || []).map((item) => `<div class="line-item"><div><strong>${escapeHtml(item.quantity || 1)}× ${escapeHtml(item.item_name || item.name || "Item")}</strong><div class="secondary-cell">${escapeHtml(item.size || item.variant || "Standard")}${Array.isArray(item.extras) && item.extras.length ? ` · ${escapeHtml(item.extras.join(", "))}` : ""}</div></div><span>${escapeHtml(money(item.line_total || Number(item.price || 0) * Number(item.quantity || 1), currency))}</span></div>`).join("")}</div></div>
        <div class="detail-block"><div class="fact-label">Totals</div><div class="fact-value">Subtotal ${escapeHtml(money(order.subtotal, currency))}<br>Delivery ${escapeHtml(money(order.delivery_charge, currency))}<br><strong>Total ${escapeHtml(money(order.total, currency))}</strong></div></div>
        <div class="detail-block"><div class="fact-label">Status</div><div class="fact-value">${badge(order.status)}<br><span class="subtle">${escapeHtml(dateTime(order.created_at))}</span></div></div>
        <div class="detail-block wide"><div class="fact-label">Timeline</div><div class="timeline" style="margin-top:12px">${data.history.map((event) => `<div class="timeline-item"><span class="timeline-dot"></span><div><div class="primary-cell">${escapeHtml(statusLabel(event.status))}</div><div class="secondary-cell">${escapeHtml(dateTime(event.created_at))}</div></div></div>`).join("")}</div></div>
      </div></div>
      <div class="modal-foot"><a class="btn" href="https://wa.me/${escapeHtml(whatsapp)}" target="_blank" rel="noopener">Open WhatsApp</a>${transitions.map(([status, label]) => `<button class="btn ${status === "cancelled" ? "btn-danger" : "btn-primary"}" data-order-status="${status}" data-order-id="${escapeHtml(order.id)}">${escapeHtml(label)}</button>`).join("")}</div>`, { label: `Order ${order.id}` });
    modalRoot.querySelectorAll("[data-order-status]").forEach((button) => button.addEventListener("click", async () => {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "Updating…";
      try {
        await api(`/admin/orders/${button.dataset.orderId}/status`, { method: "PATCH", body: JSON.stringify({ status: button.dataset.orderStatus }) });
        toast(`Order #${button.dataset.orderId} marked ${statusLabel(button.dataset.orderStatus)}.`);
        closeModal();
        loadCurrentPage();
      } catch (error) { toast(error.message, "error"); button.disabled = false; button.textContent = original; }
    }));
  } catch (error) {
    showModal(`<div class="error-state"><div><div class="state-icon">!</div><div class="state-title">Order unavailable</div><div class="state-copy">${escapeHtml(error.message)}</div><button class="btn" data-close-modal>Close</button></div></div>`);
  }
}

async function loadRequests() {
  const filters = state.filters.requests;
  const data = await api(`/admin/requests${queryString({ ...filters, page: state.pages.requests, limit: 20 })}`);
  if (state.route !== "requests") return;
  const currency = state.session?.restaurant?.currency || "PKR";
  app.querySelector("#page-content").innerHTML = `${pageHeading("Pending requests", "Review and respond to requests from WhatsApp customers.")}
    <div class="toolbar"><input class="input mobile-page-search" data-local-search="requests" type="search" value="${escapeHtml(filters.search)}" placeholder="Search customer or request…"><select class="select" data-filter="status"><option value="">All statuses</option>${["pending","approved","denied"].map((value) => `<option value="${value}" ${filters.status === value ? "selected" : ""}>${escapeHtml(statusLabel(value))}</option>`).join("")}</select><select class="select" data-filter="type"><option value="">All request types</option><option value="cancel_order" ${filters.type === "cancel_order" ? "selected" : ""}>Cancellation</option><option value="modification" ${filters.type === "modification" ? "selected" : ""}>Modification</option><option value="delivery" ${filters.type === "delivery" ? "selected" : ""}>Delivery</option><option value="other" ${filters.type === "other" ? "selected" : ""}>Other</option></select></div>
    ${data.requests.length ? `<div class="request-grid">${data.requests.map((request) => renderRequestCard(request, currency)).join("")}</div>${pagination(data.pagination, "requests")}` : `<section class="panel">${emptyState("No requests found", "New customer requests from WhatsApp will appear here.", "✓")}</section>`}`;
  bindFilterControls("requests");
  bindLocalSearch("requests");
  bindCommonActions();
  app.querySelectorAll("[data-resolve-request]").forEach((button) => button.addEventListener("click", () => confirmRequest(button.dataset.requestId, button.dataset.resolveRequest)));
  app.querySelectorAll("[data-retry-request]").forEach((button) => button.addEventListener("click", () => retryNotification(button)));
}

function renderRequestCard(request, currency) {
  const cancellable = request.request_type !== "cancel_order" || Boolean(request.order_id);
  const typeLabel = ({ cancel_order: "Cancellation request", modification: "Order modification", delivery: "Delivery issue" })[request.request_type] || "Customer request";
  return `<article class="request-card"><div class="request-card-top"><div><div class="request-number">REQUEST #${escapeHtml(request.id)}</div><div class="request-type">${escapeHtml(typeLabel)}</div></div>${badge(request.status)}</div>
    <div class="request-question">${escapeHtml(request.question)}</div>
    <div class="request-facts"><div><div class="fact-label">Customer</div><div class="fact-value">${escapeHtml(request.customer_name || "Unnamed")}<br><span class="subtle">${escapeHtml(request.customer_phone)}</span></div></div><div><div class="fact-label">Order</div><div class="fact-value">${request.order_id ? `#${escapeHtml(request.order_id)}<br>${escapeHtml(itemSummary(request.order_items, 1))}` : "Not linked"}</div></div><div><div class="fact-label">Total</div><div class="fact-value">${request.order_total ? escapeHtml(money(request.order_total, currency)) : "—"}</div></div><div><div class="fact-label">Delivery</div><div class="fact-value">${escapeHtml(request.delivery_address || (request.order_type ? statusLabel(request.order_type) : "—"))}</div></div><div><div class="fact-label">Requested</div><div class="fact-value">${escapeHtml(relativeTime(request.created_at))}</div></div><div><div class="fact-label">Notification</div><div class="fact-value">${request.notification_sent ? '<span class="success-text">Sent</span>' : request.status === "pending" || !request.notification_error ? "Not sent" : '<span class="danger-text">Failed</span>'}</div></div></div>
    ${request.request_type === "cancel_order" && !cancellable && request.status === "pending" ? '<div class="notification-failure">Order is not linked — cancellation approval is unavailable. Deny or inspect the bot request first.</div>' : ""}
    ${request.status !== "pending" && !request.notification_sent && request.notification_error ? `<div class="notification-failure">Customer notification failed: ${escapeHtml(request.notification_error)}</div>` : ""}
    <div class="request-actions">${request.order_id ? `<button class="btn btn-sm" data-view-order="${escapeHtml(request.order_id)}">View order</button>` : ""}${request.status === "pending" ? `${cancellable ? `<button class="btn btn-primary btn-sm" data-resolve-request="approve" data-request-id="${escapeHtml(request.id)}">Approve</button>` : ""}<button class="btn btn-danger btn-sm" data-resolve-request="deny" data-request-id="${escapeHtml(request.id)}">Deny</button>` : !request.notification_sent ? `<button class="btn btn-sm" data-retry-request="${escapeHtml(request.id)}">Retry notification</button>` : ""}<span class="subtle" style="margin-left:auto">${escapeHtml(dateTime(request.created_at))}</span></div></article>`;
}

function confirmRequest(requestId, decision) {
  const action = decision === "approve" ? "Approve" : "Deny";
  showModal(`<form id="request-decision-form"><div class="modal-head"><h2>${action} request #${escapeHtml(requestId)}?</h2><button type="button" class="btn icon-btn" data-close-modal>×</button></div><div class="modal-body"><p class="muted" style="margin-top:0">This updates the database and attempts to notify the customer on WhatsApp.</p><div class="field"><label for="admin-note">Message to customer (optional)</label><textarea class="textarea" id="admin-note" name="admin_note" placeholder="Add a short explanation"></textarea></div></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancel</button><button type="submit" class="btn ${decision === "approve" ? "btn-primary" : "btn-danger"}">${action} request</button></div></form>`, { label: `${action} request` });
  modalRoot.querySelector("#request-decision-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[type='submit']");
    button.disabled = true;
    button.textContent = "Saving…";
    const note = new FormData(event.currentTarget).get("admin_note").trim();
    try {
      const result = await api(`/admin/requests/${requestId}/${decision}`, { method: "POST", body: JSON.stringify({ admin_note: note || undefined }) });
      closeModal();
      toast(result.whatsapp?.sent ? `Request ${decision}d and customer notified.` : `Request ${decision}d; customer notification needs retry.`, result.whatsapp?.sent ? "success" : "error");
      loadCurrentPage();
      refreshSession();
    } catch (error) { toast(error.message, "error"); button.disabled = false; button.textContent = `${action} request`; }
  });
}

async function retryNotification(button) {
  const id = button.dataset.retryRequest;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Retrying…";
  try {
    await api(`/admin/requests/${id}/notify`, { method: "POST" });
    toast("Customer notification sent.");
    loadCurrentPage();
  } catch (error) { toast(error.message, "error"); button.disabled = false; button.textContent = original; }
}

async function loadCustomers() {
  const data = await api(`/admin/customers${queryString({ search: state.filters.customers.search, page: state.pages.customers, limit: 20 })}`);
  if (state.route !== "customers") return;
  const currency = state.session?.restaurant?.currency || "PKR";
  app.querySelector("#page-content").innerHTML = `${pageHeading("Customers", "Real customer profiles aggregated from WhatsApp orders.")}
    <div class="toolbar"><input class="input mobile-page-search" data-local-search="customers" type="search" value="${escapeHtml(state.filters.customers.search)}" placeholder="Search name or phone…"></div>
    <section class="panel">${data.customers.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Total spending</th><th>Last order</th><th>Status</th><th></th></tr></thead><tbody>${data.customers.map((customer) => `<tr><td><div class="customer-cell"><div class="avatar">${escapeHtml(initials(customer.name))}</div><div class="primary-cell">${escapeHtml(customer.name || "Unnamed customer")}</div></div></td><td>${escapeHtml(customer.whatsapp_phone)}</td><td class="mono">${customer.total_orders}</td><td class="mono">${escapeHtml(money(customer.total_spending, currency))}</td><td>${escapeHtml(customer.last_order ? relativeTime(customer.last_order) : "No orders")}</td><td>${badge(customer.status)}</td><td><button class="btn btn-sm" data-view-customer="${escapeHtml(customer.id)}">View</button></td></tr>`).join("")}</tbody></table></div>${pagination(data.pagination, "customers")}` : emptyState("No customers found", "Customers are created by the WhatsApp ordering flow.", "♙")}</section>`;
  bindLocalSearch("customers");
  bindCommonActions();
}

async function openCustomer(customerId) {
  modalLoading("Loading customer");
  try {
    const data = await api(`/admin/customers/${customerId}`);
    const customer = data.customer;
    const currency = state.session?.restaurant?.currency || "PKR";
    showModal(`<div class="modal-head"><div><div class="request-number">CUSTOMER #${escapeHtml(customer.id)}</div><h2>${escapeHtml(customer.name || "Unnamed customer")}</h2></div><button class="btn icon-btn" data-close-modal>×</button></div><div class="modal-body stack"><div class="detail-grid"><div class="detail-block"><div class="fact-label">WhatsApp</div><div class="fact-value">${escapeHtml(customer.whatsapp_phone)}</div></div><div class="detail-block"><div class="fact-label">Language</div><div class="fact-value">${escapeHtml(customer.preferred_language || "Not recorded")}</div></div><div class="detail-block"><div class="fact-label">Total orders</div><div class="fact-value">${customer.total_orders}</div></div><div class="detail-block"><div class="fact-label">Total spending</div><div class="fact-value">${escapeHtml(money(customer.total_spending, currency))}</div></div></div><div><div class="panel-title" style="margin-bottom:10px">Recent orders</div>${data.orders.length ? `<div class="line-items">${data.orders.map((order) => `<button class="line-item btn btn-quiet" data-view-order="${escapeHtml(order.id)}"><span>#${escapeHtml(order.id)} · ${escapeHtml(itemSummary(order.items))}</span><span>${escapeHtml(money(order.total, currency))}</span></button>`).join("")}</div>` : '<div class="muted">No orders.</div>'}</div>${data.session ? `<div><div class="panel-title" style="margin-bottom:10px">Conversation state</div><div class="detail-block"><div class="fact-value">Bot status: ${escapeHtml(statusLabel(data.session.order_status))}<br>Last activity: ${escapeHtml(dateTime(data.session.updated_at))}<br>Human handoff: ${data.session.human_handoff || data.session.awaiting_human ? "Active" : "No"}</div></div></div>` : ""}</div><div class="modal-foot"><a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/${escapeHtml(String(customer.whatsapp_phone).replace(/\D/g, ""))}">Open WhatsApp</a></div>`, { label: "Customer details" });
    modalRoot.querySelectorAll("[data-view-order]").forEach((button) => button.addEventListener("click", () => openOrder(button.dataset.viewOrder)));
  } catch (error) { toast(error.message, "error"); closeModal(); }
}

async function loadFeedback() {
  const filters = state.filters.feedback;
  const data = await api(`/admin/feedback${queryString({ rating: filters.rating, page: state.pages.feedback, limit: 20 })}`);
  if (state.route !== "feedback") return;
  app.querySelector("#page-content").innerHTML = `${pageHeading("Feedback", "Customer ratings collected through the Pizza Bar backend.")}
    <section class="feedback-summary">${statCard("Average rating", `${Number(data.summary.average_rating).toFixed(1)} / 5`, "★", null, "all reviews", "#e6a83c")}${statCard("Total reviews", data.summary.total, "☆", null, "submitted feedback", "#5d8ee2")}${statCard("Five-star reviews", `${data.summary.five_star_percentage}%`, "✦", null, "of all reviews", "#47b978")}</section>
    <div class="toolbar"><select class="select" data-filter="rating"><option value="">All ratings</option>${[5,4,3,2,1].map((rating) => `<option value="${rating}" ${String(filters.rating) === String(rating) ? "selected" : ""}>${rating} stars</option>`).join("")}</select></div>
    <section class="panel">${data.feedback.length ? `${renderFeedbackList(data.feedback)}${pagination(data.pagination, "feedback")}` : emptyState("No feedback yet", "Ratings submitted through WhatsApp will appear here once the feedback workflow stores them.", "☆")}</section>`;
  bindFilterControls("feedback");
  bindCommonActions();
}

function renderFeedbackList(feedback) {
  if (!feedback.length) return emptyState("No feedback yet", "Customer reviews will appear here.", "☆");
  return `<div>${feedback.map((item) => `<article class="feedback-card"><div class="split"><div><div class="primary-cell">${escapeHtml(item.customer_name || item.customer_phone)}</div><div class="stars" aria-label="${item.rating} out of 5 stars">${"★".repeat(item.rating)}${"☆".repeat(5 - item.rating)}</div></div><span class="subtle">${escapeHtml(dateOnly(item.created_at))}</span></div><div class="feedback-message">${escapeHtml(item.message || "No written comment")}</div>${item.order_id ? `<button class="btn btn-sm" data-view-order="${escapeHtml(item.order_id)}">Order #${escapeHtml(item.order_id)}</button>` : ""}</article>`).join("")}</div>`;
}

async function loadMenu() {
  const data = await api("/admin/menu");
  if (state.route !== "menu") return;
  const search = state.filters.menu.search.toLowerCase();
  const allRecords = [...data.items.map((item) => ({ ...item, kind: "items" })), ...data.deals.map((deal) => ({ ...deal, kind: "deals", variants: [] }))];
  const categories = ["All", ...new Set(allRecords.map((record) => record.category))];
  if (!categories.includes(state.filters.menu.category)) state.filters.menu.category = "All";
  const records = allRecords.filter((record) => (state.filters.menu.category === "All" || record.category === state.filters.menu.category) && (!search || `${record.name} ${record.description || ""}`.toLowerCase().includes(search)));
  const currency = state.session?.restaurant?.currency || "PKR";
  app.querySelector("#page-content").innerHTML = `${pageHeading("Menu management", "Live products, variants, deals and images from Neon.", '<button class="btn btn-primary" data-action="add-menu-item">+ Add item</button>')}
    <div class="toolbar"><input class="input mobile-page-search" data-local-search="menu" type="search" value="${escapeHtml(state.filters.menu.search)}" placeholder="Search menu…"></div>
    <div class="category-tabs">${categories.map((category) => `<button class="category-tab ${state.filters.menu.category === category ? "active" : ""}" data-menu-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("")}</div>
    <div class="menu-layout"><section>${records.length ? `<div class="menu-grid">${records.map((record) => renderMenuCard(record, currency)).join("")}</div>` : `<div class="panel">${emptyState("No menu items found", "Try a different category or search term.", "♨")}</div>`}</section><aside class="panel menu-gallery"><div class="panel-head"><div><div class="panel-title">Menu images</div><div class="panel-subtitle">Stored in Neon BYTEA</div></div></div><div class="panel-body">${data.images.length ? data.images.map((image) => `<img class="menu-image" src="${escapeHtml(`${API_BASE}${image.url}`)}" alt="${escapeHtml(image.name)}" loading="lazy">`).join("") : `<div class="muted">No active images.</div>`}</div></aside></div>`;
  app.querySelectorAll("[data-menu-category]").forEach((button) => button.addEventListener("click", () => { state.filters.menu.category = button.dataset.menuCategory; loadCurrentPage(); }));
  bindLocalSearch("menu");
  app.querySelector("[data-action='add-menu-item']").addEventListener("click", openAddMenuItem);
  app.querySelectorAll("[data-toggle-menu]").forEach((button) => button.addEventListener("click", () => toggleMenuRecord(button)));
  app.querySelectorAll("[data-edit-price]").forEach((button) => button.addEventListener("click", () => editMenuPrice(button)));
}

function renderMenuCard(record, currency) {
  return `<article class="menu-card ${record.active ? "" : "disabled"}"><div class="split"><div><div class="request-number">${escapeHtml(record.category)} · ${escapeHtml(record.kind === "deals" ? "Deal" : record.item_type)}</div><h3>${escapeHtml(record.name)}</h3></div><button class="btn btn-sm ${record.active ? "" : "btn-primary"}" data-toggle-menu="${escapeHtml(record.id)}" data-menu-kind="${record.kind}" data-menu-active="${record.active}">${record.active ? "Available" : "Unavailable"}</button></div><p>${escapeHtml(record.description || "No description")}</p>${record.kind === "deals" ? `<div class="variant-row"><span>Deal price</span><button class="btn btn-sm" data-edit-price="${escapeHtml(record.id)}" data-menu-kind="deals" data-current-price="${record.price}">${escapeHtml(money(record.price, currency))}</button></div>` : `<div class="variant-list">${record.variants.map((variant) => `<div class="variant-row"><span>${escapeHtml(variant.label || "Standard")}</span><button class="btn btn-sm" data-edit-price="${escapeHtml(variant.id)}" data-item-id="${escapeHtml(record.id)}" data-menu-kind="variant" data-current-price="${variant.price}">${escapeHtml(money(variant.price, currency))}</button></div>`).join("")}</div>`}</article>`;
}

async function toggleMenuRecord(button) {
  const active = button.dataset.menuActive === "true";
  button.disabled = true;
  try {
    await api(`/admin/menu/${button.dataset.menuKind}/${button.dataset.toggleMenu}`, { method: "PATCH", body: JSON.stringify({ active: !active }) });
    toast(`Menu item marked ${active ? "unavailable" : "available"}.`);
    loadCurrentPage();
  } catch (error) { toast(error.message, "error"); button.disabled = false; }
}

function editMenuPrice(button) {
  const current = button.dataset.currentPrice;
  showModal(`<form id="price-form"><div class="modal-head"><h2>Update price</h2><button type="button" class="btn icon-btn" data-close-modal>×</button></div><div class="modal-body"><div class="field"><label for="menu-price">Price in PKR</label><input class="input" id="menu-price" name="price" type="number" min="0" step="1" value="${escapeHtml(current)}" required></div></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Save price</button></div></form>`, { label: "Update menu price" });
  modalRoot.querySelector("#price-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const price = Number(new FormData(event.currentTarget).get("price"));
    const path = button.dataset.menuKind === "variant" ? `/admin/menu/items/${button.dataset.itemId}/variants/${button.dataset.editPrice}` : `/admin/menu/deals/${button.dataset.editPrice}`;
    try {
      await api(path, { method: "PATCH", body: JSON.stringify({ price }) });
      closeModal(); toast("Menu price updated."); loadCurrentPage();
    } catch (error) { toast(error.message, "error"); }
  });
}

function openAddMenuItem() {
  showModal(`<form id="menu-item-form"><div class="modal-head"><h2>Add menu item</h2><button type="button" class="btn icon-btn" data-close-modal>×</button></div><div class="modal-body stack"><div class="detail-grid"><div class="field"><label for="new-name">Name</label><input class="input" id="new-name" name="name" required></div><div class="field"><label for="new-category">Category</label><input class="input" id="new-category" name="category" required placeholder="Pizzas"></div><div class="field"><label for="new-type">Item type</label><input class="input" id="new-type" name="item_type" required placeholder="pizza"></div><div class="field"><label for="new-variant">Variant</label><input class="input" id="new-variant" name="variant" placeholder="Regular"></div><div class="field"><label for="new-price">Price in PKR</label><input class="input" id="new-price" name="price" type="number" min="0" step="1" required></div><div class="field"><label for="new-unit">Unit</label><input class="input" id="new-unit" name="unit" value="serving" required></div></div><div class="field"><label for="new-description">Description</label><textarea class="textarea" id="new-description" name="description"></textarea></div></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary">Create item</button></div></form>`, { label: "Add menu item" });
  modalRoot.querySelector("#menu-item-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const submit = event.currentTarget.querySelector("[type='submit']");
    submit.disabled = true;
    try {
      await api("/admin/menu/items", { method: "POST", body: JSON.stringify({ category: values.category, item_type: values.item_type, name: values.name, description: values.description, variants: [{ label: values.variant, price: Number(values.price), unit: values.unit }] }) });
      closeModal(); toast("Menu item created."); loadCurrentPage();
    } catch (error) { toast(error.message, "error"); submit.disabled = false; }
  });
}

async function loadNotifications() {
  const filters = state.filters.notifications;
  const data = await api(`/admin/notifications${queryString({ ...filters, page: state.pages.notifications, limit: 30 })}`);
  if (state.route !== "notifications") return;
  app.querySelector("#page-content").innerHTML = `${pageHeading("Notifications", "Database-backed order, request and delivery events.", '<button class="btn" data-action="read-all">Mark all read</button>')}
    <div class="toolbar"><select class="select" data-filter="unread"><option value="">All notifications</option><option value="true" ${filters.unread === "true" ? "selected" : ""}>Unread only</option></select><select class="select" data-filter="type"><option value="">All types</option><option value="new_order" ${filters.type === "new_order" ? "selected" : ""}>New orders</option><option value="customer_request" ${filters.type === "customer_request" ? "selected" : ""}>Customer requests</option><option value="notification_failure" ${filters.type === "notification_failure" ? "selected" : ""}>Failures</option><option value="system" ${filters.type === "system" ? "selected" : ""}>System</option></select></div>
    <section class="panel">${data.notifications.length ? `<div class="notification-list">${data.notifications.map(renderNotification).join("")}</div>${pagination(data.pagination, "notifications")}` : emptyState("No notifications", "Operational events will appear here automatically.", "♢")}</section>`;
  bindFilterControls("notifications");
  bindCommonActions();
  app.querySelector("[data-action='read-all']").addEventListener("click", async () => {
    try { await api("/admin/notifications/read-all", { method: "POST" }); toast("All notifications marked read."); updateUnread(0); loadCurrentPage(); } catch (error) { toast(error.message, "error"); }
  });
  app.querySelectorAll("[data-notification-id]").forEach((item) => item.addEventListener("click", async () => {
    if (!item.dataset.readAt) await api(`/admin/notifications/${item.dataset.notificationId}/read`, { method: "PATCH" }).catch(() => {});
    if (item.dataset.orderId) openOrder(item.dataset.orderId);
    else if (item.dataset.requestId) navigate("requests");
    else { item.classList.remove("unread"); item.querySelector(".unread-mark")?.remove(); refreshSession(); }
  }));
}

function renderNotification(notification) {
  const icons = { new_order: "▤", customer_request: "◉", notification_failure: "!", system: "⚙" };
  return `<article class="notification-item ${notification.read_at ? "" : "unread"}" data-notification-id="${escapeHtml(notification.id)}" data-read-at="${escapeHtml(notification.read_at || "")}" data-order-id="${escapeHtml(notification.order_id || "")}" data-request-id="${escapeHtml(notification.request_id || "")}"><div class="notification-icon">${icons[notification.notification_type] || "♢"}</div><div><div class="notification-title">${escapeHtml(notification.title)}</div><div class="notification-message">${escapeHtml(notification.message)}</div><div class="secondary-cell">${escapeHtml(relativeTime(notification.created_at))}</div></div>${notification.read_at ? "" : '<span class="unread-mark"></span>'}</article>`;
}

async function loadSettings() {
  const data = await api("/admin/settings");
  if (state.route !== "settings") return;
  const restaurant = data.restaurant || {};
  const admin = data.admin || {};
  app.querySelector("#page-content").innerHTML = `${pageHeading("Settings", "Public restaurant configuration and integration health. Secrets stay on the backend.")}
    <form id="settings-form" class="settings-grid">
      <section class="panel settings-section"><h3>Restaurant information</h3><p>Used by the bot and admin dashboard.</p><div class="stack"><div class="field"><label for="restaurant-name">Restaurant name</label><input class="input" id="restaurant-name" name="restaurant_name" value="${escapeHtml(restaurant.restaurant_name)}" required></div><div class="detail-grid"><div class="field"><label for="currency">Currency</label><input class="input" id="currency" name="currency" value="${escapeHtml(restaurant.currency)}" maxlength="3" required></div><div class="field"><label for="delivery-charge">Delivery charge</label><input class="input" id="delivery-charge" name="delivery_charge" type="number" min="0" step="0.01" value="${escapeHtml(restaurant.delivery_charge)}" required></div></div><div class="field"><label for="opening-hours">Opening hours (JSON)</label><textarea class="textarea" id="opening-hours" name="opening_hours">${escapeHtml(JSON.stringify(restaurant.opening_hours || {}, null, 2))}</textarea></div></div></section>
      <section class="panel settings-section"><h3>Admin account</h3><p>The API key remains server-only and is never returned to this page.</p><div class="field"><label for="display-name">Display name</label><input class="input" id="display-name" name="display_name" value="${escapeHtml(admin.display_name)}" required></div><div class="integration-row"><div><div class="primary-cell">Authentication</div><div class="secondary-cell">Protected with x-admin-key</div></div>${badge("active")}</div></section>
      <section class="panel settings-section"><h3>WhatsApp bot</h3><p>Integration readiness without exposing tokens or phone identifiers.</p><div class="integration-row"><div><div class="primary-cell">Cloud API credentials</div><div class="secondary-cell">Configured on the backend</div></div>${badge(data.integrations.whatsapp_configured ? "active" : "inactive")}</div></section>
      <section class="panel settings-section"><h3>Notifications & security</h3><p>Lightweight polling keeps staff informed without another external service.</p><div class="integration-row"><div><div class="primary-cell">Refresh interval</div><div class="secondary-cell">Orders, requests and notifications</div></div><span>${data.integrations.polling_seconds}s</span></div><div class="integration-row"><div><div class="primary-cell">Database access</div><div class="secondary-cell">Backend only</div></div>${badge("active")}</div></section>
      <div><button class="btn btn-primary" type="submit">Save settings</button></div>
    </form>`;
  app.querySelector("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    let openingHours;
    try { openingHours = JSON.parse(values.opening_hours); } catch { toast("Opening hours must be valid JSON.", "error"); return; }
    const button = event.currentTarget.querySelector("[type='submit']");
    button.disabled = true;
    try {
      const result = await api("/admin/settings", { method: "PATCH", body: JSON.stringify({ ...values, delivery_charge: Number(values.delivery_charge), currency: values.currency.toUpperCase(), opening_hours: openingHours }) });
      state.session.restaurant = result.restaurant; state.session.admin = result.admin;
      toast("Settings saved."); renderShell(); navigateFromHash();
    } catch (error) { toast(error.message, "error"); button.disabled = false; }
  });
}

function bindCommonActions() {
  app.querySelectorAll("[data-route-jump]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.routeJump)));
  app.querySelectorAll("[data-view-order]").forEach((button) => button.addEventListener("click", () => openOrder(button.dataset.viewOrder)));
  app.querySelectorAll("[data-view-customer]").forEach((button) => button.addEventListener("click", () => openCustomer(button.dataset.viewCustomer)));
  app.querySelectorAll("[data-page-route]").forEach((button) => button.addEventListener("click", () => {
    state.pages[button.dataset.pageRoute] = Number(button.dataset.page);
    loadCurrentPage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
}

async function refreshSession() {
  if (!getAdminKey() || document.hidden) return;
  try {
    const session = await api("/admin/session");
    state.session = session;
    updateUnread(session.unread_notifications);
  } catch {
    // Page-level requests surface connection errors; background polling stays quiet.
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await refreshSession();
    if (!["dashboard", "orders", "requests", "notifications"].includes(state.route)) return;
    if (document.hidden || modalRoot.childElementCount || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    loadCurrentPage();
  }, 15000);
}

window.addEventListener("hashchange", () => state.session && navigateFromHash());
window.addEventListener("admin-auth-expired", () => {
  if (!state.session) return;
  setAdminKey("");
  state.session = null;
  renderLogin("Your admin session expired. Enter the admin key again.");
});
window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

async function boot() {
  if (!getAdminKey()) { renderLogin(); return; }
  try {
    state.session = await api("/admin/session");
    renderShell();
    navigateFromHash();
    startPolling();
  } catch {
    setAdminKey("");
    renderLogin("Enter the admin key to continue.");
  }
}

boot();
