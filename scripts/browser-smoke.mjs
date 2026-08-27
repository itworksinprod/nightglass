import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const port = Number(argument("port", "9222"));
const fixtureBase = argument("base", "http://127.0.0.1:18765").replace(/\/$/, "");
const outputDirectory = resolve(argument("output", "/private/tmp/nightglass-smoke"));
const requestedExtensionID = argument("extension-id", "").trim();
const userscriptArgument = argument("userscript", "").trim();
const userscriptPath = userscriptArgument ? resolve(userscriptArgument) : null;
const userscriptSource = userscriptPath ? await readFile(userscriptPath, "utf8") : null;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be a valid TCP port");
}

const debuggingBase = `http://127.0.0.1:${port}`;

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.nextID = 1;
    this.pending = new Map();
    this.waiters = new Map();
    socket.addEventListener("message", (event) => this.onMessage(event));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveConnection, rejectConnection) => {
      socket.addEventListener("open", resolveConnection, {once: true});
      socket.addEventListener("error", rejectConnection, {once: true});
    });
    return new CDPClient(socket);
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = this.pending.get(message.id);
      if (!request) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(`${request.method}: ${message.error.message}`));
      } else {
        request.resolve(message.result ?? {});
      }
      return;
    }
    const listeners = this.waiters.get(message.method);
    if (listeners?.length) {
      listeners.shift()(message.params ?? {});
    }
  }

  send(method, params = {}) {
    const id = this.nextID++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, {method, resolve: resolveRequest, reject: rejectRequest});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  waitFor(method, timeout = 15000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      const listeners = this.waiters.get(method) ?? [];
      listeners.push((params) => {
        clearTimeout(timer);
        resolveEvent(params);
      });
      this.waiters.set(method, listeners);
    });
  }

  close() {
    this.socket.close();
  }
}

async function targets() {
  const response = await fetch(`${debuggingBase}/json/list`);
  if (!response.ok) {
    throw new Error(`Cannot list Chrome targets: HTTP ${response.status}`);
  }
  return response.json();
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function navigate(client, url, settle = 2500) {
  const loaded = client.waitFor("Page.loadEventFired");
  await client.send("Page.navigate", {url});
  await loaded;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, settle));
}

async function installUserscript(client) {
  if (!userscriptSource) {
    return;
  }
  await evaluate(client, `(() => {
    const values = Object.create(null);
    globalThis.GM = {
      async getValue(key, fallback) { return Object.hasOwn(values, key) ? values[key] : fallback; },
      async setValue(key, value) { values[key] = value; },
      async deleteValue(key) { delete values[key]; },
    };
  })()`);
  const result = await client.send("Runtime.evaluate", {
    expression: `${userscriptSource}\n//# sourceURL=nightglass.user.js`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3500));
}

const pageSummaryExpression = `(() => {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  return {
    url: location.href,
    title: document.title,
    darkreaderNodes: document.querySelectorAll(".darkreader, [data-darkreader-mode]").length,
    darkreaderMode: document.documentElement.getAttribute("data-darkreader-mode"),
    darkreaderScheme: document.documentElement.getAttribute("data-darkreader-scheme"),
    prepaintPresent: Boolean(document.getElementById("nightglass-prepaint")),
    mediaDimPresent: Boolean(document.getElementById("nightglass-media-dim")),
    rootBackground: rootStyle.backgroundColor,
    bodyBackground: bodyStyle && bodyStyle.backgroundColor,
    bodyColor: bodyStyle && bodyStyle.color,
    liveCardPresent: Boolean(document.querySelector(".live-card")),
    liveCardBackground: document.querySelector(".live-card") ? getComputedStyle(document.querySelector(".live-card")).backgroundColor : null,
    corsCardBackground: document.querySelector(".cors-card") ? getComputedStyle(document.querySelector(".cors-card")).backgroundColor : null,
    noCorsCardBackground: document.querySelector(".nocors-card") ? getComputedStyle(document.querySelector(".nocors-card")).backgroundColor : null,
    mobileControlPresent: Boolean(document.querySelector("#nightglass-mobile-control")),
    mobileControlClosed: document.querySelector("#nightglass-mobile-control")
      ? document.querySelector("#nightglass-mobile-control").shadowRoot === null
      : null,
    userscriptReason: globalThis.__nightglassUserscriptController?.getSnapshot?.().reason ?? null,
  };
})()`;

const popupGeometryExpression = `(async () => {
  const body = document.body;
  const html = document.documentElement;
  const regionSelectors = [
    ".hero",
    ".site-panel",
    ".preset-grid",
    ".slider-stack",
    ".preference-panel",
    "footer",
  ];
  const regions = Object.fromEntries(regionSelectors.map((selector) => {
    const element = document.querySelector(selector);
    const rect = element?.getBoundingClientRect();
    return [selector, rect ? {
      left: rect.left,
      right: rect.right,
      width: rect.width,
    } : null];
  }));
  const beforeScroll = body.scrollTop;
  body.scrollTop = body.scrollHeight;
  await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  const maximumScrollTop = body.scrollTop;
  const footerRect = document.querySelector("footer")?.getBoundingClientRect();
  body.scrollTop = beforeScroll;

  return {
    viewport: {width: innerWidth, height: innerHeight},
    media: {
      coarsePointer: matchMedia("(hover: none) and (pointer: coarse)").matches,
      narrowViewport: matchMedia("(max-width: 350px)").matches,
    },
    html: {
      clientHeight: html.clientHeight,
      clientWidth: html.clientWidth,
      scrollHeight: html.scrollHeight,
      scrollWidth: html.scrollWidth,
    },
    body: {
      clientHeight: body.clientHeight,
      clientWidth: body.clientWidth,
      computedHeight: getComputedStyle(body).height,
      computedMinWidth: getComputedStyle(body).minWidth,
      computedWidth: getComputedStyle(body).width,
      maximumScrollTop,
      offsetHeight: body.offsetHeight,
      offsetWidth: body.offsetWidth,
      overflowY: getComputedStyle(body).overflowY,
      scrollHeight: body.scrollHeight,
      scrollWidth: body.scrollWidth,
    },
    footerAfterMaximumScroll: footerRect ? {
      bottom: footerRect.bottom,
      top: footerRect.top,
    } : null,
    regions,
  };
})()`;

function assertPopupGeometry(provisional, settled) {
  assert.deepEqual(
    provisional.viewport,
    {width: 50, height: 50},
    "the popup smoke test must reproduce Safari's 50x50 provisional viewport"
  );
  assert.equal(provisional.media.coarsePointer, false, "desktop popup rules must be active");
  assert.equal(provisional.body.computedWidth, "390px");
  assert.equal(provisional.body.computedMinWidth, "390px");
  assert.equal(provisional.body.offsetWidth, 390);
  assert.equal(provisional.body.computedHeight, "600px");
  assert.equal(provisional.body.offsetHeight, 600);
  assert(
    Object.values(provisional.regions).every((region) => region && region.width >= 350),
    "key popup regions must retain useful width during provisional layout"
  );

  assert.deepEqual(settled.viewport, {width: 390, height: 600});
  assert.equal(settled.body.offsetWidth, 390);
  assert.equal(settled.body.clientHeight, 600);
  assert.equal(settled.body.overflowY, "auto");
  assert(settled.body.scrollHeight > settled.body.clientHeight, "long popup content must scroll");
  assert(settled.body.maximumScrollTop > 0, "the popup body must accept vertical scrolling");
  assert(
    settled.footerAfterMaximumScroll && settled.footerAfterMaximumScroll.bottom <= 600.5,
    "maximum scroll must bring the footer into the popup viewport"
  );
  assert(
    settled.html.scrollWidth <= 390 && settled.body.scrollWidth <= 390,
    "settled desktop popup must not overflow horizontally"
  );
  assert(
    Object.values(settled.regions).every((region) =>
      region && region.left >= -0.5 && region.right <= 390.5 && region.width >= 350
    ),
    "key popup regions must fit the settled popup width"
  );
}

await mkdir(outputDirectory, {recursive: true});

const initialTargets = await targets();
const pageTarget = initialTargets.find((target) => target.type === "page");
if (!pageTarget) {
  throw new Error("No browser page target is available");
}

const client = await CDPClient.connect(pageTarget.webSocketDebuggerUrl);
await client.send("Page.enable");
await client.send("Runtime.enable");

if (userscriptSource) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
}

await navigate(client, `${fixtureBase}/lab.html`, 3500);
await installUserscript(client);
const lightFixture = await evaluate(client, pageSummaryExpression);
const activeTargets = await targets();
const extensionWorker = activeTargets.find((target) =>
  target.type === "service_worker" && /\/src\/extension\/background\.js$/.test(target.url)
);
const extensionID = requestedExtensionID || (extensionWorker ? new URL(extensionWorker.url).hostname : null);

await evaluate(client, `document.querySelector("#add-card").click()`);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
const dynamicFixture = await evaluate(client, pageSummaryExpression);

if (userscriptSource) {
  await evaluate(client, `globalThis.__nightglassMobileControl?.open()`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
}

const screenshot = await client.send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
const screenshotPath = join(outputDirectory, "lab-themed.png");
await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

let userscriptControl = null;
if (userscriptSource) {
  async function chooseSiteMode(mode) {
    await evaluate(client, `(async () => {
      const controller = globalThis.__nightglassUserscriptController;
      if (!controller) throw new Error("Missing isolated userscript controller");
      await controller.setSiteMode("${mode}");
    })()`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1800));
    return evaluate(client, pageSummaryExpression);
  }
  const off = await chooseSiteMode("off");
  const on = await chooseSiteMode("on");
  const auto = await chooseSiteMode("auto");
  userscriptControl = {
    pageCanReadShadowRoot: !off.mobileControlClosed,
    off: {darkreaderNodes: off.darkreaderNodes, reason: off.userscriptReason},
    on: {darkreaderNodes: on.darkreaderNodes, reason: on.userscriptReason},
    auto: {darkreaderNodes: auto.darkreaderNodes, reason: auto.userscriptReason},
  };
}

await navigate(client, `${fixtureBase}/native-dark.html`, 3500);
await installUserscript(client);
const nativeFixture = await evaluate(client, pageSummaryExpression);

let extensionUI = null;
if (extensionID) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(client, `chrome-extension://${extensionID}/src/ui/options.html`, 1200);
  const options = await evaluate(client, `(() => ({
    title: document.title,
    heading: document.querySelector("h1")?.textContent?.trim(),
    saveStatus: document.querySelector("#save-status")?.textContent?.trim(),
    presetCount: document.querySelectorAll("#preset-list input[type=radio]").length,
    enabled: document.querySelector("#enabled")?.checked,
  }))()`);
  const optionsCapture = await client.send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
  const optionsScreenshotPath = join(outputDirectory, "options.png");
  await writeFile(optionsScreenshotPath, Buffer.from(optionsCapture.data, "base64"));

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 50,
    height: 50,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(client, `chrome-extension://${extensionID}/src/ui/popup.html`, 1200);
  const provisionalGeometry = await evaluate(client, popupGeometryExpression);

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const settledGeometry = await evaluate(client, popupGeometryExpression);
  assertPopupGeometry(provisionalGeometry, settledGeometry);

  const popup = await evaluate(client, `(() => ({
    title: document.title,
    siteHeading: document.querySelector("#site-heading")?.textContent?.trim(),
    status: document.querySelector("#status-label")?.textContent?.trim(),
    presetCount: document.querySelectorAll("input[name=preset]").length,
    globalTogglePresent: Boolean(document.querySelector("#global-toggle")),
  }))()`);
  const popupCapture = await client.send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
  const popupScreenshotPath = join(outputDirectory, "popup.png");
  await writeFile(popupScreenshotPath, Buffer.from(popupCapture.data, "base64"));
  extensionUI = {
    options,
    optionsScreenshotPath,
    popup,
    popupScreenshotPath,
    popupGeometry: {
      provisional: provisionalGeometry,
      settled: settledGeometry,
    },
  };
}

const report = {
  extensionID,
  lightFixture,
  dynamicFixture,
  nativeFixture,
  extensionUI,
  userscriptControl,
  screenshotPath,
};
await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
client.close();
