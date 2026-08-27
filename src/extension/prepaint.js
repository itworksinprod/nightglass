/* Nightglass pre-paint guard. Loaded first at document_start in every frame. */
(function prepaintNightglass(global) {
    "use strict";

    const STYLE_ID = "nightglass-prepaint";
    const STORAGE_KEY = "nightglassSettings";
    let style = null;

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

    function preliminaryActivation(settings) {
        const hostname = String(global.location && global.location.hostname || "").toLowerCase();
        const rule = settings && settings.siteRules && settings.siteRules[hostname];
        const siteMode = String(rule && rule.mode || "inherit").toLowerCase();
        if (["off", "disabled", "never"].includes(siteMode)) {
            return false;
        }
        if (["on", "enabled", "force"].includes(siteMode)) {
            return true;
        }
        if (settings && settings.enabled === false) {
            return false;
        }
        const activation = String(settings && settings.activation || "always").toLowerCase();
        if (activation === "system") {
            return Boolean(global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)").matches);
        }
        if (activation === "schedule") {
            return scheduleIsActive(settings && settings.schedule);
        }
        return activation !== "never" && activation !== "off";
    }

    function safeColor(value, fallback) {
        const color = typeof value === "string" ? value.trim() : "";
        if (!color || !global.CSS || typeof global.CSS.supports !== "function") {
            return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
        }
        return global.CSS.supports("color", color) ? color : fallback;
    }

    function paletteFrom(settings) {
        const rule = settings && settings.siteRules && settings.siteRules[
            String(global.location && global.location.hostname || "").toLowerCase()
        ];
        const theme = Object.assign({}, settings && settings.theme, rule && rule.theme);
        return {
            background: safeColor(theme.backgroundColor || settings && settings.backgroundColor, "#181a1b"),
            text: safeColor(theme.textColor || settings && settings.textColor, "#e8e6e3")
        };
    }

    function ensure(settings) {
        if (global.matchMedia && global.matchMedia("(forced-colors: active)").matches) {
            release();
            return null;
        }
        if (style && style.isConnected) {
            return style;
        }
        const palette = paletteFrom(settings || {});
        style = global.document.createElement("style");
        style.id = STYLE_ID;
        style.dataset.nightglassOwned = "prepaint";
        style.textContent = `@media screen and (forced-colors: none) {\n` +
            `  html { color-scheme: dark !important; background-color: ${palette.background} !important; color: ${palette.text} !important; }\n` +
            `}`;
        const parent = global.document.documentElement || global.document.head;
        if (parent) {
            parent.appendChild(style);
        }
        return style;
    }

    function release() {
        if (style) {
            style.remove();
            style = null;
        }
        const orphan = global.document && global.document.getElementById(STYLE_ID);
        if (orphan) {
            orphan.remove();
        }
    }

    global.NightglassPrepaint = Object.freeze({ensure, release});
    global.NightglassRuntimeTest = Object.assign(global.NightglassRuntimeTest || {}, {
        parseClock,
        scheduleIsActive,
        preliminaryActivation
    });

    if (!global.document) {
        return;
    }
    ensure();
    const browserAPI = global.browser;
    if (browserAPI && browserAPI.storage && browserAPI.storage.local) {
        browserAPI.storage.local.get(STORAGE_KEY).then((stored) => {
            const settings = stored && stored[STORAGE_KEY];
            if (preliminaryActivation(settings)) {
                release();
                ensure(settings);
            } else {
                release();
            }
        }).catch(() => {
            // The main controller will either replace or remove the guard.
        });
    }
})(globalThis);
