import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadPolicy() {
  const context = vm.createContext({
    AbortController,
    Headers,
    Response,
    URL,
    Uint8Array,
    clearTimeout,
    setTimeout,
  });
  const source = await readFile(new URL("../src/shared/network-policy.js", import.meta.url), "utf8");
  vm.runInContext(source, context, {filename: "network-policy.js"});
  return context.NightglassNetworkPolicy;
}

function responseAt(url, body = "body", init = {}) {
  const response = new Response(body, {
    status: init.status || 200,
    statusText: init.statusText || "OK",
    headers: init.headers || {"content-type": "text/css", "set-cookie": "private=yes"},
  });
  Object.defineProperty(response, "url", {value: url});
  if (init.type) {
    Object.defineProperty(response, "type", {value: init.type});
  }
  return response;
}

test("renderer policy accepts only ordinary public HTTPS hostnames", async () => {
  const policy = await loadPolicy();
  assert.equal(
    policy.validatePublicHTTPSURL("https://cdn.example/style.css#fragment", {URL}),
    "https://cdn.example/style.css",
  );
  for (const blocked of [
    "http://cdn.example/style.css",
    "https://user:secret@cdn.example/style.css",
    "https://cdn.example:8443/style.css",
    "https://router/style.css",
    "https://localhost/style.css",
    "https://service.internal/style.css",
    "https://127.0.0.1/style.css",
    "https://8.8.8.8/style.css",
    "https://[2001:4860:4860::8888]/style.css",
    "data:text/css,body{}",
  ]) {
    assert.equal(policy.validatePublicHTTPSURL(blocked, {URL}), "", blocked);
  }
});

test("renderer fetch uses native CORS without credentials, redirects, or referrers", async () => {
  const policy = await loadPolicy();
  const calls = [];
  const runtime = {
    AbortController,
    Headers,
    Response,
    URL,
    clearTimeout,
    setTimeout,
    async fetch(url, options) {
      calls.push({url, options});
      return responseAt(url);
    },
  };
  const fetcher = policy.createCORSFetch(runtime);
  const response = await fetcher("https://cdn.example/style.css#fragment");
  assert.equal(await response.text(), "body");
  assert.equal(response.headers.get("content-type"), "text/css");
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(calls[0].url, "https://cdn.example/style.css");
  assert.deepEqual(
    {...calls[0].options, signal: undefined},
    {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: undefined,
    },
  );
  assert.ok(calls[0].options.signal instanceof AbortSignal);

  runtime.fetch = async () => responseAt("https://other.example/style.css");
  await assert.rejects(
    policy.createCORSFetch(runtime)("https://cdn.example/style.css"),
    /redirects or opaque responses/,
  );

  runtime.fetch = async (url) => responseAt(url, "body", {type: "opaque"});
  await assert.rejects(
    policy.createCORSFetch(runtime)("https://cdn.example/style.css"),
    /redirects or opaque responses/,
  );
});

test("renderer request, response, and lifetime budgets fail closed", async () => {
  const policy = await loadPolicy();
  const budget = policy.createResourceBudget(2, 3);
  budget.reserveRequest();
  budget.recordBytes(2);
  budget.reserveRequest();
  budget.recordBytes(1);
  assert.deepEqual({...budget.snapshot()}, {requests: 2, bytes: 3});
  assert.throws(() => budget.reserveRequest(), /request budget/);
  assert.throws(() => budget.recordBytes(1), /byte budget/);
  assert.equal(budget.snapshot().bytes, 3);

  const oversized = new Response("x", {headers: {"content-length": "11"}});
  await assert.rejects(policy.readBoundedBody(oversized, 10), /too large/);
  const streamedBudget = policy.createResourceBudget(1, 2);
  await assert.rejects(
    policy.readBoundedBody(new Response("four"), 5, streamedBudget.recordBytes),
    /byte budget/,
  );
  assert.equal(streamedBudget.snapshot().bytes, 2);

  const runtime = {
    AbortController,
    Headers,
    Response,
    URL,
    clearTimeout,
    setTimeout,
    fetch: async (url) => responseAt(url, "ok"),
  };
  const fetcher = policy.createCORSFetch(runtime, {
    maximumRequests: 1,
    maximumDocumentBytes: 2,
    maximumResponseBytes: 2,
  });
  assert.equal(await (await fetcher("https://cdn.example/a.css")).text(), "ok");
  await assert.rejects(fetcher("https://cdn.example/b.css"), /request budget/);
});
