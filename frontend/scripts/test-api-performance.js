import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let source = fs.readFileSync(new URL("../src/api.js", import.meta.url), "utf8");
source = source
  .replace("import.meta.env.VITE_API_URL", '""')
  .replaceAll("export ", "")
  .concat("\nglobalThis.__api = { api, setAdminKey };\n");

const storage = new Map();
const calls = [];
let serial = 0;

function response(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function mockFetch(url, options = {}) {
  const path = new URL(url).pathname;
  const method = options.method || "GET";
  calls.push({ path, method });
  const wait = path === "/slow" || path === "/abort" ? 200 : path === "/late" ? 50 : 20;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, wait);
    const abort = () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
  return response({ path, method, serial: ++serial });
}

const context = vm.createContext({
  AbortController, CustomEvent, FormData, Headers, Response, URL,
  clearTimeout, console, Date, Error, Map, Math, Promise, Set, String, TypeError, setTimeout,
  fetch: mockFetch,
  sessionStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  window: {
    dispatchEvent() {},
    location: { hostname: "example.test", origin: "https://example.test" },
  },
});
vm.runInContext(source, context);
const { api, setAdminKey } = context.__api;
setAdminKey("test-key");

const countCalls = (path, method = "GET") => calls.filter((call) => call.path === path && call.method === method).length;

const [first, duplicate] = await Promise.all([
  api("/dedupe", { cacheTtlMs: 1000 }),
  api("/dedupe", { cacheTtlMs: 1000 }),
]);
assert.equal(countCalls("/dedupe"), 1, "identical in-flight GETs should share one request");
assert.deepEqual(first, duplicate);
await api("/dedupe", { cacheTtlMs: 1000 });
assert.equal(countCalls("/dedupe"), 1, "a fresh cache entry should avoid the network");

const cached = await api("/swr", { cacheTtlMs: 1 });
await new Promise((resolve) => setTimeout(resolve, 5));
let revalidated;
const staleStarted = performance.now();
const stale = await api("/swr", {
  cacheTtlMs: 1,
  staleWhileRevalidate: true,
  onRevalidate: (value) => { revalidated = value; },
});
assert.equal(stale.serial, cached.serial, "stale data should render immediately");
assert.ok(performance.now() - staleStarted < 15, "stale cache reads should not wait for the network");
await new Promise((resolve) => setTimeout(resolve, 35));
assert.ok(revalidated?.serial > cached.serial, "stale cache entries should refresh in the background");

const navigationController = new AbortController();
const cancelled = api("/abort", { signal: navigationController.signal }).catch((error) => error);
navigationController.abort();
assert.equal((await cancelled).name, "AbortError", "navigation should cancel obsolete requests");

const timeoutError = await api("/slow", { timeoutMs: 25 }).catch((error) => error);
assert.equal(timeoutError.name, "TimeoutError", "requests should fail with a finite timeout");

await api("/mutation-cache", { cacheTtlMs: 1000 });
await api("/mutation", { method: "POST", body: "{}" });
await api("/mutation-cache", { cacheTtlMs: 1000 });
assert.equal(countCalls("/mutation-cache"), 2, "writes should invalidate cached reads");

const late = api("/late", { cacheTtlMs: 1000 });
await new Promise((resolve) => setTimeout(resolve, 5));
await api("/second-mutation", { method: "POST", body: "{}" });
await late;
await api("/late", { cacheTtlMs: 1000 });
assert.equal(countCalls("/late"), 2, "a GET finishing after a write must not repopulate stale cache data");

console.log("API timeout, cancellation, deduplication, cache, SWR, and invalidation tests: PASS");
