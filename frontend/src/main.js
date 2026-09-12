import "./styles.css";
import { API_BASE, api, clearApiCache, download, getAuthToken, isAbortError, setAuthToken } from "./api.js";
import {
  dateOnly, dateTime, escapeHtml, itemSummary, money, percentChange,
  queryString, relativeTime, statusLabel,
} from "./utils.js";

const app = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const toastRoot = document.querySelector("#toast-root");

const routes = {
  dashboard: { label: "Dashboard", icon: "dashboard", subtitle: "Live restaurant performance" },
  orders: { label: "Orders", icon: "orders", subtitle: "Active kitchen and delivery queue" },
  requests: { label: "Pending Requests", icon: "requests", subtitle: "Customer decisions requiring attention" },
  history: { label: "Order History", icon: "history", subtitle: "Completed and cancelled orders" },
  customers: { label: "Customers", icon: "customers", subtitle: "Customer activity and spending" },
  feedback: { label: "Feedback", icon: "feedback", subtitle: "Customer ratings from WhatsApp" },
  menu: { label: "Menu", icon: "menu", subtitle: "Products, deals, prices and availability" },
  notifications: { label: "Notifications", icon: "notifications", subtitle: "Orders, requests and system events" },
  settings: { label: "Settings", icon: "settings", subtitle: "Restaurant and admin configuration" },
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
let pollInFlight = false;
let pollController;
let pollingGeneration = 0;
let pageController;
let pageLoadId = 0;
let pageLoadInFlight = false;
let activitySnapshot = null;
let appEntryId = 0;
let dashboardDetailLoadId = 0;

const PAGE_CACHE_TTL = {
  dashboard: 10000,
  orders: 10000,
  requests: 10000,
  history: 15000,
  customers: 30000,
  feedback: 30000,
  menu: 10 * 60 * 1000,
  notifications: 5000,
  settings: 10 * 60 * 1000,
};

const DEFAULT_ADDRESS_CLARIFICATION_MESSAGE = "Please provide a clearer delivery address, including a nearby landmark, street, house number, or any other helpful location details.";

function initials(name) {
  const parts = String(name || "Customer").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "C";
}

const iconPaths = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  orders: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><path d="M9 12h6M9 16h6"/>',
  requests: '<path d="M18 8a6 6 0 1 1-6-6"/><path d="M18 2v6h-6M12 11v4M12 18h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  customers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  feedback: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2Z"/>',
  menu: '<path d="M4 3v18M4 8h3a3 3 0 0 0 0-6M14 3v8a3 3 0 0 0 6 0V3M17 3v18"/>',
  notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.83 2.83-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21h-4v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06-2.83-2.83.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3v-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06 2.83-2.83.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3h4v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06 2.83 2.83-.06.06A1.65 1.65 0 0 0 19.4 9c.12.6.6 1.06 1.2 1.17H21v4h-.4A1.65 1.65 0 0 0 19.4 15Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  download: '<path d="M12 3v14M6 11l6 6 6-6"/><path d="M5 21h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  menuToggle: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>',
  revenue: '<path d="M3 3v18h18M7 15l4-4 3 3 6-7"/><path d="M16 7h4v4"/>',
  alert: '<path d="M10.3 3.5 2.4 17.2A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.8L13.7 3.5a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
};

function icon(name, className = "ui-icon") {
  return `<svg class="${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] || iconPaths.dashboard}</svg>`;
}

function pizzaMark() {
  return '<svg class="pizza-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M4.3 19.7 20.1 4.1c-4-2.1-9.7-1.6-13.2 1.9-3.6 3.5-4.1 9.5-2.6 13.7Z" fill="currentColor" opacity=".95"/><path d="M20.1 4.1c.8 1 .8 2.4-.1 3.3L7.5 19.8c-.9.9-2.2.8-3.2-.1" stroke="white" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="10" r="1.35" fill="#E05600"/><circle cx="7.7" cy="14.2" r="1.2" fill="#E05600"/><path d="M13.8 6.3c.9.2 1.5.6 2.2 1.1" stroke="#E05600" stroke-width="1.6" stroke-linecap="round"/></svg>';
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
  const modalClass = String(options.className || "").replace(/[^a-z0-9_-]/gi, " ");
  modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal ${modalClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.label || "Dialog")}">${content}</section></div>`;
  const backdrop = modalRoot.querySelector(".modal-backdrop");
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop && options.dismissible !== false) closeModal();
  });
  modalRoot.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
}

function closeModal() {
  dashboardDetailLoadId += 1;
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
  return `<header class="page-heading"><div><div class="eyebrow-live"><span></span> LIVE · PAKISTAN TIME</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p></div>${actions ? `<div class="cluster">${actions}</div>` : ""}</header>`;
}

function pagination(meta, route) {
  if (!meta || meta.pages <= 1) return "";
  const first = (meta.page - 1) * meta.limit + 1;
  const last = Math.min(meta.page * meta.limit, meta.total);
  return `<div class="pagination"><span>Showing ${first}–${last} of ${meta.total}</span><div class="pagination-actions"><button class="btn btn-sm" data-page-route="${route}" data-page="${meta.page - 1}" ${meta.page <= 1 ? "disabled" : ""}>Previous</button><button class="btn btn-sm" data-page-route="${route}" data-page="${meta.page + 1}" ${meta.page >= meta.pages ? "disabled" : ""}>Next</button></div></div>`;
}

function renderLogin(message = "") {
  stopPolling();
  pageController?.abort();
  app.innerHTML = `<main class="login-page"><section class="login-card">
    <div class="brand"><div class="brand-mark">${pizzaMark()}</div><div><div class="brand-name">Pizza Bar</div><div class="brand-tag">ADMIN DASHBOARD</div></div></div>
    <h1>Welcome back</h1><p>Sign in to manage the Pizza Bar admin dashboard.</p>
    <form id="login-form" class="stack">
      <div class="field"><label for="admin-username">Username</label><input class="input" id="admin-username" name="username" autocomplete="username" required placeholder="Enter your username"></div>
      <div class="field"><label for="admin-password">Password</label><input class="input" id="admin-password" name="password" type="password" autocomplete="current-password" required placeholder="Enter your password"></div>
      ${message ? `<div class="danger-text" role="alert">${escapeHtml(message)}</div>` : ""}
      <button class="btn btn-primary btn-block" type="submit">Sign In</button>
    </form>
  </section></main>`;
  app.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      const result = await api("/admin/login", { method: "POST", body: JSON.stringify({ username: values.username.trim(), password: values.password }) });
      setAuthToken(result.token);
      await enterAuthenticatedApp();
    } catch (error) {
      renderLogin(error.message || "Invalid username or password.");
    }
  });
}

function renderShell() {
  const restaurant = state.session?.restaurant?.restaurant_name || "Pizza Bar";
  const admin = state.session?.admin?.display_name || "Administrator";
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><div class="brand-mark">${pizzaMark()}</div><div><div class="brand-name" data-restaurant-name>${escapeHtml(restaurant)}</div><div class="brand-tag">AI ORDER MANAGEMENT</div></div></div>
      <nav class="nav" aria-label="Main navigation">${Object.entries(routes).map(([key, route]) => `<button class="nav-link" data-route="${key}"><span class="nav-icon">${icon(route.icon)}</span><span>${escapeHtml(route.label)}</span>${key === "notifications" ? '<span class="nav-count" id="nav-unread" hidden>0</span>' : ""}</button>`).join("")}</nav>
      <div class="sidebar-footer"><div class="admin-profile"><div class="avatar" data-admin-avatar>${escapeHtml(initials(admin))}</div><div class="admin-details"><div class="admin-name" data-admin-name>${escapeHtml(admin)}</div><div class="online"><span></span> Active</div></div><button class="btn btn-quiet icon-btn" data-action="logout" aria-label="Log out">${icon("logout")}</button></div></div>
    </aside>
    <div class="sidebar-scrim" id="sidebar-scrim"></div>
    <div class="main-shell">
      <header class="topbar">
        <button class="btn icon-btn mobile-menu" data-action="toggle-sidebar" aria-label="Open navigation">${icon("menuToggle")}</button>
        <div class="topbar-title"><h1 id="topbar-title"></h1><p id="topbar-subtitle"></p></div>
        <div class="search-wrap" id="global-search-wrap"><span class="search-icon">${icon("search")}</span><label class="sr-only" for="global-search">Search</label><input class="input" id="global-search" type="search" placeholder="Search this page…"></div>
        <div class="top-actions"><span class="restaurant-online"><span></span> Restaurant online</span><button class="btn icon-btn notification-button" data-route="notifications" aria-label="Notifications">${icon("notifications")}<span class="notification-dot" id="notification-dot" hidden></span></button><button class="btn admin-mini" data-route="settings"><span class="avatar" data-admin-avatar style="width:28px;height:28px;border-radius:8px;font-size:9px">${escapeHtml(initials(admin))}</span><span class="admin-mini-copy"><strong data-admin-name>${escapeHtml(admin)}</strong><small>Administrator</small></span></button></div>
      </header>
      <main class="page" id="page-content"></main>
    </div>
  </div>`;
  updateUnread(state.session?.unread_notifications || 0);
  bindShellEvents();
  performance.mark?.("pizza-shell-visible");
}

function applySessionToShell() {
  const restaurant = state.session?.restaurant?.restaurant_name || "Pizza Bar";
  const admin = state.session?.admin?.display_name || "Administrator";
  app.querySelectorAll("[data-restaurant-name]").forEach((element) => { element.textContent = restaurant; });
  app.querySelectorAll("[data-admin-name]").forEach((element) => { element.textContent = admin; });
  app.querySelectorAll("[data-admin-avatar]").forEach((element) => { element.textContent = initials(admin); });
  updateUnread(state.session?.unread_notifications || 0);
}

function bindShellEvents() {
  app.querySelectorAll("[data-route]").forEach((element) => element.addEventListener("click", () => navigate(element.dataset.route)));
  app.querySelector("[data-action='toggle-sidebar']").addEventListener("click", () => setSidebar(!state.sidebarOpen));
  app.querySelector("#sidebar-scrim").addEventListener("click", () => setSidebar(false));
  app.querySelector("[data-action='logout']").addEventListener("click", async () => {
    appEntryId += 1;
    await api("/admin/logout", { method: "POST" }).catch(() => {});
    setAuthToken("");
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

async function loadCurrentPage({ background = false, forceRefresh = false } = {}) {
  const content = app.querySelector("#page-content");
  if (!content) return;
  const routeAtStart = state.route;
  const loadId = ++pageLoadId;
  pageController?.abort();
  pageController = new AbortController();
  pageLoadInFlight = true;
  if (!background && content.dataset.loadedRoute !== routeAtStart) content.innerHTML = pageLoading();

  const requestOptions = {
    signal: pageController.signal,
    loadId,
    cacheTtlMs: PAGE_CACHE_TTL[routeAtStart] || 10000,
    staleWhileRevalidate: !forceRefresh,
    forceRefresh,
    onRevalidate: () => {
      if (state.route === routeAtStart && loadId === pageLoadId) loadCurrentPage({ background: true });
    },
    onRevalidateError: (error) => {
      if (state.route === routeAtStart && loadId === pageLoadId) toast(error.message, "error");
    },
  };
  try {
    const loaders = {
      dashboard: loadDashboard, orders: (options) => loadOrders("orders", options), requests: loadRequests,
      history: (options) => loadOrders("history", options), customers: loadCustomers, feedback: loadFeedback,
      menu: loadMenu, notifications: loadNotifications, settings: loadSettings,
    };
    await loaders[routeAtStart](requestOptions);
    if (loadId !== pageLoadId || state.route !== routeAtStart) return;
    content.dataset.loadedRoute = routeAtStart;
    performance.mark?.(`pizza-page-${routeAtStart}-visible`);
  } catch (error) {
    if (isAbortError(error) || loadId !== pageLoadId || state.route !== routeAtStart) return;
    if (background && content.dataset.loadedRoute === routeAtStart) {
      toast(error.message, "error");
      return;
    }
    content.innerHTML = errorState(error.message);
    content.querySelector("[data-action='retry-page']")?.addEventListener("click", loadCurrentPage);
  } finally {
    if (loadId === pageLoadId) pageLoadInFlight = false;
  }
}

async function loadDashboard(requestOptions = {}) {
  const data = await api(`/admin/dashboard?days=${state.dashboardDays}`, requestOptions);
  if (state.route !== "dashboard" || requestOptions.loadId !== pageLoadId) return;
  const currency = state.session?.restaurant?.currency || "PKR";
  const orderTrend = percentChange(data.stats.today_orders, data.stats.previous_orders);
  const revenueTrend = percentChange(data.stats.today_revenue, data.stats.previous_revenue);
  const maxOrders = Math.max(1, ...data.activity.map((point) => Number(point.orders)));
  const statusMap = Object.fromEntries(data.status_counts.map((item) => [item.status, Number(item.count)]));
  const totalStatuses = Math.max(1, Object.values(statusMap).reduce((sum, count) => sum + count, 0));
  const statuses = ["received", "preparing", "oven", "out_for_delivery", "completed", "cancelled"];

  app.querySelector("#page-content").innerHTML = `${pageHeading("Restaurant overview", "Live view of Pizza Bar performance and status.")}
    <section class="stats-grid">
      ${statCard("Today's orders", data.stats.today_orders, "orders", orderTrend, "vs yesterday", "#FF6B00", "orders")}
      ${statCard("Pending requests", data.stats.pending_requests, "requests", null, "requires attention", "#F59E0B", "requests")}
      ${statCard("Today's revenue", money(data.stats.today_revenue, currency), "revenue", revenueTrend, "vs yesterday", "#10B981", "revenue")}
      ${statCard("Active customers", data.stats.active_customers, "customers", null, "in the last 24 hours", "#3B82F6", "customers")}
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-head"><div><div class="panel-title">Order activity</div><div class="panel-subtitle">Daily orders in Pakistan time</div></div><div class="segmented">${[1,7,30].map((days) => `<button class="segment ${state.dashboardDays === days ? "active" : ""}" data-dashboard-days="${days}">${days === 1 ? "Today" : `${days} days`}</button>`).join("")}</div></div><div class="panel-body"><div class="chart">${data.activity.map((point) => `<div class="chart-column"><div class="chart-track"><span class="chart-value">${point.orders}</span><div class="chart-bar" style="height:${Math.max(2, Math.round(Number(point.orders) / maxOrders * 100))}%"></div></div><div class="chart-label">${escapeHtml(new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${String(point.day).slice(0, 10)}T00:00:00Z`)))}</div></div>`).join("")}</div></div></article>
      <article class="panel"><div class="panel-head"><div><div class="panel-title">Order status</div><div class="panel-subtitle">All-time distribution</div></div></div><div class="panel-body"><div class="status-list">${statuses.map((status, index) => { const count = statusMap[status] || 0; const colors = ["#e6a83c", "#f26a2e", "#ef5b32", "#5d8ee2", "#47b978", "#e25d5d"]; return `<div class="status-row" data-dashboard-status="${status}"><div><div class="status-meta"><span>${escapeHtml(statusLabel(status))}</span><span class="status-count" data-status-count>${count}</span></div><div class="status-track"><div class="status-fill" data-status-fill style="--status-color:${colors[index]};width:${Math.round(count / totalStatuses * 100)}%"></div></div></div></div>`; }).join("")}</div></div></article>
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-head"><div><div class="panel-title">Recent orders</div><div class="panel-subtitle">Latest WhatsApp orders</div></div><button class="btn btn-sm" data-route-jump="orders">View all</button></div>${renderCompactOrders(data.recent_orders, currency)}</article>
      <article class="panel"><div class="panel-head"><div><div class="panel-title">Pending requests</div><div class="panel-subtitle">Waiting for a staff decision</div></div><button class="btn btn-sm" data-route-jump="requests">View all</button></div>${renderDashboardRequests(data.pending_requests)}</article>
    </section>
    <section class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Recent feedback</div><div class="panel-subtitle">Latest customer ratings</div></div><button class="btn btn-sm" data-route-jump="feedback">View all</button></div>${renderFeedbackList(data.recent_feedback)}</section>`;
  app.querySelectorAll("[data-dashboard-days]").forEach((button) => button.addEventListener("click", () => { state.dashboardDays = Number(button.dataset.dashboardDays); loadCurrentPage(); }));
  app.querySelectorAll("[data-dashboard-detail]").forEach((button) => button.addEventListener("click", () => openDashboardDetail(button.dataset.dashboardDetail)));
  bindCommonActions();
}

function statCard(label, value, iconName, trend, trendCopy, color, detailKey = "") {
  const trendClass = trend > 0 ? "up" : trend < 0 ? "down" : "";
  const tag = detailKey ? "button" : "article";
  const interaction = detailKey ? ` type="button" data-dashboard-detail="${escapeHtml(detailKey)}" aria-label="View ${escapeHtml(label)} details"` : "";
  return `<${tag} class="stat-card ${detailKey ? "stat-card-interactive" : ""}"${interaction} style="--stat-color:${color};--tone:${color}15"><div class="stat-head"><span>${escapeHtml(label)}</span><span class="stat-icon">${icon(iconName)}</span></div><div class="stat-value mono"${detailKey ? ` data-dashboard-card-value="${escapeHtml(detailKey)}"` : ""}>${escapeHtml(value)}</div><div class="trend ${trendClass}">${trend === null ? "•" : `${trend >= 0 ? "↑" : "↓"} ${Math.abs(trend)}%`} <span class="muted">${escapeHtml(trendCopy)}</span>${detailKey ? '<span class="stat-card-cta">View details →</span>' : ""}</div></${tag}>`;
}

function syncDashboardCardValues(stats) {
  const currency = state.session?.restaurant?.currency || "PKR";
  const values = {
    orders: stats.today_orders,
    requests: stats.pending_requests,
    revenue: money(stats.today_revenue, currency),
    customers: stats.active_customers,
  };
  Object.entries(values).forEach(([key, value]) => {
    const element = app.querySelector(`[data-dashboard-card-value="${key}"]`);
    if (element) element.textContent = value;
  });
}

function dashboardDetailShell(title, subtitle, body) {
  return `<div class="dashboard-detail"><div class="modal-head"><div><div class="request-number">DASHBOARD DETAILS</div><h2>${escapeHtml(title)}</h2><div class="dashboard-detail-subtitle">${escapeHtml(subtitle)}</div></div><button class="btn icon-btn" data-close-modal aria-label="Close">×</button></div><div class="modal-body">${body}</div></div>`;
}

function dashboardOrdersTable(orders, currency, { includeCancelled = true } = {}) {
  const records = includeCancelled ? orders : orders.filter((order) => order.status !== "cancelled");
  if (!records.length) return emptyState(includeCancelled ? "No orders today" : "No revenue orders today", includeCancelled ? "New orders will appear here as customers confirm them." : "No non-cancelled orders are contributing to today's revenue.", "▤");
  return `<div class="table-wrap dashboard-detail-table"><table class="data-table"><thead><tr><th>Order</th><th>Customer</th><th>WhatsApp</th><th>Items</th><th>Total</th><th>Status</th><th>Type / address</th><th>Created</th><th></th></tr></thead><tbody>${records.map((order) => `<tr><td class="primary-cell">#${escapeHtml(order.id)}</td><td>${escapeHtml(order.customer_name || "Unnamed customer")}</td><td class="mono">${escapeHtml(order.customer_phone)}</td><td class="muted">${escapeHtml(itemSummary(order.items, 3))}</td><td class="mono">${escapeHtml(money(order.total, currency))}</td><td>${badge(order.status)}</td><td>${escapeHtml(statusLabel(order.order_type))}<div class="secondary-cell">${escapeHtml(order.delivery_address || (order.order_type === "pickup" ? "Pickup" : "Address not recorded"))}</div></td><td>${escapeHtml(dateTime(order.created_at))}</td><td><button class="btn btn-sm" data-view-order="${escapeHtml(order.id)}">View</button></td></tr>`).join("")}</tbody></table></div>`;
}

function renderDashboardDetail(type, data) {
  const currency = state.session?.restaurant?.currency || "PKR";
  const details = data.details || {};
  const orders = details.today_orders || [];
  if (type === "orders") {
    return dashboardDetailShell("Today's orders", `${orders.length} ${orders.length === 1 ? "order" : "orders"} created today in Pakistan time`, dashboardOrdersTable(orders, currency));
  }
  if (type === "revenue") {
    const revenueOrders = orders.filter((order) => order.status !== "cancelled");
    const average = revenueOrders.length ? Number(data.stats.today_revenue) / revenueOrders.length : 0;
    const summary = `<div class="revenue-breakdown"><div class="revenue-metric"><span>Total revenue</span><strong class="mono">${escapeHtml(money(data.stats.today_revenue, currency))}</strong></div><div class="revenue-metric"><span>Orders</span><strong class="mono">${revenueOrders.length}</strong></div><div class="revenue-metric"><span>Average order value</span><strong class="mono">${escapeHtml(money(average, currency))}</strong></div></div>`;
    return dashboardDetailShell("Today's revenue", "Non-cancelled orders created today, matching the dashboard revenue total", `${summary}${dashboardOrdersTable(orders, currency, { includeCancelled: false })}`);
  }
  if (type === "requests") {
    const requests = details.pending_requests || [];
    const body = requests.length ? `<div class="request-grid dashboard-request-grid">${requests.map((request) => renderRequestCard(request, currency)).join("")}</div>` : emptyState("No pending requests", "There are no customer requests requiring admin attention.", "✓");
    return dashboardDetailShell("Pending requests", `${requests.length} ${requests.length === 1 ? "request requires" : "requests require"} attention`, body);
  }
  const customers = details.active_customers || [];
  const body = customers.length ? `<div class="table-wrap dashboard-detail-table"><table class="data-table"><thead><tr><th>Customer</th><th>WhatsApp number</th><th>Last activity</th><th>Conversation / order</th><th>Orders</th><th>Most recent order</th><th>Status</th><th></th></tr></thead><tbody>${customers.map((customer) => `<tr><td class="primary-cell">${escapeHtml(customer.name || "Unnamed customer")}</td><td class="mono">${escapeHtml(customer.whatsapp_phone)}</td><td>${escapeHtml(relativeTime(customer.last_activity))}<div class="secondary-cell">${escapeHtml(dateTime(customer.last_activity))}</div></td><td>${escapeHtml(customer.human_handoff || customer.awaiting_human ? "Awaiting human" : statusLabel(customer.conversation_status))}</td><td class="mono">${customer.total_orders}</td><td>${customer.recent_order_id ? `<button class="btn btn-sm" data-view-order="${escapeHtml(customer.recent_order_id)}">#${escapeHtml(customer.recent_order_id)} · ${escapeHtml(statusLabel(customer.recent_order_status))}</button><div class="secondary-cell">${escapeHtml(relativeTime(customer.recent_order_at))}</div>` : '<span class="muted">No orders</span>'}</td><td>${badge("active")}</td><td><button class="btn btn-sm" data-view-customer="${escapeHtml(customer.id)}">View</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("No active customers right now", "Customers with conversation activity in the last 24 hours will appear here.", "♙");
  return dashboardDetailShell("Active customers", `${customers.length} active in the last 24 hours`, body);
}

function bindDashboardDetailActions(type) {
  modalRoot.querySelectorAll("[data-view-order]").forEach((button) => button.addEventListener("click", () => openOrder(button.dataset.viewOrder)));
  modalRoot.querySelectorAll("[data-view-customer]").forEach((button) => button.addEventListener("click", () => openCustomer(button.dataset.viewCustomer)));
  modalRoot.querySelectorAll("[data-resolve-request]").forEach((button) => button.addEventListener("click", () => confirmRequest(button.dataset.requestId, button.dataset.resolveRequest)));
  modalRoot.querySelectorAll("[data-retry-request]").forEach((button) => button.addEventListener("click", () => retryNotification(button)));
  modalRoot.querySelector("[data-retry-dashboard-detail]")?.addEventListener("click", () => openDashboardDetail(type));
}

async function openDashboardDetail(type) {
  const labels = { orders: "today's orders", requests: "pending requests", revenue: "today's revenue", customers: "active customers" };
  if (!labels[type]) return;
  const loadId = ++dashboardDetailLoadId;
  modalLoading(`Loading ${labels[type]}`);
  try {
    const data = await api(`/admin/dashboard?days=${state.dashboardDays}&details=true`, { forceRefresh: true, timeoutMs: 15000 });
    if (loadId !== dashboardDetailLoadId) return;
    syncDashboardCardValues(data.stats);
    showModal(renderDashboardDetail(type, data), { label: labels[type], className: "dashboard-detail-modal" });
    bindDashboardDetailActions(type);
  } catch (error) {
    if (loadId !== dashboardDetailLoadId || isAbortError(error)) return;
    showModal(`<div class="error-state"><div><div class="state-icon">!</div><div class="state-title">Unable to load ${escapeHtml(labels[type])}</div><div class="state-copy">${escapeHtml(error.message)}</div><div class="cluster"><button class="btn" data-close-modal>Close</button><button class="btn btn-primary" data-retry-dashboard-detail>Try again</button></div></div></div>`, { label: `Unable to load ${labels[type]}` });
    bindDashboardDetailActions(type);
  }
}

function renderCompactOrders(orders, currency) {
  if (!orders.length) return emptyState("No orders yet", "Confirmed WhatsApp orders will appear here.", "▤");
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${orders.map((order) => `<tr data-order-row="${escapeHtml(order.id)}" data-order-status="${escapeHtml(order.status)}"><td class="primary-cell">#${escapeHtml(order.id)}</td><td>${escapeHtml(order.customer_name || order.customer_phone)}</td><td class="muted">${escapeHtml(itemSummary(order.items))}</td><td class="mono">${escapeHtml(money(order.total, currency))}</td><td data-order-status-cell>${badge(order.status)}</td><td><button class="btn btn-sm" data-view-order="${escapeHtml(order.id)}">View</button></td></tr>`).join("")}</tbody></table></div>`;
}

function supersedeStaleOrderLoads() {
  pageLoadId += 1;
  pageController?.abort();
  pageController = null;
  pageLoadInFlight = false;
  pollController?.abort();
  clearApiCache();
}

function updateDashboardStatusCounts(previousStatus, nextStatus) {
  if (state.route !== "dashboard" || !previousStatus || previousStatus === nextStatus) return;
  const rows = [...app.querySelectorAll("[data-dashboard-status]")];
  const previous = rows.find((row) => row.dataset.dashboardStatus === previousStatus);
  const next = rows.find((row) => row.dataset.dashboardStatus === nextStatus);
  if (!previous || !next) return;
  const setCount = (row, value) => {
    row.querySelector("[data-status-count]").textContent = Math.max(0, value);
  };
  setCount(previous, Number(previous.querySelector("[data-status-count]").textContent) - 1);
  setCount(next, Number(next.querySelector("[data-status-count]").textContent) + 1);
  const total = Math.max(1, rows.reduce((sum, row) => sum + Number(row.querySelector("[data-status-count]").textContent), 0));
  rows.forEach((row) => {
    const count = Number(row.querySelector("[data-status-count]").textContent);
    row.querySelector("[data-status-fill]").style.width = `${Math.round(count / total * 100)}%`;
  });
}

function orderBelongsOnCurrentPage(status) {
  if (!["orders", "history"].includes(state.route)) return true;
  const terminal = ["completed", "cancelled"].includes(status);
  if (state.route === "orders" && terminal) return false;
  if (state.route === "history" && !terminal) return false;
  const selectedStatus = state.filters[state.route].status;
  return !selectedStatus || selectedStatus === status;
}

function applyOrderStatusToView(order, fallbackPreviousStatus, { enforceScope = false } = {}) {
  if (!order?.id || !order.status) return;
  const matchingRows = [...app.querySelectorAll("[data-order-row]")]
    .filter((row) => String(row.dataset.orderRow) === String(order.id));
  const renderedPreviousStatus = matchingRows[0]?.dataset.orderStatus || fallbackPreviousStatus;
  matchingRows.forEach((row) => {
    row.dataset.orderStatus = order.status;
    const statusCell = row.querySelector("[data-order-status-cell]");
    if (statusCell) statusCell.innerHTML = badge(order.status);
    if (enforceScope && !orderBelongsOnCurrentPage(order.status)) row.remove();
  });
  const modalStatus = modalRoot.querySelector("[data-order-modal-status]");
  if (modalStatus) modalStatus.innerHTML = badge(order.status);
  updateDashboardStatusCounts(renderedPreviousStatus, order.status);
}

function renderDashboardRequests(requests) {
  if (!requests.length) return emptyState("You're all caught up", "There are no pending customer requests.", "✓");
  return `<div>${requests.map((request) => `<div class="feedback-card"><div class="split"><div class="primary-cell">${escapeHtml(request.customer_name || request.customer_phone)}</div>${badge(request.status)}</div><div class="feedback-message">${escapeHtml(request.question)}</div><div class="split"><span class="subtle">${escapeHtml(relativeTime(request.created_at))}</span><button class="btn btn-sm" data-route-jump="requests">Review</button></div></div>`).join("")}</div>`;
}

async function loadOrders(route, requestOptions = {}) {
  const filters = state.filters[route];
  const params = { ...filters, page: state.pages[route], limit: 20, scope: route === "history" ? "history" : "active" };
  const data = await api(`/admin/orders${queryString(params)}`, requestOptions);
  if (state.route !== route || requestOptions.loadId !== pageLoadId) return;
  const history = route === "history";
  const currency = state.session?.restaurant?.currency || "PKR";
  const actions = history ? `<button class="btn history-export" data-action="export-history">${icon("download")}<span>Export CSV</span></button>` : "";
  const pageClass = history ? "history-page" : "orders-page";
  app.querySelector("#page-content").innerHTML = `<div class="${pageClass}">${pageHeading(history ? "Order history" : "Orders", history ? "Search completed and cancelled orders." : "Manage orders currently moving through the kitchen.", actions)}
    <div class="toolbar orders-toolbar"><input class="input mobile-page-search" data-local-search="${route}" type="search" value="${escapeHtml(filters.search)}" placeholder="Search order, customer or phone…">
      <div class="filter-control"><label class="sr-only" for="${route}-status">Filter by status</label><select class="select" id="${route}-status" data-filter="status"><option value="">All statuses</option>${(history ? ["completed", "cancelled"] : ["received", "preparing", "oven", "out_for_delivery"]).map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${escapeHtml(statusLabel(status))}</option>`).join("")}</select><span class="filter-control-icon">${icon("chevronDown")}</span></div>
      <div class="filter-control"><label class="sr-only" for="${route}-type">Filter by fulfilment type</label><select class="select" id="${route}-type" data-filter="order_type"><option value="">Delivery & pickup</option><option value="delivery" ${filters.order_type === "delivery" ? "selected" : ""}>Delivery</option><option value="pickup" ${filters.order_type === "pickup" ? "selected" : ""}>Pickup</option></select><span class="filter-control-icon">${icon("chevronDown")}</span></div>
      <div class="filter-control date-control"><input class="input date-field" data-filter="date_from" type="date" value="${escapeHtml(filters.date_from)}" aria-label="From date"><span class="filter-control-icon">${icon("calendar")}</span></div>
      <div class="filter-control date-control"><input class="input date-field" data-filter="date_to" type="date" value="${escapeHtml(filters.date_to)}" aria-label="To date"><span class="filter-control-icon">${icon("calendar")}</span></div>
    </div>
    <section class="panel orders-table-panel">${data.orders.length ? `<div class="table-wrap"><table class="data-table orders-table"><thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th>Total</th><th>Type</th><th>Status</th><th>Date</th><th class="action-heading">Action</th></tr></thead><tbody>${data.orders.map((order) => `<tr data-order-row="${escapeHtml(order.id)}" data-order-status="${escapeHtml(order.status)}"><td class="primary-cell order-id">#${escapeHtml(order.id)}</td><td><div class="customer-cell"><div class="avatar">${escapeHtml(initials(order.customer_name))}</div><div><div class="primary-cell">${escapeHtml(order.customer_name || "Unnamed customer")}</div><div class="secondary-cell">${escapeHtml(order.customer_phone)}</div></div></div></td><td class="muted items-cell">${escapeHtml(itemSummary(order.items))}</td><td class="mono order-total">${escapeHtml(money(order.total, currency))}</td><td class="type-cell">${escapeHtml(statusLabel(order.order_type))}</td><td data-order-status-cell>${badge(order.status)}</td><td class="order-date">${escapeHtml(dateTime(order.created_at))}</td><td><div class="row-actions"><button class="btn btn-sm order-view-button" data-view-order="${escapeHtml(order.id)}">View</button></div></td></tr>`).join("")}</tbody></table></div>${pagination(data.pagination, route)}` : emptyState(history ? "No historical orders found" : "No active orders found", "Try changing your search or filters.", "▤")}</section></div>`;
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

function openAddressClarification(order) {
  const requestId = crypto.randomUUID();
  showModal(`<form id="address-clarification-form">
    <div class="modal-head"><div><div class="request-number">ORDER #${escapeHtml(order.id)}</div><h2>Address Not Clear</h2></div><button class="btn icon-btn" type="button" data-address-clarification-cancel aria-label="Close">×</button></div>
    <div class="modal-body address-clarification-body">
      <div class="address-clarification-callout">${icon("alert")}<div><strong>Ask the customer to provide a clearer delivery address.</strong><span>The message will be sent securely through the existing WhatsApp workflow.</span></div></div>
      <div class="field"><label for="address-clarification-message">Message to customer</label><textarea class="textarea" id="address-clarification-message" name="admin_message" maxlength="500" required>${escapeHtml(DEFAULT_ADDRESS_CLARIFICATION_MESSAGE)}</textarea><div class="field-help"><span>Review or edit before sending.</span><span data-message-count>${DEFAULT_ADDRESS_CLARIFICATION_MESSAGE.length}/500</span></div></div>
      <div class="danger-text" data-address-clarification-error role="alert" hidden></div>
    </div>
    <div class="modal-foot"><button class="btn" type="button" data-address-clarification-cancel>Cancel</button><button class="btn btn-primary" type="submit">Send to Customer</button></div>
  </form>`, { label: `Address clarification for order ${order.id}`, className: "address-clarification-modal", dismissible: false });

  const form = modalRoot.querySelector("#address-clarification-form");
  const message = form.querySelector("textarea");
  const counter = form.querySelector("[data-message-count]");
  const errorBox = form.querySelector("[data-address-clarification-error]");
  form.querySelectorAll("[data-address-clarification-cancel]").forEach((button) => button.addEventListener("click", () => openOrder(order.id)));
  message.addEventListener("input", () => { counter.textContent = `${message.value.length}/500`; });
  message.focus();
  message.setSelectionRange(message.value.length, message.value.length);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const adminMessage = message.value.trim();
    if (!adminMessage) {
      errorBox.textContent = "Enter a message before sending.";
      errorBox.hidden = false;
      message.focus();
      return;
    }
    const submit = form.querySelector("button[type='submit']");
    const controls = [...form.querySelectorAll("button, textarea")];
    controls.forEach((control) => { control.disabled = true; });
    submit.textContent = "Sending…";
    errorBox.hidden = true;
    try {
      const result = await api(`/admin/orders/${order.id}/address-clarification`, {
        method: "POST",
        timeoutMs: 30000,
        body: JSON.stringify({ request_id: requestId, admin_message: adminMessage }),
      });
      const delivered = ["sent", "duplicate"].includes(result.notification_lifecycle);
      toast(delivered ? "Address clarification requested." : "Address clarification request is processing.");
      await openOrder(order.id);
      refreshActivity().catch(() => {});
    } catch (error) {
      errorBox.textContent = error.message || "Address clarification could not be sent. Please retry.";
      errorBox.hidden = false;
      form.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      message.disabled = true;
      submit.textContent = "Retry Send";
    }
  });
}

async function openOrder(orderId) {
  modalLoading("Loading order");
  try {
    const data = await api(`/admin/orders/${orderId}`);
    const order = data.order;
    const currency = state.session?.restaurant?.currency || "PKR";
    const labels = {
      preparing: "Start preparing",
      oven: "Move to oven",
      out_for_delivery: "Mark out for delivery",
      completed: order.order_type === "pickup" ? "Mark completed" : "Mark delivered",
      cancelled: "Cancel order",
    };
    const transitions = (order.allowed_transitions || []).map((status) => [status, labels[status] || statusLabel(status)]);
    const latestNotification = data.notifications?.find((entry) => entry.event_type !== "admin_address_clarification") || null;
    const latestAddressClarification = data.notifications?.find((entry) => entry.event_type === "admin_address_clarification") || null;
    const addressRequestInFlight = ["pending", "processing"].includes(latestAddressClarification?.delivery_status);
    const addressClarificationAvailable = order.order_type === "delivery" && ["received", "preparing"].includes(order.status);
    const addressClarificationStatus = !latestAddressClarification
      ? ""
      : latestAddressClarification.delivery_status === "sent"
        ? `Address clarification requested · ${dateTime(latestAddressClarification.sent_at || latestAddressClarification.updated_at)}`
        : addressRequestInFlight
          ? "Address clarification request is being sent…"
          : latestAddressClarification.delivery_status === "failed"
            ? "Address clarification request failed."
            : "Address clarification request was not sent.";
    const notificationCopy = !latestNotification
      ? "No dashboard-generated customer update yet."
      : latestNotification.delivery_status === "sent"
        ? `Delivered ${dateTime(latestNotification.sent_at || latestNotification.updated_at)}`
        : latestNotification.delivery_status === "superseded"
          ? "Not sent because a newer order status is already authoritative."
        : latestNotification.delivery_status === "failed"
          ? `Failed: ${latestNotification.last_error || "n8n/WhatsApp delivery failed"}`
          : latestNotification.delivery_status === "processing"
            ? "Delivery is processing in n8n."
            : "Queued for delivery.";
    showModal(`<div class="modal-head"><div><div class="request-number">ORDER #${escapeHtml(order.id)}</div><h2>${escapeHtml(order.customer_name || "Customer")}</h2></div><button class="btn icon-btn" data-close-modal aria-label="Close">×</button></div>
      <div class="modal-body stack"><div class="detail-grid">
        <div class="detail-block"><div class="fact-label">Customer</div><div class="fact-value">${escapeHtml(order.customer_name || "Unnamed")}<br>${escapeHtml(order.customer_phone)}</div></div>
        <div class="detail-block"><div class="fact-label">Fulfilment</div><div class="fact-value">${escapeHtml(statusLabel(order.order_type))}<div class="delivery-address-row"><span>${escapeHtml(order.delivery_address || "Pickup")}</span>${addressClarificationAvailable ? `<button class="btn btn-sm address-clarification-button" type="button" data-address-not-clear ${addressRequestInFlight ? "disabled" : ""}>${icon("alert")}<span>${addressRequestInFlight ? "Request in progress" : "Address Not Clear"}</span></button>` : ""}</div>${addressClarificationStatus ? `<div class="address-clarification-status ${latestAddressClarification.delivery_status === "failed" ? "failed" : ""}"><span>${escapeHtml(addressClarificationStatus)}</span>${latestAddressClarification.delivery_status === "failed" ? `<button class="btn btn-sm" data-retry-order-event="${escapeHtml(latestAddressClarification.id)}" data-order-id="${escapeHtml(order.id)}">Retry</button>` : ""}</div>` : ""}</div></div>
        <div class="detail-block wide"><div class="fact-label">Items</div><div class="line-items" style="margin-top:10px">${(order.items || []).map((item) => `<div class="line-item"><div><strong>${escapeHtml(item.quantity || 1)}× ${escapeHtml(item.item_name || item.name || "Item")}</strong><div class="secondary-cell">${escapeHtml(item.size || item.variant || "Standard")}${Array.isArray(item.extras) && item.extras.length ? ` · ${escapeHtml(item.extras.join(", "))}` : ""}</div></div><span>${escapeHtml(money(item.line_total || Number(item.price || 0) * Number(item.quantity || 1), currency))}</span></div>`).join("")}</div></div>
        <div class="detail-block"><div class="fact-label">Totals</div><div class="fact-value">Subtotal ${escapeHtml(money(order.subtotal, currency))}<br>Delivery ${escapeHtml(money(order.delivery_charge, currency))}<br><strong>Total ${escapeHtml(money(order.total, currency))}</strong></div></div>
        <div class="detail-block"><div class="fact-label">Status</div><div class="fact-value"><span data-order-modal-status>${badge(order.status)}</span><br><span class="subtle">${escapeHtml(dateTime(order.created_at))}</span></div></div>
        <div class="detail-block wide"><div class="fact-label">Customer notification</div><div class="fact-value">${escapeHtml(notificationCopy)}</div>${latestNotification?.delivery_status === "failed" ? `<button class="btn btn-sm" style="margin-top:10px" data-retry-order-event="${escapeHtml(latestNotification.id)}" data-order-id="${escapeHtml(order.id)}">Retry notification</button>` : ""}</div>
        <div class="detail-block wide"><div class="fact-label">Timeline</div><div class="timeline" style="margin-top:12px">${data.history.map((event) => `<div class="timeline-item"><span class="timeline-dot"></span><div><div class="primary-cell">${escapeHtml(statusLabel(event.status))}</div><div class="secondary-cell">${escapeHtml(dateTime(event.created_at))}</div></div></div>`).join("")}</div></div>
      </div></div>
      <div class="modal-foot">${transitions.length ? transitions.map(([status, label]) => `<button class="btn ${status === "cancelled" ? "btn-danger" : "btn-primary"}" data-order-status="${status}" data-order-id="${escapeHtml(order.id)}">${escapeHtml(label)}</button>`).join("") : '<span class="muted">No further actions</span>'}</div>`, { label: `Order ${order.id}` });
    modalRoot.querySelectorAll("[data-order-status]").forEach((button) => button.addEventListener("click", async () => {
      const original = button.textContent;
      const previousStatus = order.status;
      const requestedStatus = button.dataset.orderStatus;
      const actionButtons = [...modalRoot.querySelectorAll("[data-order-status]")];
      actionButtons.forEach((actionButton) => { actionButton.disabled = true; });
      supersedeStaleOrderLoads();
      applyOrderStatusToView({ id: order.id, status: requestedStatus }, previousStatus);
      button.textContent = "Updating…";
      try {
        const result = await api(`/admin/orders/${button.dataset.orderId}/status`, {
          method: "PATCH",
          timeoutMs: 30000,
          body: JSON.stringify({ status: requestedStatus, expected_status: previousStatus, request_id: crypto.randomUUID() }),
        });
        const canonicalOrder = result.order || { ...order, status: requestedStatus };
        applyOrderStatusToView(canonicalOrder, requestedStatus, { enforceScope: true });
        const deliveryStatus = result.notification?.delivery_status;
        const notificationMessage = deliveryStatus === "sent"
          ? "Customer notified."
          : deliveryStatus === "superseded"
            ? "A newer status superseded this notification."
          : deliveryStatus === "failed"
            ? "Customer notification failed — open the order to retry."
            : "Customer notification queued.";
        toast(`Order #${button.dataset.orderId} marked ${statusLabel(canonicalOrder.status)}. ${notificationMessage}`, deliveryStatus === "failed" ? "error" : "success");
        closeModal();
        if (["dashboard", "orders", "history"].includes(state.route)) {
          loadCurrentPage({ background: true, forceRefresh: true });
        }
        refreshActivity().catch(() => {});
      } catch (error) {
        let canonicalOrder = null;
        try {
          canonicalOrder = (await api(`/admin/orders/${button.dataset.orderId}`, {
            forceRefresh: true,
            timeoutMs: 10000,
          })).order;
        } catch {
          // If reconciliation also fails, the last confirmed pre-mutation state is safest.
        }
        const confirmedStatusChanged = canonicalOrder && canonicalOrder.status !== previousStatus;
        applyOrderStatusToView(canonicalOrder || { ...order, status: previousStatus }, requestedStatus, {
          enforceScope: Boolean(confirmedStatusChanged),
        });
        if (confirmedStatusChanged) {
          closeModal();
          toast(`Order #${button.dataset.orderId} is ${statusLabel(canonicalOrder.status)}. ${error.message}`, "error");
          if (["dashboard", "orders", "history"].includes(state.route)) {
            loadCurrentPage({ background: true, forceRefresh: true });
          }
        } else {
          toast(error.message, "error");
          actionButtons.forEach((actionButton) => { actionButton.disabled = false; });
          button.textContent = original;
        }
      }
    }));
    modalRoot.querySelector("[data-address-not-clear]")?.addEventListener("click", () => openAddressClarification(order));
    modalRoot.querySelectorAll("[data-retry-order-event]").forEach((retryButton) => retryButton.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "Retrying…";
      try {
        const result = await api(`/admin/orders/${button.dataset.orderId}/notifications/${button.dataset.retryOrderEvent}/retry`, { method: "POST" });
        toast(result.notification?.delivery_status === "sent" ? "Customer notification delivered." : "Customer notification is processing.");
        openOrder(button.dataset.orderId);
        refreshActivity().catch(() => {});
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
        button.textContent = original;
      }
    }));
  } catch (error) {
    showModal(`<div class="error-state"><div><div class="state-icon">!</div><div class="state-title">Order unavailable</div><div class="state-copy">${escapeHtml(error.message)}</div><button class="btn" data-close-modal>Close</button></div></div>`);
  }
}

async function loadRequests(requestOptions = {}) {
  const filters = state.filters.requests;
  const data = await api(`/admin/requests${queryString({ ...filters, page: state.pages.requests, limit: 20 })}`, requestOptions);
  if (state.route !== "requests" || requestOptions.loadId !== pageLoadId) return;
  const currency = state.session?.restaurant?.currency || "PKR";
  app.querySelector("#page-content").innerHTML = `<div class="pending-requests-page">${pageHeading("Pending requests", "Review and respond to requests from WhatsApp customers.")}
    <div class="toolbar requests-toolbar"><input class="input mobile-page-search" data-local-search="requests" type="search" value="${escapeHtml(filters.search)}" placeholder="Search customer or request…">
      <div class="filter-control"><label class="sr-only" for="requests-status">Filter by status</label><select class="select" id="requests-status" data-filter="status"><option value="">All statuses</option>${["pending","approved","denied"].map((value) => `<option value="${value}" ${filters.status === value ? "selected" : ""}>${escapeHtml(statusLabel(value))}</option>`).join("")}</select><span class="filter-control-icon">${icon("chevronDown")}</span></div>
      <div class="filter-control"><label class="sr-only" for="requests-type">Filter by request type</label><select class="select" id="requests-type" data-filter="type"><option value="">All request types</option><option value="cancel_order" ${filters.type === "cancel_order" ? "selected" : ""}>Cancellation request</option><option value="modification" ${filters.type === "modification" ? "selected" : ""}>Order modification</option><option value="delivery" ${filters.type === "delivery" ? "selected" : ""}>Delivery issue</option><option value="other" ${filters.type === "other" ? "selected" : ""}>Other</option></select><span class="filter-control-icon">${icon("chevronDown")}</span></div>
    </div>
    ${data.requests.length ? `<div class="request-grid">${data.requests.map((request) => renderRequestCard(request, currency)).join("")}</div>${pagination(data.pagination, "requests")}` : `<section class="panel requests-empty-panel">${emptyState("No requests found", "New customer requests from WhatsApp will appear here.", "✓")}</section>`}</div>`;
  bindFilterControls("requests");
  bindLocalSearch("requests");
  bindCommonActions();
  app.querySelectorAll("[data-resolve-request]").forEach((button) => button.addEventListener("click", () => confirmRequest(button.dataset.requestId, button.dataset.resolveRequest)));
  app.querySelectorAll("[data-retry-request]").forEach((button) => button.addEventListener("click", () => retryNotification(button)));
}

function renderRequestCard(request, currency) {
  const cancellable = request.request_type !== "cancel_order" || Boolean(request.order_id && request.order_cancellable);
  const deliveryStatus = request.notification_delivery_status || (request.notification_sent ? "sent" : request.notification_error ? "failed" : null);
  const notificationRetryable = request.status !== "pending" && deliveryStatus === "failed" && Boolean(request.notification_event_id);
  const typeLabel = ({ cancel_order: "Cancellation request", modification: "Order modification", delivery: "Delivery issue" })[request.request_type] || "Customer request";
  return `<article class="request-card"><div class="request-card-top"><div class="request-number">REQUEST #${escapeHtml(request.id)}</div>${badge(request.status)}</div><div class="request-type">${escapeHtml(typeLabel)}</div>
    <div class="request-question">${escapeHtml(request.question)}</div>
    <div class="request-facts"><div><div class="fact-label">Customer</div><div class="fact-value">${escapeHtml(request.customer_name || "Unnamed")}<br><span class="subtle">${escapeHtml(request.customer_phone)}</span></div></div><div><div class="fact-label">Order</div><div class="fact-value">${request.order_id ? `#${escapeHtml(request.order_id)}<br>${escapeHtml(itemSummary(request.order_items, 1))}` : "Not linked"}</div></div><div><div class="fact-label">Total</div><div class="fact-value">${request.order_total ? escapeHtml(money(request.order_total, currency)) : "—"}</div></div><div><div class="fact-label">Delivery</div><div class="fact-value">${escapeHtml(request.delivery_address || (request.order_type ? statusLabel(request.order_type) : "—"))}</div></div><div><div class="fact-label">Requested</div><div class="fact-value">${escapeHtml(relativeTime(request.created_at))}</div></div><div><div class="fact-label">Notification</div><div class="fact-value">${deliveryStatus === "sent" ? '<span class="success-text">Delivered</span>' : deliveryStatus === "failed" ? '<span class="danger-text">Failed</span>' : deliveryStatus === "processing" ? "Processing" : deliveryStatus === "pending" ? "Queued" : deliveryStatus === "superseded" ? "Superseded" : "Not sent"}</div></div></div>
    ${request.request_type === "cancel_order" && !cancellable && request.status === "pending" ? `<div class="notification-failure">Order #${escapeHtml(request.order_id || "?")} can no longer be cancelled at status ${escapeHtml(statusLabel(request.order_status))}. The backend will reject approval.</div>` : ""}
    ${deliveryStatus === "failed" ? `<div class="notification-failure">Customer notification failed: ${escapeHtml(request.event_notification_error || request.notification_error || "Delivery failed")}</div>` : ""}
    <div class="request-actions">${request.order_id ? `<button class="btn btn-sm" data-view-order="${escapeHtml(request.order_id)}">View order</button>` : ""}${request.status === "pending" ? `${cancellable ? `<button class="btn btn-primary btn-sm" data-resolve-request="approve" data-request-id="${escapeHtml(request.id)}">Approve</button>` : ""}<button class="btn btn-danger btn-sm" data-resolve-request="deny" data-request-id="${escapeHtml(request.id)}">Deny</button>` : notificationRetryable ? `<button class="btn btn-sm" data-retry-request="${escapeHtml(request.id)}">Retry notification</button>` : ""}<span class="subtle" style="margin-left:auto">${escapeHtml(dateTime(request.created_at))}</span></div></article>`;
}

function confirmRequest(requestId, decision) {
  const action = decision === "approve" ? "Approve" : "Deny";
  showModal(`<form id="request-decision-form"><div class="modal-head"><h2>${action} request #${escapeHtml(requestId)}?</h2><button type="button" class="btn icon-btn" data-close-modal>×</button></div><div class="modal-body"><p class="muted" style="margin-top:0">This commits the decision, queues a durable event, and asks n8n to notify the customer. Staff stay entirely in this dashboard.</p><div class="field"><label for="admin-note">Customer-safe reason (optional)</label><textarea class="textarea" id="admin-note" name="admin_note" placeholder="Add a short explanation"></textarea></div></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancel</button><button type="submit" class="btn ${decision === "approve" ? "btn-primary" : "btn-danger"}">${action} request</button></div></form>`, { label: `${action} request` });
  modalRoot.querySelector("#request-decision-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[type='submit']");
    button.disabled = true;
    button.textContent = "Saving…";
    const note = new FormData(event.currentTarget).get("admin_note").trim();
    try {
      const result = await api(`/admin/requests/${requestId}/${decision}`, { method: "POST", body: JSON.stringify({ admin_note: note || undefined }) });
      closeModal();
      const decisionLabel = decision === "approve" ? "approved" : "denied";
      const deliveryStatus = result.notification?.delivery_status;
      toast(
        deliveryStatus === "sent"
          ? `Request ${decisionLabel} and customer notified.`
          : deliveryStatus === "failed"
            ? `Request ${decisionLabel}; customer notification failed and can be retried.`
            : `Request ${decisionLabel}; customer notification queued.`,
        deliveryStatus === "failed" ? "error" : "success"
      );
      loadCurrentPage();
      refreshActivity().catch(() => {});
    } catch (error) { toast(error.message, "error"); button.disabled = false; button.textContent = `${action} request`; }
  });
}

async function retryNotification(button) {
  const id = button.dataset.retryRequest;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Retrying…";
  try {
    const result = await api(`/admin/requests/${id}/notify`, { method: "POST" });
    toast(result.notification?.delivery_status === "sent" ? "Customer notification delivered." : "Customer notification is processing.");
    loadCurrentPage();
  } catch (error) { toast(error.message, "error"); button.disabled = false; button.textContent = original; }
}

async function loadCustomers(requestOptions = {}) {
  const data = await api(`/admin/customers${queryString({ search: state.filters.customers.search, page: state.pages.customers, limit: 20 })}`, requestOptions);
  if (state.route !== "customers" || requestOptions.loadId !== pageLoadId) return;
  const currency = state.session?.restaurant?.currency || "PKR";
  app.querySelector("#page-content").innerHTML = `<div class="customers-page">${pageHeading("Customers", "Real customer profiles aggregated from WhatsApp orders.")}
    <div class="toolbar customers-toolbar"><input class="input mobile-page-search" data-local-search="customers" type="search" value="${escapeHtml(state.filters.customers.search)}" placeholder="Search name or phone…"></div>
    <section class="panel customers-table-panel">${data.customers.length ? `<div class="table-wrap"><table class="data-table customers-table"><thead><tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Total spending</th><th>Last order</th><th>Status</th><th class="customer-action-heading"><span class="sr-only">Actions</span></th></tr></thead><tbody>${data.customers.map((customer) => `<tr><td><div class="customer-cell"><div class="avatar">${escapeHtml(initials(customer.name))}</div><div class="primary-cell customer-name">${escapeHtml(customer.name || "Unnamed customer")}</div></div></td><td class="mono customer-phone">${escapeHtml(customer.whatsapp_phone)}</td><td class="customer-orders">${customer.total_orders}</td><td class="mono customer-spending">${escapeHtml(money(customer.total_spending, currency))}</td><td class="customer-last-order">${escapeHtml(customer.last_order ? relativeTime(customer.last_order) : "No orders")}</td><td>${badge(customer.status)}</td><td><button class="btn btn-sm customer-view-button" data-view-customer="${escapeHtml(customer.id)}">View</button></td></tr>`).join("")}</tbody></table></div>${pagination(data.pagination, "customers")}` : emptyState("No customers found", "Customers are created by the WhatsApp ordering flow.", "♙")}</section></div>`;
  bindLocalSearch("customers");
  bindCommonActions();
}

async function openCustomer(customerId) {
  modalLoading("Loading customer");
  try {
    const data = await api(`/admin/customers/${customerId}`);
    const customer = data.customer;
    const currency = state.session?.restaurant?.currency || "PKR";
    showModal(`<div class="modal-head"><div><div class="request-number">CUSTOMER #${escapeHtml(customer.id)}</div><h2>${escapeHtml(customer.name || "Unnamed customer")}</h2></div><button class="btn icon-btn" data-close-modal>×</button></div><div class="modal-body stack"><div class="detail-grid"><div class="detail-block"><div class="fact-label">WhatsApp</div><div class="fact-value">${escapeHtml(customer.whatsapp_phone)}</div></div><div class="detail-block"><div class="fact-label">Language</div><div class="fact-value">${escapeHtml(customer.preferred_language || "Not recorded")}</div></div><div class="detail-block"><div class="fact-label">Total orders</div><div class="fact-value">${customer.total_orders}</div></div><div class="detail-block"><div class="fact-label">Total spending</div><div class="fact-value">${escapeHtml(money(customer.total_spending, currency))}</div></div></div><div><div class="panel-title" style="margin-bottom:10px">Recent orders</div>${data.orders.length ? `<div class="line-items">${data.orders.map((order) => `<button class="line-item btn btn-quiet" data-view-order="${escapeHtml(order.id)}"><span>#${escapeHtml(order.id)} · ${escapeHtml(itemSummary(order.items))}</span><span>${escapeHtml(money(order.total, currency))}</span></button>`).join("")}</div>` : '<div class="muted">No orders.</div>'}</div>${data.session ? `<div><div class="panel-title" style="margin-bottom:10px">Conversation state</div><div class="detail-block"><div class="fact-value">Bot status: ${escapeHtml(statusLabel(data.session.order_status))}<br>Last activity: ${escapeHtml(dateTime(data.session.updated_at))}<br>Human handoff: ${data.session.human_handoff || data.session.awaiting_human ? "Active" : "No"}</div></div></div>` : ""}</div><div class="modal-foot"><span class="muted">Customer communication is handled by the bot.</span></div>`, { label: "Customer details" });
    modalRoot.querySelectorAll("[data-view-order]").forEach((button) => button.addEventListener("click", () => openOrder(button.dataset.viewOrder)));
  } catch (error) { toast(error.message, "error"); closeModal(); }
}

async function loadFeedback(requestOptions = {}) {
  const filters = state.filters.feedback;
  const data = await api(`/admin/feedback${queryString({ rating: filters.rating, page: state.pages.feedback, limit: 20 })}`, requestOptions);
  if (state.route !== "feedback" || requestOptions.loadId !== pageLoadId) return;
  app.querySelector("#page-content").innerHTML = `${pageHeading("Feedback", "Customer ratings collected through the Pizza Bar backend.")}
    <section class="feedback-summary">${statCard("Average rating", `${Number(data.summary.average_rating).toFixed(1)} / 5`, "★", null, "all reviews", "#e6a83c")}${statCard("Total reviews", data.summary.total, "☆", null, "submitted feedback", "#5d8ee2")}${statCard("Five-star reviews", `${data.summary.five_star_percentage}%`, "✦", null, "of rated reviews", "#47b978")}</section>
    <div class="toolbar"><select class="select" data-filter="rating"><option value="">All ratings</option>${[5,4,3,2,1,0].map((rating) => `<option value="${rating}" ${String(filters.rating) === String(rating) ? "selected" : ""}>${rating} stars</option>`).join("")}</select></div>
    <section class="panel">${data.feedback.length ? `${renderFeedbackList(data.feedback)}${pagination(data.pagination, "feedback")}` : emptyState("No feedback yet", "Ratings submitted through WhatsApp will appear here once the feedback workflow stores them.", "☆")}</section>`;
  bindFilterControls("feedback");
  bindCommonActions();
}

function renderFeedbackList(feedback) {
  if (!feedback.length) return emptyState("No feedback yet", "Customer reviews will appear here.", "☆");
  return `<div>${feedback.map((item) => {
    const rating = item.rating === null || item.rating === undefined ? null : Math.max(0, Math.min(5, Number(item.rating)));
    const ratingHtml = rating === null
      ? '<div class="stars" aria-label="No rating provided">No rating</div>'
      : `<div class="stars" aria-label="${rating} out of 5 stars">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</div>`;
    return `<article class="feedback-card"><div class="split"><div><div class="primary-cell">${escapeHtml(item.customer_name || item.customer_phone)}</div>${ratingHtml}</div><span class="subtle">${escapeHtml(dateOnly(item.created_at))}</span></div><div class="feedback-message">${escapeHtml(item.message || "No written comment")}</div>${item.order_id ? `<button class="btn btn-sm" data-view-order="${escapeHtml(item.order_id)}">Order #${escapeHtml(item.order_id)}</button>` : ""}</article>`;
  }).join("")}</div>`;
}

async function loadMenu(requestOptions = {}) {
  const data = await api("/admin/menu", requestOptions);
  if (state.route !== "menu" || requestOptions.loadId !== pageLoadId) return;
  const search = state.filters.menu.search.toLowerCase();
  const allRecords = [...data.items.map((item) => ({ ...item, kind: "items" })), ...data.deals.map((deal) => ({ ...deal, kind: "deals", variants: [] }))];
  const categories = ["All", ...new Set(allRecords.map((record) => record.category))];
  if (!categories.includes(state.filters.menu.category)) state.filters.menu.category = "All";
  const records = allRecords.filter((record) => (state.filters.menu.category === "All" || record.category === state.filters.menu.category) && (!search || `${record.name} ${record.description || ""}`.toLowerCase().includes(search)));
  const currency = state.session?.restaurant?.currency || "PKR";
  app.querySelector("#page-content").innerHTML = `<div class="menu-page">${pageHeading("Menu management", "Live products, variants, deals and images from Neon.", `<button class="btn btn-primary menu-add-button" data-action="add-menu-item">${icon("plus")}<span>Add item</span></button>`)}
    <div class="toolbar menu-toolbar"><input class="input mobile-page-search" data-local-search="menu" type="search" value="${escapeHtml(state.filters.menu.search)}" placeholder="Search menu…"></div>
    <div class="category-tabs">${categories.map((category) => `<button class="category-tab ${state.filters.menu.category === category ? "active" : ""}" data-menu-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("")}</div>
    <div class="menu-layout"><section class="menu-products">${records.length ? `<div class="menu-grid">${records.map((record) => renderMenuCard(record, currency)).join("")}</div>` : `<div class="panel menu-empty-panel">${emptyState("No menu items found", "Try a different category or search term.", "♨")}</div>`}</section><aside class="panel menu-gallery"><div class="panel-head"><div><div class="panel-title">Menu images</div><div class="panel-subtitle">Stored in Neon BYTEA</div></div><span class="menu-image-count">${data.images.length} ${data.images.length === 1 ? "file" : "files"}</span></div><div class="panel-body">${data.images.length ? data.images.map((image) => `<figure class="menu-image-card"><div class="menu-image-frame"><img class="menu-image" src="${escapeHtml(`${API_BASE}${image.url}`)}" alt="${escapeHtml(image.name)}" loading="lazy"></div><figcaption><span>${escapeHtml(image.name)}</span><small>Stored</small></figcaption></figure>`).join("") : `<div class="menu-images-empty">No active images.</div>`}</div></aside></div></div>`;
  app.querySelectorAll("[data-menu-category]").forEach((button) => button.addEventListener("click", () => { state.filters.menu.category = button.dataset.menuCategory; loadCurrentPage(); }));
  bindLocalSearch("menu");
  app.querySelector("[data-action='add-menu-item']").addEventListener("click", openAddMenuItem);
  app.querySelectorAll("[data-toggle-menu]").forEach((button) => button.addEventListener("click", () => toggleMenuRecord(button)));
  app.querySelectorAll("[data-edit-price]").forEach((button) => button.addEventListener("click", () => editMenuPrice(button)));
}

function renderMenuCard(record, currency) {
  return `<article class="menu-card ${record.active ? "" : "disabled"}"><div class="menu-card-head"><div class="menu-meta">${escapeHtml(record.category)} · ${escapeHtml(record.kind === "deals" ? "Deal" : record.item_type)}</div><button class="btn btn-sm menu-availability ${record.active ? "" : "btn-primary"}" data-toggle-menu="${escapeHtml(record.id)}" data-menu-kind="${record.kind}" data-menu-active="${record.active}">${record.active ? "Available" : "Unavailable"}</button></div><h3 class="menu-title">${escapeHtml(record.name)}</h3><p class="menu-description">${escapeHtml(record.description || "No description")}</p>${record.kind === "deals" ? `<div class="variant-row menu-variant-row"><span>Deal price</span><button class="btn btn-sm menu-price-button" data-edit-price="${escapeHtml(record.id)}" data-menu-kind="deals" data-current-price="${record.price}">${escapeHtml(money(record.price, currency))}</button></div>` : `<div class="variant-list">${record.variants.map((variant) => `<div class="variant-row menu-variant-row"><span>${escapeHtml(variant.label || "Standard")}</span><button class="btn btn-sm menu-price-button" data-edit-price="${escapeHtml(variant.id)}" data-item-id="${escapeHtml(record.id)}" data-menu-kind="variant" data-current-price="${variant.price}">${escapeHtml(money(variant.price, currency))}</button></div>`).join("")}</div>`}</article>`;
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

async function loadNotifications(requestOptions = {}) {
  const filters = state.filters.notifications;
  const data = await api(`/admin/notifications${queryString({ ...filters, page: state.pages.notifications, limit: 30 })}`, requestOptions);
  if (state.route !== "notifications" || requestOptions.loadId !== pageLoadId) return;
  app.querySelector("#page-content").innerHTML = `${pageHeading("Notifications", "Database-backed order, request and delivery events.", '<button class="btn" data-action="read-all">Mark all read</button>')}
    <div class="toolbar"><select class="select" data-filter="unread"><option value="">All notifications</option><option value="true" ${filters.unread === "true" ? "selected" : ""}>Unread only</option></select><select class="select" data-filter="type"><option value="">All types</option><option value="new_order" ${filters.type === "new_order" ? "selected" : ""}>New orders</option><option value="customer_request" ${filters.type === "customer_request" ? "selected" : ""}>Customer requests</option><option value="notification_failure" ${filters.type === "notification_failure" ? "selected" : ""}>Failures</option><option value="system" ${filters.type === "system" ? "selected" : ""}>System</option></select></div>
    <section class="panel">${data.notifications.length ? `<div class="notification-list">${data.notifications.map(renderNotification).join("")}</div>${pagination(data.pagination, "notifications")}` : emptyState("No notifications", "Operational events will appear here automatically.", "♢")}</section>`;
  bindFilterControls("notifications");
  bindCommonActions();
  app.querySelector("[data-action='read-all']").addEventListener("click", async () => {
    try { await api("/admin/notifications/read-all", { method: "POST" }); toast("All notifications marked read."); updateUnread(0); loadCurrentPage(); } catch (error) { toast(error.message, "error"); }
  });
  app.querySelectorAll("[data-notification-id]").forEach((item) => item.addEventListener("click", async () => {
    if (!item.dataset.readAt) {
      try {
        const result = await api(`/admin/notifications/${item.dataset.notificationId}/read`, { method: "PATCH" });
        item.dataset.readAt = result.notification?.read_at || new Date().toISOString();
        item.classList.remove("unread");
        item.querySelector(".unread-mark")?.remove();
        refreshActivity().catch(() => {});
      } catch {}
    }
    if (item.dataset.orderId) openOrder(item.dataset.orderId);
    else if (item.dataset.requestId) navigate("requests");
  }));
}

function renderNotification(notification) {
  const icons = { new_order: "▤", customer_request: "◉", notification_failure: "!", system: "⚙" };
  return `<article class="notification-item ${notification.read_at ? "" : "unread"}" data-notification-id="${escapeHtml(notification.id)}" data-read-at="${escapeHtml(notification.read_at || "")}" data-order-id="${escapeHtml(notification.order_id || "")}" data-request-id="${escapeHtml(notification.request_id || "")}"><div class="notification-icon">${icons[notification.notification_type] || "♢"}</div><div><div class="notification-title">${escapeHtml(notification.title)}</div><div class="notification-message">${escapeHtml(notification.message)}</div><div class="secondary-cell">${escapeHtml(relativeTime(notification.created_at))}</div></div>${notification.read_at ? "" : '<span class="unread-mark"></span>'}</article>`;
}

async function loadSettings(requestOptions = {}) {
  const data = await api("/admin/settings", requestOptions);
  if (state.route !== "settings" || requestOptions.loadId !== pageLoadId) return;
  const restaurant = data.restaurant || {};
  const admin = data.admin || {};
  app.querySelector("#page-content").innerHTML = `<div class="settings-page">${pageHeading("Settings", "Public restaurant configuration and integration health. Secrets stay on the backend.")}
    <div class="settings-grid">
      <form id="settings-form" class="settings-form-contents">
        <section class="panel settings-section"><div class="settings-card-head"><h3>Restaurant information</h3><p>Used by the bot and admin dashboard.</p></div><div class="stack"><div class="field"><label for="restaurant-name">Restaurant name</label><input class="input" id="restaurant-name" name="restaurant_name" value="${escapeHtml(restaurant.restaurant_name)}" required></div><div class="detail-grid"><div class="field"><label for="currency">Currency</label><input class="input" id="currency" name="currency" value="${escapeHtml(restaurant.currency)}" maxlength="3" required></div><div class="field"><label for="delivery-charge">Delivery charge</label><input class="input" id="delivery-charge" name="delivery_charge" type="number" min="0" step="0.01" value="${escapeHtml(restaurant.delivery_charge)}" required></div></div><div class="field"><label for="opening-hours">Opening hours (JSON)</label><textarea class="textarea settings-json" id="opening-hours" name="opening_hours" spellcheck="false">${escapeHtml(JSON.stringify(restaurant.opening_hours || {}, null, 2))}</textarea></div></div></section>
        <section class="panel settings-section"><div class="settings-card-head"><h3>Admin account</h3><p>Profile information displayed throughout the dashboard.</p></div><div class="field"><label for="display-name">Display name</label><input class="input" id="display-name" name="display_name" value="${escapeHtml(admin.display_name)}" required></div><div class="integration-row"><div><div class="primary-cell">Authentication</div><div class="secondary-cell">Username, password, and secure session</div></div>${badge("active")}</div></section>
        <section class="panel settings-section"><div class="settings-card-head"><h3>Customer status updates</h3><p>The backend securely dispatches durable events to n8n; no integration secret is exposed here.</p></div><div class="integration-row"><div><div class="primary-cell">n8n status webhook</div><div class="secondary-cell">Server-to-server authentication</div></div>${badge(data.integrations.n8n_status_webhook_configured ? "active" : "inactive")}</div></section>
        <section class="panel settings-section"><div class="settings-card-head"><h3>Notifications & security</h3><p>Lightweight polling keeps staff informed without another external service.</p></div><div class="integration-row"><div><div class="primary-cell">Refresh interval</div><div class="secondary-cell">Orders, requests and notifications</div></div><span class="polling-value">${data.integrations.polling_seconds}s</span></div><div class="integration-row"><div><div class="primary-cell">Database access</div><div class="secondary-cell">Backend only</div></div>${badge("active")}</div></section>
        <div class="settings-actions"><button class="btn btn-primary settings-save" type="submit">Save settings</button></div>
      </form>
      <section class="panel settings-section security-settings"><div class="settings-card-head"><h3>Security</h3><p>Manage the username and password used to sign in to this admin dashboard.</p></div>
        <div class="security-grid">
          <form id="username-form" class="stack"><div class="field"><label for="current-username">Current username</label><input class="input" id="current-username" value="${escapeHtml(admin.username)}" readonly></div><div class="field"><label for="new-username">New username</label><input class="input" id="new-username" name="username" autocomplete="username" required placeholder="Enter a new username"></div><button class="btn" type="submit">Update Username</button></form>
          <form id="change-password-form" class="stack"><div class="field"><label for="current-password">Current password</label><input class="input" id="current-password" name="current_password" type="password" autocomplete="current-password" required></div><div class="field"><label for="new-password">New password</label><input class="input" id="new-password" name="new_password" type="password" autocomplete="new-password" minlength="8" required></div><div class="field"><label for="confirm-password">Confirm new password</label><input class="input" id="confirm-password" name="confirm_password" type="password" autocomplete="new-password" minlength="8" required></div><button class="btn btn-primary" type="submit">Change Password</button></form>
        </div>
      </section>
    </div></div>`;
  app.querySelector("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    let openingHours;
    try { openingHours = JSON.parse(values.opening_hours); } catch { toast("Opening hours must be valid JSON.", "error"); return; }
    const button = event.currentTarget.querySelector("[type='submit']");
    button.disabled = true;
    try {
      const result = await api("/admin/settings", { method: "PATCH", body: JSON.stringify({ ...values, delivery_charge: Number(values.delivery_charge), currency: values.currency.toUpperCase(), opening_hours: openingHours }) });
      state.session.restaurant = result.restaurant; state.session.admin = { ...state.session.admin, ...result.admin };
      toast("Settings saved."); renderShell(); navigateFromHash();
    } catch (error) { toast(error.message, "error"); button.disabled = false; }
  });
  app.querySelector("#username-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[type='submit']");
    const username = new FormData(event.currentTarget).get("username").trim();
    button.disabled = true;
    try {
      const result = await api("/admin/account/username", { method: "PATCH", body: JSON.stringify({ username }) });
      state.session.admin = { ...state.session.admin, ...result.admin };
      app.querySelector("#current-username").value = result.admin.username;
      app.querySelector("#new-username").value = "";
      toast("Username updated.");
    } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; }
  });
  app.querySelector("#change-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!values.current_password) { toast("Current password is required.", "error"); return; }
    if (!values.new_password || values.new_password.length < 8) { toast("Password must be at least 8 characters.", "error"); return; }
    if (!values.confirm_password) { toast("Password confirmation is required.", "error"); return; }
    if (values.new_password !== values.confirm_password) { toast("New passwords do not match.", "error"); return; }
    const button = event.currentTarget.querySelector("[type='submit']");
    button.disabled = true;
    try {
      const result = await api("/admin/change-password", { method: "POST", body: JSON.stringify(values) });
      event.currentTarget.reset();
      toast(result.message || "Password changed successfully.");
    } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; }
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

function activityKeyForRoute(route) {
  return ({
    dashboard: "dashboard_version",
    orders: "orders_version",
    requests: "requests_version",
    notifications: "notifications_version",
  })[route] || null;
}

async function refreshActivity({ refreshPageOnChange = false, signal } = {}) {
  if (!getAuthToken() || document.hidden) return;
  const activity = await api("/admin/activity", { forceRefresh: true, timeoutMs: 10000, signal });
  updateUnread(activity.unread_notifications);
  const versionKey = activityKeyForRoute(state.route);
  const changed = Boolean(
    refreshPageOnChange &&
    activitySnapshot &&
    versionKey &&
    activitySnapshot[versionKey] !== activity[versionKey]
  );
  if (changed) await loadCurrentPage({ background: true, forceRefresh: true });
  activitySnapshot = activity;
}

function stopPolling() {
  pollingGeneration += 1;
  clearTimeout(pollTimer);
  pollTimer = null;
  pollController?.abort();
  pollController = null;
  pollInFlight = false;
}

function startPolling() {
  stopPolling();
  const generation = pollingGeneration;
  const poll = async () => {
    if (!getAuthToken() || generation !== pollingGeneration) return;
    if (pollInFlight || pageLoadInFlight || document.hidden || modalRoot.childElementCount || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
      pollTimer = setTimeout(poll, 15000);
      return;
    }
    pollInFlight = true;
    pollController = new AbortController();
    try {
      await refreshActivity({ refreshPageOnChange: true, signal: pollController.signal });
    } catch (error) {
      if (!isAbortError(error)) console.warn("Background activity refresh failed:", error.message);
    } finally {
      pollInFlight = false;
      pollController = null;
      if (generation === pollingGeneration && getAuthToken()) pollTimer = setTimeout(poll, 15000);
    }
  };

  refreshActivity().catch(() => {});
  pollTimer = setTimeout(poll, 15000);
}

window.addEventListener("hashchange", () => state.session && navigateFromHash());
window.addEventListener("admin-auth-expired", () => {
  if (!state.session) return;
  appEntryId += 1;
  setAuthToken("");
  state.session = null;
  renderLogin("Your admin session expired. Sign in again.");
});
window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

async function enterAuthenticatedApp() {
  const entryId = ++appEntryId;
  state.session = state.session || {};
  renderShell();
  navigateFromHash();
  try {
    const session = await api("/admin/session", { cacheTtlMs: 10 * 60 * 1000, staleWhileRevalidate: true });
    if (entryId !== appEntryId || !getAuthToken()) return;
    state.session = session;
    applySessionToShell();
    startPolling();
  } catch (error) {
    if (entryId !== appEntryId || isAbortError(error)) return;
    setAuthToken("");
    state.session = null;
    renderLogin(error.message || "Sign in to continue.");
  }
}

async function boot() {
  if (!getAuthToken()) { renderLogin(); return; }
  await enterAuthenticatedApp();
}

boot();
