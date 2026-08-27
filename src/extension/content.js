/* Nightglass document controller. Runs at document_start in every permitted frame. */
(function startNightglassContent(global) {
    "use strict";

    const STORAGE_KEY_FALLBACK = "nightglassSettings";
    const MEDIA_STYLE_ID = "nightglass-media-dim";
    const MAX_DECLARATION_RULES = 2500;

    function clamp(value, minimum, maximum, fallback) {
        const number = Number(value);
        return Number.isFinite(number)
            ? Math.min(maximum, Math.max(minimum, number))
            : fallback;
    }

    function parseClock(value) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
        if (!match) {
            return null;
        }
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
    }

    function scheduleIsActive(schedule, now = new Date()) {
        const start = parseClock(schedule && schedule.start);
        const end = parseClock(schedule && schedule.end);
        if (start === null || end === null) {
            return false;
        }
        if (start === end) {
            return true;
        }
        const current = now.getHours() * 60 + now.getMinutes();
        return start < end
            ? current >= start && current < end
            : current >= start || current < end;
    }

    function millisecondsToScheduleBoundary(schedule, now = new Date()) {
        const clocks = [parseClock(schedule && schedule.start), parseClock(schedule && schedule.end)]
            .filter((clock) => clock !== null);
        if (clocks.length !== 2 || clocks[0] === clocks[1]) {
            return null;
        }
        let soonest = Infinity;
        for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
            for (const clock of clocks) {
                const candidate = new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate() + dayOffset,
                    Math.floor(clock / 60),
                    clock % 60,
                    0,
                    0
                );
                const delay = candidate.getTime() - now.getTime();
                if (delay > 250 && delay < soonest) {
                    soonest = delay;
                }
            }
        }
        return Number.isFinite(soonest) ? soonest + 50 : null;
    }

    function normalizeSiteMode(value) {
        return String(value || "inherit").trim().toLowerCase();
    }

    function activationDecision(settings, systemDark, now = new Date()) {
        if (!settings || settings.globalEnabled === false) {
            return {active: false, force: false, reason: "globally-disabled"};
        }
        const siteMode = normalizeSiteMode(settings.siteMode || settings.siteRule && settings.siteRule.mode);
        if (["off", "disabled", "never"].includes(siteMode)) {
            return {active: false, force: false, reason: "site-disabled"};
        }
        if (settings.enabled === false) {
            return {active: false, force: false, reason: "globally-disabled"};
        }
        if (siteMode === "native") {
            return {active: false, force: false, reason: "site-native"};
        }
        if (["force", "on", "enabled"].includes(siteMode)) {
            return {active: true, force: true, reason: "site-forced"};
        }

        const activation = String(settings.activation || "always").toLowerCase();
        if (activation === "system") {
            return {
                active: Boolean(systemDark),
                force: false,
                reason: systemDark ? "system-dark" : "system-light"
            };
        }
        if (activation === "schedule") {
            const active = scheduleIsActive(settings.schedule, now);
            return {active, force: false, reason: active ? "schedule-active" : "schedule-inactive"};
        }
        if (activation === "off" || activation === "never") {
            return {active: false, force: false, reason: "activation-disabled"};
        }
        return {active: true, force: false, reason: "always"};
    }

    function parseRenderedColor(value) {
        const source = String(value || "").trim().toLowerCase();
        if (!source || source === "transparent") {
            return {r: 0, g: 0, b: 0, a: 0};
        }
        let match = /^rgba?\((.*)\)$/.exec(source);
        let channels;
        if (match) {
            channels = match[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
            if (channels.length < 3) {
                return null;
            }
            const parseChannel = (channel) => channel.endsWith("%")
                ? clamp(parseFloat(channel) * 2.55, 0, 255, 0)
                : clamp(parseFloat(channel), 0, 255, 0);
            const alpha = channels[3] === undefined
                ? 1
                : channels[3].endsWith("%")
                    ? clamp(parseFloat(channels[3]) / 100, 0, 1, 1)
                    : clamp(parseFloat(channels[3]), 0, 1, 1);
            return {r: parseChannel(channels[0]), g: parseChannel(channels[1]), b: parseChannel(channels[2]), a: alpha};
        }
        match = /^color\(srgb\s+(.+)\)$/.exec(source);
        if (match) {
            channels = match[1].replace(/\//g, " ").split(/\s+/).filter(Boolean);
            if (channels.length < 3) {
                return null;
            }
            return {
                r: clamp(parseFloat(channels[0]) * 255, 0, 255, 0),
                g: clamp(parseFloat(channels[1]) * 255, 0, 255, 0),
                b: clamp(parseFloat(channels[2]) * 255, 0, 255, 0),
                a: channels[3] === undefined ? 1 : clamp(parseFloat(channels[3]), 0, 1, 1)
            };
        }
        return null;
    }

    function relativeLuminance(color) {
        const linearize = (channel) => {
            const normalized = channel / 255;
            return normalized <= 0.04045
                ? normalized / 12.92
                : Math.pow((normalized + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
    }

    function inspectDarkDeclarations(doc) {
        const result = {
            meta: false,
            colorScheme: false,
            darkMedia: false,
            lightDarkFunction: false,
            ruleCount: 0,
            detected: false
        };
        const meta = doc.querySelector('meta[name="color-scheme" i]');
        result.meta = Boolean(meta && /(?:^|[\s,])dark(?:$|[\s,])/i.test(meta.content || ""));

        try {
            const rootScheme = global.getComputedStyle(doc.documentElement).colorScheme || "";
            result.colorScheme = /(?:^|\s)dark(?:$|\s)/i.test(rootScheme);
        } catch (_) {
            // A detached root simply contributes no declaration evidence.
        }

        for (const node of doc.querySelectorAll("style, link[rel~='stylesheet']")) {
            if (node.id === "nightglass-prepaint" || node.classList && node.classList.contains("darkreader")) {
                continue;
            }
            const media = node.media || node.getAttribute && node.getAttribute("media") || "";
            if (/prefers-color-scheme\s*:\s*dark/i.test(media)) {
                result.darkMedia = true;
            }
            if (node.localName === "style" && /light-dark\s*\(/i.test(String(node.textContent || "").slice(0, 250000))) {
                result.lightDarkFunction = true;
            }
        }

        const visitRules = (rules) => {
            if (!rules || result.ruleCount >= MAX_DECLARATION_RULES) {
                return;
            }
            for (const rule of rules) {
                if (result.ruleCount >= MAX_DECLARATION_RULES) {
                    return;
                }
                result.ruleCount += 1;
                const condition = String(rule.conditionText || rule.media && rule.media.mediaText || "");
                if (/prefers-color-scheme\s*:\s*dark/i.test(condition)) {
                    result.darkMedia = true;
                }
                const cssText = String(rule.cssText || "").slice(0, 250000);
                if (/light-dark\s*\(/i.test(cssText)) {
                    result.lightDarkFunction = true;
                }
                try {
                    if (rule.cssRules) {
                        visitRules(rule.cssRules);
                    }
                } catch (_) {
                    // Cross-origin and protected sheets are intentionally skipped.
                }
            }
        };

        for (const sheet of Array.from(doc.styleSheets || [])) {
            const owner = sheet.ownerNode;
            if (owner && (owner.id === "nightglass-prepaint" || owner.classList && owner.classList.contains("darkreader"))) {
                continue;
            }
            try {
                visitRules(sheet.cssRules);
            } catch (_) {
                // Cross-origin sheets are normal; rendered sampling remains available.
            }
        }
        result.detected = result.meta || result.colorScheme || result.darkMedia || result.lightDarkFunction;
        return result;
    }

    function sampleRenderedSurfaces(doc) {
        const viewportWidth = Math.max(1, global.innerWidth || doc.documentElement.clientWidth || 1);
        const viewportHeight = Math.max(1, global.innerHeight || doc.documentElement.clientHeight || 1);
        const viewportArea = viewportWidth * viewportHeight;
        const elements = [];
        const seen = new Set();
        const add = (element) => {
            if (element && !seen.has(element) && elements.length < 50) {
                seen.add(element);
                elements.push(element);
            }
        };
        add(doc.documentElement);
        add(doc.body);
        for (const element of doc.querySelectorAll("main, article, section, header, nav, aside, [role='main'], [role='dialog']")) {
            add(element);
        }

        const samples = [];
        for (const element of elements) {
            let rect;
            let computed;
            try {
                rect = element.getBoundingClientRect();
                computed = global.getComputedStyle(element);
            } catch (_) {
                continue;
            }
            if (computed.display === "none" || computed.visibility === "hidden") {
                continue;
            }
            const color = parseRenderedColor(computed.backgroundColor);
            if (!color || color.a < 0.5) {
                continue;
            }
            const isRootSurface = element === doc.documentElement || element === doc.body;
            const visibleWidth = isRootSurface
                ? viewportWidth
                : Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
            const visibleHeight = isRootSurface
                ? viewportHeight
                : Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
            const weight = Math.min(viewportArea, visibleWidth * visibleHeight);
            if (weight < 64) {
                continue;
            }
            samples.push({luminance: relativeLuminance(color), weight});
        }

        if (samples.length === 0) {
            return {sampleCount: 0, averageLuminance: 1, darkShare: 0, dark: false};
        }
        let weightedLuminance = 0;
        let darkWeight = 0;
        let totalWeight = 0;
        for (const sample of samples) {
            weightedLuminance += sample.luminance * sample.weight;
            totalWeight += sample.weight;
            if (sample.luminance < 0.4) {
                darkWeight += sample.weight;
            }
        }
        const averageLuminance = weightedLuminance / totalWeight;
        const darkShare = darkWeight / totalWeight;
        return {
            sampleCount: samples.length,
            averageLuminance,
            darkShare,
            dark: averageLuminance < 0.35 && darkShare >= 0.55
        };
    }

    function detectNativeDark(doc) {
        const declaration = inspectDarkDeclarations(doc);
        const rendered = sampleRenderedSurfaces(doc);
        return {nativeDark: declaration.detected && rendered.dark, declaration, rendered};
    }

    function stableStringify(value) {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            return `[${value.map(stableStringify).join(",")}]`;
        }
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }

    function cleanSelectorList(value) {
        if (!Array.isArray(value)) {
            return undefined;
        }
        const selectors = value
            .filter((selector) => typeof selector === "string")
            .map((selector) => selector.trim())
            .filter(Boolean)
            .slice(0, 500);
        return selectors.length ? selectors : undefined;
    }

    function createDarkReaderConfiguration(settings) {
        const source = Object.assign({}, settings || {}, settings && settings.theme || {});
        const theme = {
            mode: 1,
            brightness: clamp(source.brightness, 0, 200, 100),
            contrast: clamp(source.contrast, 0, 200, 100),
            sepia: clamp(source.sepia, 0, 100, 0),
            grayscale: clamp(source.grayscale, 0, 100, 0),
            styleSystemControls: true,
            immediateModify: true
        };
        if (typeof source.backgroundColor === "string" && source.backgroundColor.trim()) {
            theme.darkSchemeBackgroundColor = source.backgroundColor.trim();
        }
        if (typeof source.textColor === "string" && source.textColor.trim()) {
            theme.darkSchemeTextColor = source.textColor.trim();
        }

        const rawFixes = settings && settings.fixes && typeof settings.fixes === "object"
            ? settings.fixes
            : {};
        const fixes = {};
        for (const key of ["invert", "ignoreInlineStyle", "ignoreImageAnalysis", "ignoreCSSUrl"]) {
            const selectors = cleanSelectorList(rawFixes[key]);
            if (selectors) {
                fixes[key] = selectors;
            }
        }
        const cssParts = [];
        if (typeof rawFixes.css === "string" && rawFixes.css.trim()) {
            cssParts.push(rawFixes.css.trim());
        }
        if (typeof settings.customCSS === "string" && settings.customCSS.trim()) {
            cssParts.push(settings.customCSS.trim());
        }
        if (cssParts.length) {
            fixes.css = cssParts.join("\n");
        }
        if (typeof rawFixes.disableStyleSheetsProxy === "boolean") {
            fixes.disableStyleSheetsProxy = rawFixes.disableStyleSheetsProxy;
        }
        const imageDim = clamp(source.imageDim, 0, 100, 0);
        return {theme, fixes: Object.keys(fixes).length ? fixes : null, imageDim};
    }

    const testAPI = {
        activationDecision,
        createDarkReaderConfiguration,
        detectNativeDark,
        inspectDarkDeclarations,
        millisecondsToScheduleBoundary,
        parseClock,
        parseRenderedColor,
        relativeLuminance,
        sampleRenderedSurfaces,
        scheduleIsActive,
        stableStringify
    };
    global.NightglassRuntimeTest = Object.assign(global.NightglassRuntimeTest || {}, testAPI);

    const browserAPI = global.browser;
    const DarkReader = global.DarkReader;
    const Settings = global.NightglassSettings;
    const NetworkPolicy = global.NightglassNetworkPolicy;
    if (!browserAPI || !global.document || !DarkReader || !Settings || !NetworkPolicy) {
        if (global.NightglassPrepaint) {
            global.NightglassPrepaint.release();
        }
        return;
    }
    if (global.__nightglassController) {
        global.__nightglassController.evaluate({reload: true});
        return;
    }

    const systemScheme = global.matchMedia("(prefers-color-scheme: dark)");
    const forcedColors = global.matchMedia("(forced-colors: active)");
    let isTopFrame = false;
    try {
        isTopFrame = global.top === global;
    } catch (_) {
        isTopFrame = false;
    }
    const state = {
        applied: false,
        destroyed: false,
        detection: null,
        errorCode: null,
        evaluation: 0,
        lastSignature: null,
        nativeDark: false,
        reason: "starting",
        resolved: null,
        scheduleTimer: null,
        settings: null,
        suspended: false,
        transientSiteMode: null
    };

    function releasePrepaint() {
        if (global.NightglassPrepaint) {
            global.NightglassPrepaint.release();
        }
    }

    function removeMediaDimStyle() {
        const node = global.document.getElementById(MEDIA_STYLE_ID);
        if (node) {
            node.remove();
        }
    }

    function updateMediaDimStyle(amount) {
        removeMediaDimStyle();
        if (!(amount > 0)) {
            return;
        }
        const brightness = Math.max(0, 1 - amount / 100).toFixed(3);
        const node = global.document.createElement("style");
        node.id = MEDIA_STYLE_ID;
        node.dataset.nightglassOwned = "media-dim";
        node.textContent = `@media screen and (forced-colors: none) {\n` +
            `  :where(img, video, canvas) { filter: brightness(${brightness}) !important; }\n` +
            `}`;
        (global.document.head || global.document.documentElement).appendChild(node);
    }

    function disableTheme(reason, clearDetection = false) {
        releasePrepaint();
        removeMediaDimStyle();
        if (state.applied || typeof DarkReader.isEnabled === "function" && DarkReader.isEnabled()) {
            try {
                DarkReader.disable();
            } catch (_) {
                state.errorCode = "renderer-disable-failed";
            }
        }
        state.applied = false;
        state.lastSignature = null;
        state.reason = reason;
        if (clearDetection) {
            state.detection = null;
            state.nativeDark = false;
        }
    }

    function suspendThemeForSampling() {
        removeMediaDimStyle();
        if (state.applied || typeof DarkReader.isEnabled === "function" && DarkReader.isEnabled()) {
            try {
                DarkReader.disable();
            } catch (_) {
                state.errorCode = "renderer-disable-failed";
            }
        }
        state.applied = false;
        state.lastSignature = null;
        releasePrepaint();
    }

    function status() {
        const rendered = state.detection && state.detection.rendered;
        const declaration = state.detection && state.detection.declaration;
        return {
            enabled: Boolean(state.resolved && state.resolved.enabled !== false),
            globalEnabled: Boolean(state.resolved && state.resolved.globalEnabled !== false),
            applied: state.applied,
            reason: state.reason,
            nativeDark: state.nativeDark,
            forcedColors: forcedColors.matches,
            hostname: String(global.location.hostname || "").toLowerCase(),
            mode: state.resolved && state.resolved.activation || "always",
            siteMode: state.resolved && normalizeSiteMode(state.resolved.siteMode || state.resolved.siteRule && state.resolved.siteRule.mode),
            preset: state.resolved && state.resolved.preset || null,
            diagnostics: {
                declarationDetected: Boolean(declaration && declaration.detected),
                sampleCount: rendered ? rendered.sampleCount : 0,
                averageLuminance: rendered ? Number(rendered.averageLuminance.toFixed(3)) : null,
                darkShare: rendered ? Number(rendered.darkShare.toFixed(3)) : null,
                errorCode: state.errorCode
            }
        };
    }

    async function loadSettings() {
        const storageKey = Settings.STORAGE_KEY || STORAGE_KEY_FALLBACK;
        const stored = await browserAPI.storage.local.get(storageKey);
        const normalized = Settings.normalizeSettings(stored && stored[storageKey]);
        const hostname = String(global.location.hostname || "").toLowerCase();
        const resolved = Object.assign({}, Settings.resolveSettingsForHost(normalized, hostname));
        if (state.transientSiteMode) {
            resolved.siteMode = state.transientSiteMode;
        }
        return {normalized, resolved};
    }

    function clearScheduleTimer() {
        if (state.scheduleTimer !== null) {
            global.clearTimeout(state.scheduleTimer);
            state.scheduleTimer = null;
        }
    }

    function armScheduleTimer(resolved) {
        clearScheduleTimer();
        if (!resolved || String(resolved.activation).toLowerCase() !== "schedule") {
            return;
        }
        const delay = millisecondsToScheduleBoundary(resolved.schedule);
        if (delay !== null) {
            state.scheduleTimer = global.setTimeout(() => {
                state.scheduleTimer = null;
                controller.evaluate({reload: true});
            }, Math.min(delay, 0x7fffffff));
        }
    }

    function waitUntilInspectable() {
        if (global.document.readyState !== "loading") {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            global.document.addEventListener("DOMContentLoaded", resolve, {once: true});
        });
    }

    async function applyResolved(resolved, options = {}) {
        const generation = ++state.evaluation;
        state.errorCode = null;
        state.resolved = resolved;
        armScheduleTimer(resolved);

        if (state.suspended || state.destroyed) {
            disableTheme("suspended");
            return status();
        }
        if (forcedColors.matches) {
            disableTheme("forced-colors", true);
            return status();
        }

        const decision = activationDecision(resolved, systemScheme.matches);
        if (!decision.active) {
            disableTheme(decision.reason, true);
            return status();
        }

        const preserveNative = resolved.detectNativeDark !== false &&
            String(resolved.nativeDarkBehavior || "preserve").toLowerCase() !== "theme" &&
            !decision.force;
        if (preserveNative) {
            await waitUntilInspectable();
            if (generation !== state.evaluation || state.suspended || state.destroyed) {
                return status();
            }
            // Remove Nightglass paint before synchronously sampling authored rendering.
            // Sampling and the eventual enable happen in one task, avoiding an unthemed frame.
            suspendThemeForSampling();
            state.detection = detectNativeDark(global.document);
            state.nativeDark = state.detection.nativeDark;
            if (state.nativeDark) {
                state.reason = "native-dark";
                return status();
            }
        } else {
            state.detection = null;
            state.nativeDark = false;
            releasePrepaint();
        }

        const configuration = createDarkReaderConfiguration(resolved);
        const signature = stableStringify(configuration);
        if (!options.force && state.applied && signature === state.lastSignature) {
            updateMediaDimStyle(configuration.imageDim);
            state.reason = decision.reason;
            return status();
        }
        try {
            DarkReader.enable(configuration.theme, configuration.fixes);
            updateMediaDimStyle(configuration.imageDim);
            state.applied = true;
            state.lastSignature = signature;
            state.reason = decision.reason;
        } catch (_) {
            state.errorCode = "renderer-enable-failed";
            disableTheme("renderer-error");
        }
        return status();
    }

    async function evaluate(options = {}) {
        if (state.destroyed) {
            return status();
        }
        try {
            if (options.reload !== false || !state.resolved) {
                const loaded = await loadSettings();
                state.settings = loaded.normalized;
                state.resolved = loaded.resolved;
            }
            return await applyResolved(state.resolved, options);
        } catch (_) {
            state.errorCode = "settings-load-failed";
            disableTheme("settings-error", true);
            return status();
        }
    }

    async function toggleCurrentSite() {
        const hostname = String(global.location.hostname || "").toLowerCase();
        const turnOff = state.applied || state.reason === "native-dark" || state.reason === "site-forced";
        const nextMode = turnOff ? "off" : "on";
        if (typeof Settings.setSiteMode === "function" && hostname) {
            const loaded = await loadSettings();
            const next = Settings.setSiteMode(loaded.normalized, hostname, nextMode);
            const storageKey = Settings.STORAGE_KEY || STORAGE_KEY_FALLBACK;
            await browserAPI.storage.local.set({[storageKey]: next});
            state.transientSiteMode = null;
        } else {
            state.transientSiteMode = nextMode;
        }
        return evaluate({reload: true, force: true});
    }

    const fetchThroughPageCORS = NetworkPolicy.createCORSFetch(global);
    DarkReader.setFetchMethod(fetchThroughPageCORS);

    function onStorageChanged(changes, areaName) {
        const storageKey = Settings.STORAGE_KEY || STORAGE_KEY_FALLBACK;
        if (areaName === "local" && changes && Object.prototype.hasOwnProperty.call(changes, storageKey)) {
            state.transientSiteMode = null;
            controller.evaluate({reload: true});
        }
    }

    function onMediaChanged() {
        if (forcedColors.matches) {
            disableTheme("forced-colors", true);
        } else {
            if (global.NightglassPrepaint) {
                global.NightglassPrepaint.ensure(state.settings || {});
            }
            controller.evaluate({reload: true});
        }
    }

    function onRuntimeMessage(message, sender) {
        if (!message || typeof message.type !== "string") {
            return undefined;
        }
        if (sender && sender.id && browserAPI.runtime.id && sender.id !== browserAPI.runtime.id) {
            return undefined;
        }
        if (message.type === "nightglass:get-status") {
            if (!isTopFrame) {
                return undefined;
            }
            return Promise.resolve({ok: true, status: status()});
        }
        if (message.type === "nightglass:apply") {
            return controller.evaluate({reload: true, force: true}).then((nextStatus) => ({ok: true, status: nextStatus}));
        }
        if (message.type === "nightglass:toggle") {
            if (!isTopFrame) {
                return undefined;
            }
            return toggleCurrentSite()
                .then((nextStatus) => ({ok: true, status: nextStatus}))
                .catch(() => ({ok: false, error: "toggle-failed", status: status()}));
        }
        return undefined;
    }

    function addMediaListener(query, listener) {
        if (typeof query.addEventListener === "function") {
            query.addEventListener("change", listener);
        } else if (typeof query.addListener === "function") {
            query.addListener(listener);
        }
    }

    function removeMediaListener(query, listener) {
        if (typeof query.removeEventListener === "function") {
            query.removeEventListener("change", listener);
        } else if (typeof query.removeListener === "function") {
            query.removeListener(listener);
        }
    }

    function onPageHide(event) {
        state.suspended = Boolean(event.persisted);
        clearScheduleTimer();
        disableTheme(event.persisted ? "bfcache-suspended" : "page-hidden");
        if (!event.persisted) {
            controller.destroy();
        }
    }

    function onPageShow(event) {
        if (!event.persisted) {
            return;
        }
        state.suspended = false;
        if (global.NightglassPrepaint) {
            global.NightglassPrepaint.ensure(state.settings || {});
        }
        controller.evaluate({reload: true, force: true});
    }

    function destroy() {
        if (state.destroyed) {
            return;
        }
        state.destroyed = true;
        ++state.evaluation;
        clearScheduleTimer();
        disableTheme("destroyed", true);
        browserAPI.storage.onChanged.removeListener(onStorageChanged);
        browserAPI.runtime.onMessage.removeListener(onRuntimeMessage);
        removeMediaListener(systemScheme, onMediaChanged);
        removeMediaListener(forcedColors, onMediaChanged);
        global.removeEventListener("pagehide", onPageHide);
        global.removeEventListener("pageshow", onPageShow);
        try {
            DarkReader.setFetchMethod(null);
        } catch (_) {
            // The document is going away; renderer cleanup has already completed.
        }
    }

    const controller = Object.freeze({destroy, evaluate, status, toggleCurrentSite});
    global.__nightglassController = controller;

    browserAPI.storage.onChanged.addListener(onStorageChanged);
    browserAPI.runtime.onMessage.addListener(onRuntimeMessage);
    addMediaListener(systemScheme, onMediaChanged);
    addMediaListener(forcedColors, onMediaChanged);
    global.addEventListener("pagehide", onPageHide);
    global.addEventListener("pageshow", onPageShow);
    evaluate({reload: true});
})(globalThis);
