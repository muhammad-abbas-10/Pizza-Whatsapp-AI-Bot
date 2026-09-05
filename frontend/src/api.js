const configuredBase = String(import.meta.env.VITE_API_URL || "").trim();
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function resolveApiBase(value) {
  const fallback = window.location.origin;
  const normalized = value.replace(/\/$/, "");
  if (!normalized) return fallback;

  try {
    const configuredHost = new URL(normalized, fallback).hostname.toLowerCase();
    const pageHost = window.location.hostname.toLowerCase();

    // Never let a deployed site call a service on the visitor's computer.
    if (!loopbackHosts.has(pageHost) && loopbackHosts.has(configuredHost)) {
      return fallback;
    }
  } catch {
    return fallback;
  }

  return normalized;
}

export const API_BASE = resolveApiBase(configuredBase);

export function getAdminKey() {
  return sessionStorage.getItem("pizzaBarAdminKey") || "";
}

export function setAdminKey(value) {
  if (value) sessionStorage.setItem("pizzaBarAdminKey", value);
  else sessionStorage.removeItem("pizzaBarAdminKey");
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-admin-key", getAdminKey());
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new Error("Cannot reach the Pizza Bar backend. Confirm the deployment and network connection.");
  }

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent("admin-auth-expired"));
    const detail = typeof body === "object" ? (body.message || body.error) : body;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return body;
}

export async function download(path, filename) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { headers: { "x-admin-key": getAdminKey() } });
  } catch {
    throw new Error("Cannot reach the Pizza Bar backend. Confirm the deployment and network connection.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || "Download failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
