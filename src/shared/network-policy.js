/* Nightglass renderer networking. Uses only the document's native CORS boundary. */
(function attachNightglassNetworkPolicy(global) {
    "use strict";

    const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
    const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
    const MAX_DOCUMENT_REQUESTS = 128;
    const MAX_CONCURRENT_REQUESTS = 4;
    const MAX_QUEUED_REQUESTS = 64;
    const FETCH_TIMEOUT_MS = 20000;
    const LOCAL_HOST_ALIASES = new Set([
        "127-0-0-1.org.uk",
        "42foo.com",
        "broadcasthost",
        "domaincontrol.com",
        "fbi.com",
        "fuf.me",
        "ip6-localhost",
        "ip6-loopback",
        "lacolhost.com",
        "local.sisteminha.com",
        "localfabriek.nl",
        "localhost",
        "localhost.localdomain",
        "localhst.co.uk",
        "localmachine.info",
        "localmachine.name",
        "localtest.me",
        "lvh.me",
        "mouse-potato.com",
        "nip.io",
        "sslip.io",
        "vcap.me",
        "xip.io",
        "yoogle.com"
    ]);
    const LOCAL_HOST_SUFFIXES = [
        ".corp",
        ".direct",
        ".home",
        ".internal",
        ".intranet",
        ".lan",
        ".local",
        ".localdomain",
        ".localhost",
        ".test",
        ".zz"
    ].concat(Array.from(LOCAL_HOST_ALIASES, function toSuffix(alias) { return "." + alias; }));

    function normalizeHostname(value) {
        return String(value || "")
            .trim()
            .toLowerCase()
            .replace(/^\[|\]$/g, "")
            .replace(/\.+$/, "");
    }

    function isPublicHostname(value) {
        const hostname = normalizeHostname(value);
        if (
            !hostname ||
            !hostname.includes(".") ||
            hostname.includes(":") ||
            /^\d+(?:\.\d+){3}$/.test(hostname) ||
            LOCAL_HOST_ALIASES.has(hostname)
        ) {
            return false;
        }
        return !LOCAL_HOST_SUFFIXES.some(function matchesLocalSuffix(suffix) {
            return hostname.endsWith(suffix);
        });
    }

    function validatePublicHTTPSURL(value, runtime) {
        const environment = runtime || global;
        try {
            const parsed = new environment.URL(String(value));
            if (
                parsed.protocol !== "https:" ||
                parsed.username ||
                parsed.password ||
                parsed.port ||
                !isPublicHostname(parsed.hostname)
            ) {
                return "";
            }
            parsed.hash = "";
            return parsed.href;
        } catch (_error) {
            return "";
        }
    }

    function createConcurrencyGate(limit, maximumQueued) {
        let active = 0;
        const waiters = [];
        async function acquire() {
            if (active < limit) {
                active += 1;
                return;
            }
            if (waiters.length >= maximumQueued) {
                throw new Error("Nightglass renderer request queue is full.");
            }
            await new Promise(function wait(resolve) { waiters.push(resolve); });
        }
        function release() {
            const next = waiters.shift();
            if (next) {
                next();
            } else {
                active -= 1;
            }
        }
        return async function runWithSlot(operation) {
            await acquire();
            try {
                return await operation();
            } finally {
                release();
            }
        };
    }

    function createResourceBudget(maximumRequests, maximumBytes) {
        let requestCount = 0;
        let byteCount = 0;
        return Object.freeze({
            reserveRequest: function reserveRequest() {
                if (requestCount >= maximumRequests) {
                    throw new Error("Nightglass renderer request budget is exhausted.");
                }
                requestCount += 1;
            },
            recordBytes: function recordBytes(bytes) {
                const amount = Number(bytes);
                if (!Number.isSafeInteger(amount) || amount < 0) {
                    throw new Error("Nightglass renderer byte budget is exhausted.");
                }
                if (byteCount + amount > maximumBytes) {
                    byteCount = maximumBytes;
                    throw new Error("Nightglass renderer byte budget is exhausted.");
                }
                byteCount += amount;
            },
            snapshot: function snapshot() {
                return Object.freeze({requests: requestCount, bytes: byteCount});
            }
        });
    }

    async function readBoundedBody(response, limit, onBytes) {
        const maximum = Number.isSafeInteger(limit) && limit >= 0 ? limit : MAX_RESPONSE_BYTES;
        const record = typeof onBytes === "function" ? onBytes : function ignoreBytes() {};
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maximum) {
            throw new Error("Nightglass renderer response is too large.");
        }
        if (!response.body || typeof response.body.getReader !== "function") {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > maximum) {
                throw new Error("Nightglass renderer response is too large.");
            }
            record(bytes.byteLength);
            return bytes;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let byteLength = 0;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) {
                    break;
                }
                byteLength += chunk.value.byteLength;
                if (byteLength > maximum) {
                    await reader.cancel("response-too-large");
                    throw new Error("Nightglass renderer response is too large.");
                }
                try {
                    record(chunk.value.byteLength);
                } catch (error) {
                    await reader.cancel("document-byte-budget-exhausted");
                    throw error;
                }
                chunks.push(chunk.value);
            }
        } finally {
            reader.releaseLock();
        }
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }

    function copySafeHeaders(headers, runtime) {
        const result = new runtime.Headers();
        for (const name of ["cache-control", "content-language", "content-type", "etag", "last-modified"]) {
            const value = headers.get(name);
            if (value !== null) {
                result.set(name, value);
            }
        }
        return result;
    }

    function createCORSFetch(runtime, options) {
        const environment = runtime || global;
        const configuration = options || {};
        if (
            typeof environment.fetch !== "function" ||
            typeof environment.URL !== "function" ||
            typeof environment.Response !== "function" ||
            typeof environment.Headers !== "function" ||
            typeof environment.AbortController !== "function"
        ) {
            throw new Error("Nightglass requires the browser's native Fetch API.");
        }
        const maximumResponseBytes = configuration.maximumResponseBytes || MAX_RESPONSE_BYTES;
        const budget = createResourceBudget(
            configuration.maximumRequests || MAX_DOCUMENT_REQUESTS,
            configuration.maximumDocumentBytes || MAX_DOCUMENT_BYTES
        );
        const runWithSlot = createConcurrencyGate(
            configuration.maximumConcurrentRequests || MAX_CONCURRENT_REQUESTS,
            configuration.maximumQueuedRequests || MAX_QUEUED_REQUESTS
        );

        return async function fetchForRenderer(value) {
            const safeURL = validatePublicHTTPSURL(value, environment);
            if (!safeURL) {
                throw new TypeError("Nightglass only retrieves public HTTPS resources.");
            }
            budget.reserveRequest();
            return runWithSlot(async function performCORSRequest() {
                const controller = new environment.AbortController();
                const timeout = environment.setTimeout(function abortTimedOutRequest() {
                    controller.abort("fetch-timeout");
                }, configuration.timeoutMs || FETCH_TIMEOUT_MS);
                try {
                    const response = await environment.fetch(safeURL, {
                        method: "GET",
                        mode: "cors",
                        credentials: "omit",
                        redirect: "error",
                        referrerPolicy: "no-referrer",
                        signal: controller.signal
                    });
                    const finalURL = validatePublicHTTPSURL(response.url, environment);
                    if (!finalURL || finalURL !== safeURL || response.type === "opaque") {
                        if (response.body && typeof response.body.cancel === "function") {
                            await response.body.cancel("invalid-response");
                        }
                        throw new TypeError("Nightglass does not allow redirects or opaque responses.");
                    }
                    const bytes = await readBoundedBody(response, maximumResponseBytes, budget.recordBytes);
                    const empty = response.status === 204 || response.status === 205 || response.status === 304;
                    return new environment.Response(empty ? null : bytes, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: copySafeHeaders(response.headers, environment)
                    });
                } finally {
                    environment.clearTimeout(timeout);
                }
            });
        };
    }

    global.NightglassNetworkPolicy = Object.freeze({
        FETCH_TIMEOUT_MS,
        MAX_CONCURRENT_REQUESTS,
        MAX_DOCUMENT_BYTES,
        MAX_DOCUMENT_REQUESTS,
        MAX_QUEUED_REQUESTS,
        MAX_RESPONSE_BYTES,
        createCORSFetch,
        createConcurrencyGate,
        createResourceBudget,
        isPublicHostname,
        readBoundedBody,
        validatePublicHTTPSURL
    });
})(globalThis);
