/* Nightglass userscript platform adapter. Bundled after Dark Reader and settings. */
(function attachNightglassUserscriptAdapter(global) {
    "use strict";

    const STORAGE_KEY_FALLBACK = "nightglassSettings";
    const MEDIA_STYLE_ID = "nightglass-userscript-media-dim";
    const THEME_FIELDS = [
        "brightness",
        "contrast",
        "sepia",
        "grayscale",
        "imageDim",
        "backgroundColor",
        "textColor"
    ];

    function clamp(value, minimum, maximum, fallback) {
        return typeof value === "number" && Number.isFinite(value)
            ? Math.min(maximum, Math.max(minimum, value))
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

    function scheduleIsActive(schedule, now) {
        const currentDate = now || new Date();
        const start = parseClock(schedule && schedule.start);
        const end = parseClock(schedule && schedule.end);
        if (start === null || end === null) {
            return false;
        }
        if (start === end) {
            return true;
        }
        const current = currentDate.getHours() * 60 + currentDate.getMinutes();
        return start < end
            ? current >= start && current < end
            : current >= start || current < end;
    }

    function millisecondsToScheduleBoundary(schedule, now) {
        const currentDate = now || new Date();
        const values = [parseClock(schedule && schedule.start), parseClock(schedule && schedule.end)];
        if (values.some(function invalid(value) { return value === null; })) {
            return null;
        }
        if (values[0] === values[1]) {
            return null;
        }
        let soonest = Infinity;
        values.forEach(function findBoundary(minutes) {
            for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
                const candidate = new Date(currentDate.getTime());
                candidate.setDate(candidate.getDate() + dayOffset);
                candidate.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
                const delay = candidate.getTime() - currentDate.getTime();
                if (delay > 250 && delay < soonest) {
                    soonest = delay;
                }
            }
        });
        return Number.isFinite(soonest) ? soonest + 50 : null;
    }

    function activationDecision(settings, systemDark, now) {
        if (!settings || settings.globalEnabled === false) {
            return {active: false, force: false, reason: "globally-disabled"};
        }
        const siteMode = String(settings.siteMode || "auto").trim().toLowerCase();
        if (siteMode === "off") {
            return {active: false, force: false, reason: "site-disabled"};
        }
        if (settings.enabled === false) {
            return {active: false, force: false, reason: "globally-disabled"};
        }
        if (siteMode === "on" || siteMode === "force") {
            return {active: true, force: true, reason: "site-forced"};
        }
        const activation = String(settings.activation || "always").trim().toLowerCase();
        if (activation === "system") {
            return {
                active: Boolean(systemDark),
                force: false,
                reason: systemDark ? "system-dark" : "system-light"
            };
        }
        if (activation === "schedule") {
            const active = scheduleIsActive(settings.schedule, now);
            return {active: active, force: false, reason: active ? "schedule-active" : "schedule-inactive"};
        }
        return {active: true, force: false, reason: "always"};
    }

    function parseRenderedColor(value) {
        const source = String(value || "").trim().toLowerCase();
        if (!source || source === "transparent") {
            return {r: 0, g: 0, b: 0, a: 0};
        }
        const match = /^rgba?\((.*)\)$/.exec(source);
        if (!match) {
            return null;
        }
        const channels = match[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
        if (channels.length < 3) {
            return null;
        }
        function channel(valueToParse) {
            if (String(valueToParse).endsWith("%")) {
                return clamp(parseFloat(valueToParse) * 2.55, 0, 255, 0);
            }
            return clamp(parseFloat(valueToParse), 0, 255, 0);
        }
        return {
            r: channel(channels[0]),
            g: channel(channels[1]),
            b: channel(channels[2]),
            a: channels[3] === undefined ? 1 : clamp(parseFloat(channels[3]), 0, 1, 1)
        };
    }

    function relativeLuminance(color) {
        function linearize(channel) {
            const normalized = channel / 255;
            return normalized <= 0.04045
                ? normalized / 12.92
                : Math.pow((normalized + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
    }

    function inspectDarkDeclarations(documentObject, runtime) {
        const evidence = {
            meta: false,
            colorScheme: false,
            darkMedia: false,
            lightDarkFunction: false,
            detected: false
        };
        const meta = documentObject.querySelector('meta[name="color-scheme" i]');
        evidence.meta = Boolean(meta && /(?:^|[\s,])dark(?:$|[\s,])/i.test(meta.content || ""));
        try {
            const scheme = runtime.getComputedStyle(documentObject.documentElement).colorScheme || "";
            evidence.colorScheme = /(?:^|\s)dark(?:$|\s)/i.test(scheme);
        } catch (_error) {
            // Detached documents contribute no computed declaration evidence.
        }
        const styles = documentObject.querySelectorAll("style, link[rel~='stylesheet']");
        for (let index = 0; index < styles.length && index < 500; index += 1) {
            const node = styles[index];
            const media = node.media || (node.getAttribute && node.getAttribute("media")) || "";
            if (/prefers-color-scheme\s*:\s*dark/i.test(media)) {
                evidence.darkMedia = true;
            }
            if (node.localName === "style") {
                const css = String(node.textContent || "").slice(0, 250000);
                evidence.darkMedia = evidence.darkMedia || /prefers-color-scheme\s*:\s*dark/i.test(css);
                evidence.lightDarkFunction = evidence.lightDarkFunction || /light-dark\s*\(/i.test(css);
            }
        }
        evidence.detected = evidence.meta || evidence.colorScheme || evidence.darkMedia || evidence.lightDarkFunction;
        return evidence;
    }

    function sampleRenderedSurfaces(documentObject, runtime) {
        const elements = [];
        const seen = new Set();
        function add(element) {
            if (element && !seen.has(element) && elements.length < 40) {
                seen.add(element);
                elements.push(element);
            }
        }
        add(documentObject.documentElement);
        add(documentObject.body);
        const candidates = documentObject.querySelectorAll("main, article, section, header, nav, aside, [role='main'], [role='dialog']");
        for (let index = 0; index < candidates.length; index += 1) {
            add(candidates[index]);
        }
        const viewportWidth = Math.max(1, runtime.innerWidth || documentObject.documentElement.clientWidth || 1);
        const viewportHeight = Math.max(1, runtime.innerHeight || documentObject.documentElement.clientHeight || 1);
        const viewportArea = viewportWidth * viewportHeight;
        let totalWeight = 0;
        let darkWeight = 0;
        let weightedLuminance = 0;
        let sampleCount = 0;
        elements.forEach(function sample(element) {
            try {
                const computed = runtime.getComputedStyle(element);
                if (computed.display === "none" || computed.visibility === "hidden") {
                    return;
                }
                const color = parseRenderedColor(computed.backgroundColor);
                if (!color || color.a < 0.5) {
                    return;
                }
                const rect = element.getBoundingClientRect();
                const rootSurface = element === documentObject.documentElement || element === documentObject.body;
                const width = rootSurface
                    ? viewportWidth
                    : Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
                const height = rootSurface
                    ? viewportHeight
                    : Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
                const weight = Math.min(viewportArea, width * height);
                if (weight < 64) {
                    return;
                }
                const luminance = relativeLuminance(color);
                totalWeight += weight;
                weightedLuminance += luminance * weight;
                if (luminance < 0.4) {
                    darkWeight += weight;
                }
                sampleCount += 1;
            } catch (_error) {
                // A disappearing or protected element is not evidence either way.
            }
        });
        if (!totalWeight) {
            return {sampleCount: 0, averageLuminance: 1, darkShare: 0, dark: false};
        }
        const averageLuminance = weightedLuminance / totalWeight;
        const darkShare = darkWeight / totalWeight;
        return {
            sampleCount: sampleCount,
            averageLuminance: averageLuminance,
            darkShare: darkShare,
            dark: averageLuminance < 0.35 && darkShare >= 0.55
        };
    }

    function detectNativeDark(documentObject, runtime) {
        const declaration = inspectDarkDeclarations(documentObject, runtime);
        const rendered = sampleRenderedSurfaces(documentObject, runtime);
        return {
            nativeDark: declaration.detected && rendered.dark,
            declaration: declaration,
            rendered: rendered
        };
    }

    function normalizeSelectorList(value) {
        if (!Array.isArray(value)) {
            return undefined;
        }
        const result = value.filter(function keep(selector) {
            return typeof selector === "string" && selector.trim();
        }).slice(0, 500).map(function trim(selector) {
            return selector.trim();
        });
        return result.length ? result : undefined;
    }

    function createDarkReaderConfiguration(resolved) {
        const source = Object.assign({}, resolved || {}, resolved && resolved.theme || {});
        const theme = {
            mode: 1,
            brightness: clamp(source.brightness, 50, 150, 100),
            contrast: clamp(source.contrast, 50, 150, 100),
            sepia: clamp(source.sepia, 0, 100, 0),
            grayscale: clamp(source.grayscale, 0, 100, 0),
            styleSystemControls: true,
            immediateModify: true,
            darkSchemeBackgroundColor: source.backgroundColor || "#181a1b",
            darkSchemeTextColor: source.textColor || "#e8e6e3"
        };
        const fixes = {};
        const rawFixes = resolved && resolved.fixes && typeof resolved.fixes === "object"
            ? resolved.fixes
            : {};
        ["invert", "ignoreInlineStyle", "ignoreImageAnalysis", "ignoreCSSUrl"].forEach(function copyFix(key) {
            const list = normalizeSelectorList(rawFixes[key]);
            if (list) {
                fixes[key] = list;
            }
        });
        if (typeof rawFixes.disableStyleSheetsProxy === "boolean") {
            fixes.disableStyleSheetsProxy = rawFixes.disableStyleSheetsProxy;
        }
        const css = [];
        if (typeof rawFixes.css === "string" && rawFixes.css.trim()) {
            css.push(rawFixes.css.trim());
        }
        if (resolved && typeof resolved.customCSS === "string" && resolved.customCSS.trim()) {
            css.push(resolved.customCSS.trim());
        }
        if (css.length) {
            fixes.css = css.join("\n");
        }
        return {
            theme: theme,
            fixes: Object.keys(fixes).length ? fixes : null,
            imageDim: clamp(source.imageDim, 0, 100, 0)
        };
    }

    function createPageFetch(runtime) {
        const NetworkPolicy = runtime.NightglassNetworkPolicy;
        if (!NetworkPolicy || typeof NetworkPolicy.createCORSFetch !== "function") {
            throw new Error("Nightglass network policy is unavailable.");
        }
        return NetworkPolicy.createCORSFetch(runtime);
    }

    function createController(options) {
        const configuration = options || {};
        const runtime = configuration.global || global;
        const documentObject = configuration.document || runtime.document;
        const gm = configuration.GM || runtime.GM;
        const DarkReader = configuration.DarkReader || runtime.DarkReader;
        const Settings = configuration.Settings || runtime.NightglassSettings;
        if (!documentObject || !gm || !DarkReader || !Settings) {
            throw new Error("Nightglass userscript dependencies are unavailable.");
        }
        if (typeof gm.getValue !== "function" || typeof gm.setValue !== "function") {
            throw new Error("Nightglass requires GM.getValue and GM.setValue.");
        }

        const storageKey = Settings.STORAGE_KEY || STORAGE_KEY_FALLBACK;
        const systemScheme = runtime.matchMedia("(prefers-color-scheme: dark)");
        const forcedColors = runtime.matchMedia("(forced-colors: active)");
        const listeners = new Set();
        const pageFetch = createPageFetch(runtime);
        let queue = Promise.resolve();
        const state = {
            applied: false,
            destroyed: false,
            nativeDark: false,
            reason: "starting",
            error: null,
            settings: Settings.normalizeSettings(null),
            resolved: null,
            scheduleTimer: null,
            generation: 0,
            started: false
        };

        function addMediaListener(query, listener) {
            if (query && typeof query.addEventListener === "function") {
                query.addEventListener("change", listener);
            } else if (query && typeof query.addListener === "function") {
                query.addListener(listener);
            }
        }

        function removeMediaListener(query, listener) {
            if (query && typeof query.removeEventListener === "function") {
                query.removeEventListener("change", listener);
            } else if (query && typeof query.removeListener === "function") {
                query.removeListener(listener);
            }
        }

        function snapshot() {
            const resolved = state.resolved;
            return {
                applied: state.applied,
                destroyed: state.destroyed,
                nativeDark: state.nativeDark,
                reason: state.reason,
                error: state.error,
                hostname: resolved ? resolved.hostname : String(runtime.location && runtime.location.hostname || "").toLowerCase(),
                siteMode: resolved ? resolved.siteMode : "auto",
                preset: resolved ? resolved.preset : state.settings.preset,
                settings: Settings.normalizeSettings(state.settings),
                resolved: resolved ? Object.assign({}, resolved, {theme: Object.assign({}, resolved.theme)}) : null
            };
        }

        function notify() {
            const value = snapshot();
            listeners.forEach(function send(listener) {
                try {
                    listener(value);
                } catch (_error) {
                    // A UI listener cannot interrupt rendering or persistence.
                }
            });
        }

        function subscribe(listener) {
            if (typeof listener !== "function") {
                throw new TypeError("Nightglass subscriber must be a function.");
            }
            listeners.add(listener);
            listener(snapshot());
            return function unsubscribe() {
                listeners.delete(listener);
            };
        }

        function enqueue(operation) {
            const next = queue.then(operation, operation);
            queue = next.catch(function ignoreQueuedError() {});
            return next;
        }

        function removeMediaDimStyle() {
            const node = documentObject.getElementById(MEDIA_STYLE_ID);
            if (node) {
                node.remove();
            }
        }

        function updateMediaDimStyle(amount) {
            removeMediaDimStyle();
            if (!(amount > 0) || !documentObject.documentElement) {
                return;
            }
            const brightness = Math.max(0, 1 - amount / 100).toFixed(3);
            const node = documentObject.createElement("style");
            node.id = MEDIA_STYLE_ID;
            node.dataset.nightglassOwned = "media-dim";
            node.textContent = "@media screen and (forced-colors: none) {\n" +
                "  :where(img, video, canvas) { filter: brightness(" + brightness + ") !important; }\n" +
                "}";
            (documentObject.head || documentObject.documentElement).appendChild(node);
        }

        function disableTheme(reason) {
            removeMediaDimStyle();
            try {
                DarkReader.disable();
            } catch (_error) {
                state.error = "renderer-disable-failed";
            }
            state.applied = false;
            state.reason = reason;
        }

        function clearScheduleTimer() {
            if (state.scheduleTimer !== null) {
                runtime.clearTimeout(state.scheduleTimer);
                state.scheduleTimer = null;
            }
        }

        function armScheduleTimer(resolved) {
            clearScheduleTimer();
            if (!resolved || resolved.activation !== "schedule" || resolved.siteMode === "on") {
                return;
            }
            const delay = millisecondsToScheduleBoundary(resolved.schedule);
            if (delay !== null) {
                state.scheduleTimer = runtime.setTimeout(function onBoundary() {
                    state.scheduleTimer = null;
                    enqueue(function reevaluateBoundary() { return evaluate(); });
                }, Math.min(delay, 0x7fffffff));
            }
        }

        function waitUntilInspectable() {
            if (documentObject.readyState !== "loading") {
                return Promise.resolve();
            }
            return new Promise(function wait(resolve) {
                documentObject.addEventListener("DOMContentLoaded", resolve, {once: true});
            });
        }

        async function readSettings() {
            let raw = await gm.getValue(storageKey, null);
            if (typeof raw === "string") {
                try {
                    raw = JSON.parse(raw);
                } catch (_error) {
                    raw = null;
                }
            }
            state.settings = Settings.normalizeSettings(raw);
            const hostname = String(runtime.location && runtime.location.hostname || "").toLowerCase();
            state.resolved = Settings.resolveSettingsForHost(state.settings, hostname);
            return state.resolved;
        }

        async function persistSettings(nextSettings) {
            const normalized = Settings.normalizeSettings(nextSettings);
            await gm.setValue(storageKey, normalized);
            state.settings = normalized;
            state.resolved = Settings.resolveSettingsForHost(
                normalized,
                String(runtime.location && runtime.location.hostname || "").toLowerCase()
            );
            await evaluate(false);
            return snapshot();
        }

        async function evaluate(reload) {
            if (state.destroyed) {
                return snapshot();
            }
            const generation = ++state.generation;
            state.error = null;
            if (reload !== false || !state.resolved) {
                await readSettings();
            }
            const resolved = state.resolved;
            armScheduleTimer(resolved);
            if (forcedColors.matches) {
                state.nativeDark = false;
                disableTheme("forced-colors");
                notify();
                return snapshot();
            }
            const decision = activationDecision(resolved, systemScheme.matches);
            if (!decision.active) {
                state.nativeDark = false;
                disableTheme(decision.reason);
                notify();
                return snapshot();
            }

            const nativeBehavior = String(resolved.nativeDarkBehavior || "preserve").toLowerCase();
            const shouldInspectNative = resolved.detectNativeDark !== false &&
                nativeBehavior !== "theme" && nativeBehavior !== "transform" && !decision.force;
            if (shouldInspectNative) {
                await waitUntilInspectable();
                if (generation !== state.generation || state.destroyed) {
                    return snapshot();
                }
                disableTheme("sampling");
                const detection = detectNativeDark(documentObject, runtime);
                state.nativeDark = detection.nativeDark;
                if (detection.nativeDark) {
                    if (nativeBehavior === "adjust") {
                        updateMediaDimStyle(resolved.imageDim);
                        state.reason = "native-adjusted";
                    } else {
                        state.reason = "native-dark";
                    }
                    notify();
                    return snapshot();
                }
            } else {
                state.nativeDark = false;
            }

            const renderer = createDarkReaderConfiguration(resolved);
            try {
                DarkReader.enable(renderer.theme, renderer.fixes);
                updateMediaDimStyle(renderer.imageDim);
                state.applied = true;
                state.reason = decision.reason;
            } catch (_error) {
                state.error = "renderer-enable-failed";
                disableTheme("renderer-error");
            }
            notify();
            return snapshot();
        }

        function saveSiteMode(mode) {
            return enqueue(async function updateSiteMode() {
                const hostname = String(runtime.location && runtime.location.hostname || "").toLowerCase();
                const next = Settings.setSiteMode(state.settings, hostname, mode);
                return persistSettings(next);
            });
        }

        function savePreset(preset) {
            return enqueue(function updatePreset() {
                return persistSettings(Settings.applyPreset(state.settings, preset));
            });
        }

        function saveTheme(patch) {
            if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
                return Promise.reject(new TypeError("Theme patch must be an object."));
            }
            return enqueue(function updateTheme() {
                const next = Object.assign({}, state.settings, {preset: "custom"});
                THEME_FIELDS.forEach(function applyField(key) {
                    if (Object.prototype.hasOwnProperty.call(patch, key)) {
                        next[key] = patch[key];
                    }
                });
                return persistSettings(next);
            });
        }

        function setShowMobileControl(visible) {
            return enqueue(function updateControlVisibility() {
                const next = Object.assign({}, state.settings, {showMobileControl: Boolean(visible)});
                return persistSettings(next);
            });
        }

        function removeCurrentSiteRule() {
            return enqueue(function resetCurrentSite() {
                const hostname = String(runtime.location && runtime.location.hostname || "").toLowerCase();
                return persistSettings(Settings.removeSiteRule(state.settings, hostname));
            });
        }

        function resetSettings() {
            return enqueue(async function resetAllSettings() {
                if (typeof gm.deleteValue === "function") {
                    await gm.deleteValue(storageKey);
                } else {
                    await gm.setValue(storageKey, Settings.normalizeSettings(null));
                }
                state.settings = Settings.normalizeSettings(null);
                state.resolved = Settings.resolveSettingsForHost(
                    state.settings,
                    String(runtime.location && runtime.location.hostname || "").toLowerCase()
                );
                await evaluate(false);
                return snapshot();
            });
        }

        function onAppearanceChanged() {
            enqueue(function reevaluateAppearance() { return evaluate(); });
        }

        function onPageHide(event) {
            clearScheduleTimer();
            disableTheme(event.persisted ? "bfcache-suspended" : "page-hidden");
            notify();
            if (!event.persisted) {
                destroy();
            }
        }

        function onPageShow(event) {
            if (event.persisted && !state.destroyed) {
                enqueue(function restorePage() { return evaluate(); });
            }
        }

        function start() {
            if (state.started) {
                return queue.then(snapshot);
            }
            state.started = true;
            try {
                DarkReader.setFetchMethod(pageFetch);
            } catch (_error) {
                state.error = "fetch-adapter-failed";
            }
            addMediaListener(systemScheme, onAppearanceChanged);
            addMediaListener(forcedColors, onAppearanceChanged);
            runtime.addEventListener("pagehide", onPageHide);
            runtime.addEventListener("pageshow", onPageShow);
            return enqueue(function initialEvaluation() { return evaluate(); });
        }

        function destroy() {
            if (state.destroyed) {
                return;
            }
            state.destroyed = true;
            state.generation += 1;
            clearScheduleTimer();
            disableTheme("destroyed");
            removeMediaListener(systemScheme, onAppearanceChanged);
            removeMediaListener(forcedColors, onAppearanceChanged);
            runtime.removeEventListener("pagehide", onPageHide);
            runtime.removeEventListener("pageshow", onPageShow);
            try {
                DarkReader.setFetchMethod(null);
            } catch (_error) {
                // The page is already being torn down.
            }
            notify();
            listeners.clear();
        }

        return Object.freeze({
            start: start,
            destroy: destroy,
            evaluate: function requestEvaluation() { return enqueue(function queuedEvaluation() { return evaluate(); }); },
            getSnapshot: snapshot,
            subscribe: subscribe,
            setSiteMode: saveSiteMode,
            applyPreset: savePreset,
            updateTheme: saveTheme,
            setShowMobileControl: setShowMobileControl,
            removeCurrentSiteRule: removeCurrentSiteRule,
            resetSettings: resetSettings
        });
    }

    const testAPI = Object.freeze({
        activationDecision: activationDecision,
        createDarkReaderConfiguration: createDarkReaderConfiguration,
        createPageFetch: createPageFetch,
        detectNativeDark: detectNativeDark,
        millisecondsToScheduleBoundary: millisecondsToScheduleBoundary,
        parseClock: parseClock,
        parseRenderedColor: parseRenderedColor,
        relativeLuminance: relativeLuminance,
        scheduleIsActive: scheduleIsActive
    });
    const API = Object.freeze({createController: createController, test: testAPI});
    global.NightglassUserscriptAdapter = API;

    if (
        global.document && global.GM && global.DarkReader && global.NightglassSettings &&
        global.NightglassNetworkPolicy &&
        !global.__nightglassUserscriptController
    ) {
        try {
            const controller = createController();
            global.__nightglassUserscriptController = controller;
            controller.start().catch(function failOpen() {
                try {
                    global.DarkReader.disable();
                } catch (_error) {
                    // Failure remains local and pages stay in their original state.
                }
            });
        } catch (_error) {
            try {
                global.DarkReader.disable();
            } catch (_disableError) {
                // Missing userscript capabilities leave the page unchanged.
            }
        }
    }
})(globalThis);
