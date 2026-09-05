const configuredBase = String(import.meta.env.VITE_API_URL || "").trim();
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_TIMEOUT_MS = 10000;
const inFlightGets = new Map();
const responseCache = new Map();
let bypassHttpCacheUntil = 0;
let cacheGeneration = 0;
let authGeneration = 0;

function resolveApiBase(value) {
  const fallback = window.location.origin;
  const normalized = value.replace(/\/$/, "");
  if (!normalized) return fallback;
  try {
    const configuredHost = new URL(normalized, fallback).hostname.toLowerCase();
    const pageHost = window.location.hostname.toLowerCase();
    if (!loopbackHosts.has(pageHost) && loopbackHosts.has(configuredHost)) return fallback;
  } catch {
    return fallback;
  }
  return normalized;
}

export const API_BASE = resolveApiBase(configuredBase);

export function clearApiCache() {
  responseCache.clear();
  cacheGeneration += 1;
}

export function getAdminKey() {
  return sessionStorage.getItem("pizzaBarAdminKey") || "";
}

export function setAdminKey(value) {
  const previous = getAdminKey();
  if (value) sessionStorage.setItem("pizzaBarAdminKey", value);
  else sessionStorage.removeItem("pizzaBarAdminKey");
  if (previous !== (value || "")) {
    authGeneration += 1;
    clearApiCache();
  }
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

function cacheKey(path) {
  return `${authGeneration}:${path}`;
}

function requestController(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function fetchJson(path, options, method) {
  const {
    timeoutMs, forceRefresh, cacheTtlMs, staleWhileRevalidate,
    onRevalidate, onRevalidateError, signal, ...fetchOptions
  } = options;
  const headers = new Headers(options.headers || {});
  headers.set("x-admin-key", getAdminKey());
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const controlled = requestController(signal, timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      method,
      headers,
      signal: controlled.signal,
      cache: forceRefresh || Date.now() < bypassHttpCacheUntil ? "reload" : (fetchOptions.cache || "default"),
    });
    const isJson = response.headers.get("content-type")?.includes("application/json");
    const body = isJson ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new CustomEvent("admin-auth-expired"));
      const detail = typeof body === "object" ? (body.message || body.error) : body;
      throw new Error(detail || `Request failed (${response.status})`);
    }
    return body;
  } catch (error) {
    if (controlled.timedOut()) {
      const timeoutError = new Error("The Pizza Bar backend took too long to respond. Please try again.");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    if (controlled.signal.aborted) {
      const abortError = new Error("Request cancelled");
      abortError.name = "AbortError";
      throw abortError;
    }
    if (error instanceof TypeError) throw new Error("Cannot reach the Pizza Bar backend. Confirm the deployment and network connection.");
    throw error;
  } finally {
    controlled.cleanup();
  }
}

function networkGet(path, options, key) {
  const existing = inFlightGets.get(key);
  if (existing && !existing.signal?.aborted) return existing.promise;
  if (existing) inFlightGets.delete(key);
  const requestGeneration = cacheGeneration;
  const entry = { signal: options.signal, promise: null };
  const promise = fetchJson(path, options, "GET")
    .then((data) => {
      if (options.cacheTtlMs > 0 && requestGeneration === cacheGeneration) {
        responseCache.set(key, { data, storedAt: Date.now() });
      }
      return data;
    })
    .finally(() => {
      if (inFlightGets.get(key) === entry) inFlightGets.delete(key);
    });
  entry.promise = promise;
  inFlightGets.set(key, entry);
  return promise;
}

export async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const requestOptions = { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  if (method !== "GET") {
    const data = await fetchJson(path, requestOptions, method);
    clearApiCache();
    bypassHttpCacheUntil = Date.now() + 10000;
    return data;
  }

  const key = cacheKey(path);
  const cached = responseCache.get(key);
  const ttl = Math.max(0, Number(requestOptions.cacheTtlMs) || 0);
  const isFresh = cached && Date.now() - cached.storedAt <= ttl;
  if (!requestOptions.forceRefresh && isFresh) return cached.data;

  if (!requestOptions.forceRefresh && cached && requestOptions.staleWhileRevalidate) {
    const refresh = networkGet(path, { ...requestOptions, forceRefresh: true }, key);
    refresh.then((data) => requestOptions.onRevalidate?.(data)).catch((error) => {
      if (!isAbortError(error)) requestOptions.onRevalidateError?.(error);
    });
    return cached.data;
  }
  return networkGet(path, requestOptions, key);
}

export async function download(path, filename, options = {}) {
  const controlled = requestController(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { "x-admin-key": getAdminKey() },
      signal: controlled.signal,
      cache: "no-store",
    });
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
  } catch (error) {
    if (controlled.timedOut()) throw new Error("The download timed out. Please try again.");
    if (controlled.signal.aborted) {
      const abortError = new Error("Request cancelled");
      abortError.name = "AbortError";
      throw abortError;
    }
    if (error instanceof TypeError) throw new Error("Cannot reach the Pizza Bar backend.");
    throw error;
  } finally {
    controlled.cleanup();
  }
}
