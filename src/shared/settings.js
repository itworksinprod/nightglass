(function attachNightglassSettings(root) {
    "use strict";

    const SCHEMA_VERSION = 1;
    const STORAGE_KEY = "nightglassSettings";
    const MAX_CUSTOM_CSS_LENGTH = 50000;

    const ACTIVATION_MODES = Object.freeze(["always", "system", "schedule"]);
    const NATIVE_DARK_BEHAVIORS = Object.freeze(["preserve", "theme"]);
    const PRESET_IDS = Object.freeze([
        "neutral",
        "warm",
        "oled",
        "contrast",
        "custom"
    ]);
    const SITE_MODES = Object.freeze(["auto", "on", "off"]);
    const THEME_FIELDS = Object.freeze([
        "brightness",
        "contrast",
        "sepia",
        "grayscale",
        "imageDim",
        "backgroundColor",
        "textColor"
    ]);

    const PRESETS = deepFreeze({
        neutral: {
            label: "Neutral",
            brightness: 100,
            contrast: 100,
            sepia: 0,
            grayscale: 0,
            imageDim: 0,
            backgroundColor: "#101c34",
            textColor: "#f4faff"
        },
        warm: {
            label: "Warm",
            brightness: 100,
            contrast: 100,
            sepia: 12,
            grayscale: 0,
            imageDim: 6,
            backgroundColor: "#1c1917",
            textColor: "#f4ead5"
        },
        oled: {
            label: "OLED",
            brightness: 95,
            contrast: 105,
            sepia: 0,
            grayscale: 0,
            imageDim: 12,
            backgroundColor: "#000000",
            textColor: "#e6e6e6"
        },
        contrast: {
            label: "High contrast",
            brightness: 105,
            contrast: 120,
            sepia: 0,
            grayscale: 0,
            imageDim: 5,
            backgroundColor: "#0b0d10",
            textColor: "#ffffff"
        },
        custom: {
            label: "Custom",
            brightness: 100,
            contrast: 100,
            sepia: 0,
            grayscale: 0,
            imageDim: 0,
            backgroundColor: "#101c34",
            textColor: "#f4faff"
        }
    });

    const DEFAULT_SETTINGS = deepFreeze({
        version: SCHEMA_VERSION,
        enabled: true,
        activation: "always",
        detectNativeDark: true,
        nativeDarkBehavior: "preserve",
        preset: "neutral",
        brightness: PRESETS.neutral.brightness,
        contrast: PRESETS.neutral.contrast,
        sepia: PRESETS.neutral.sepia,
        grayscale: PRESETS.neutral.grayscale,
        imageDim: PRESETS.neutral.imageDim,
        backgroundColor: PRESETS.neutral.backgroundColor,
        textColor: PRESETS.neutral.textColor,
        schedule: {
            start: "20:00",
            end: "07:00"
        },
        showMobileControl: true,
        siteRules: {}
    });

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function isRecord(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function deepFreeze(value, seen) {
        if (value === null || typeof value !== "object") {
            return value;
        }
        const visited = seen || [];
        if (visited.indexOf(value) !== -1) {
            return value;
        }
        visited.push(value);
        Object.keys(value).forEach(function freezeChild(key) {
            deepFreeze(value[key], visited);
        });
        return Object.freeze(value);
    }

    function cloneValue(value, seen) {
        if (value === null || typeof value !== "object") {
            return value;
        }
        const visited = seen || [];
        for (let index = 0; index < visited.length; index += 1) {
            if (visited[index][0] === value) {
                return visited[index][1];
            }
        }
        const clone = Array.isArray(value) ? [] : {};
        visited.push([value, clone]);
        Object.keys(value).forEach(function cloneChild(key) {
            const child = value[key];
            if (
                child === null ||
                typeof child === "string" ||
                typeof child === "number" ||
                typeof child === "boolean" ||
                typeof child === "object"
            ) {
                Object.defineProperty(clone, key, {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: cloneValue(child, visited)
                });
            }
        });
        return clone;
    }

    function firstDefined(object, keys) {
        if (!isRecord(object)) {
            return undefined;
        }
        for (let index = 0; index < keys.length; index += 1) {
            if (hasOwn(object, keys[index]) && object[keys[index]] !== undefined) {
                return object[keys[index]];
            }
        }
        return undefined;
    }

    function normalizeBoolean(value, fallback) {
        return typeof value === "boolean" ? value : fallback;
    }

    function normalizeEnum(value, allowed, fallback) {
        if (typeof value !== "string") {
            return fallback;
        }
        const normalized = value.trim().toLowerCase();
        return allowed.indexOf(normalized) === -1 ? fallback : normalized;
    }

    function normalizeInteger(value, minimum, maximum, fallback) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return fallback;
        }
        return Math.min(maximum, Math.max(minimum, Math.round(value)));
    }

    function normalizeHexColor(value, fallback) {
        if (typeof value !== "string") {
            return fallback;
        }
        const match = value.trim().toLowerCase().match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
        if (!match) {
            return fallback;
        }
        const digits = match[1];
        if (digits.length === 3 || digits.length === 4) {
            return "#" + digits.split("").map(function expand(character) {
                return character + character;
            }).join("");
        }
        return "#" + digits;
    }

    function normalizeTime(value, fallback) {
        if (typeof value !== "string") {
            return fallback;
        }
        const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
            return fallback;
        }
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour > 23 || minute > 59) {
            return fallback;
        }
        return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
    }

    function cssUnescape(value) {
        return value
            .replace(/\\([0-9a-f]{1,6})[\t\n\f\r ]?/gi, function decodeHexEscape(_match, hex) {
                const codePoint = Number.parseInt(hex, 16);
                if (codePoint === 0 || codePoint > 0x10ffff) {
                    return "\ufffd";
                }
                try {
                    return String.fromCodePoint(codePoint);
                } catch (_error) {
                    return "\ufffd";
                }
            })
            .replace(/\\([^\n\r\f0-9a-f])/gi, "$1")
            .replace(/\\(?:\r\n|\r|\n|\f)/g, "");
    }

    function stripCSSStringsAndComments(value) {
        let output = "";
        let index = 0;
        while (index < value.length) {
            if (value[index] === "/" && value[index + 1] === "*") {
                const commentEnd = value.indexOf("*/", index + 2);
                if (commentEnd === -1) {
                    return null;
                }
                output += " ";
                index = commentEnd + 2;
                continue;
            }
            if (value[index] === "\"" || value[index] === "'") {
                const quote = value[index];
                output += quote + quote;
                index += 1;
                let closed = false;
                while (index < value.length) {
                    if (value[index] === "\\") {
                        index += 2;
                        continue;
                    }
                    if (value[index] === quote) {
                        closed = true;
                        index += 1;
                        break;
                    }
                    if (value[index] === "\n" || value[index] === "\r" || value[index] === "\f") {
                        return null;
                    }
                    index += 1;
                }
                if (!closed) {
                    return null;
                }
                continue;
            }
            output += value[index];
            index += 1;
        }
        return output;
    }

    function validateCustomCSS(value) {
        if (typeof value !== "string" || value.length > MAX_CUSTOM_CSS_LENGTH) {
            return false;
        }
        if (value.indexOf("\0") !== -1 || /<\/?style\b/i.test(value)) {
            return false;
        }
        const inspectable = stripCSSStringsAndComments(cssUnescape(value));
        if (inspectable === null) {
            return false;
        }
        const compact = inspectable.replace(/[\t\n\f\r ]+/g, "").toLowerCase();
        return !(
            /@import\b/.test(compact) ||
            /url\(/.test(compact) ||
            /-moz-binding:/.test(compact) ||
            /expression\(/.test(compact) ||
            /(?:^|[;{])behavior:/.test(compact) ||
            /javascript:/.test(compact)
        );
    }

    function sanitizeCustomCSS(value) {
        if (!validateCustomCSS(value)) {
            return "";
        }
        return value.replace(/\r\n?/g, "\n").trim();
    }

    function normalizeSelectorList(value) {
        if (!Array.isArray(value)) {
            return undefined;
        }
        const selectors = [];
        value.slice(0, 512).forEach(function normalizeSelector(selector) {
            if (typeof selector !== "string") {
                return;
            }
            const trimmed = selector.trim();
            if (trimmed && trimmed.length <= 1000) {
                selectors.push(trimmed);
            }
        });
        return selectors.length ? selectors : undefined;
    }

    function normalizeFixes(value) {
        if (!isRecord(value)) {
            return undefined;
        }
        const fixes = {};
        ["invert", "ignoreInlineStyle", "ignoreImageAnalysis", "ignoreCSSUrl"].forEach(
            function normalizeFixList(key) {
                const list = normalizeSelectorList(value[key]);
                if (list) {
                    fixes[key] = list;
                }
            }
        );
        if (typeof value.css === "string") {
            const css = sanitizeCustomCSS(value.css);
            if (css) {
                fixes.css = css;
            }
        }
        if (typeof value.disableStyleSheetsProxy === "boolean") {
            fixes.disableStyleSheetsProxy = value.disableStyleSheetsProxy;
        }
        return Object.keys(fixes).length ? fixes : undefined;
    }

    function getURLConstructor() {
        return root && typeof root.URL === "function" ? root.URL : null;
    }

    function sanitizeHostname(value) {
        if (typeof value !== "string") {
            return "";
        }
        let input = value.trim();
        if (!input || input.length > 2048 || /[\0\s]/.test(input)) {
            return "";
        }

        const explicitScheme = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        if (explicitScheme && !/^https?$/i.test(explicitScheme[1])) {
            return "";
        }

        const URLConstructor = getURLConstructor();
        if (URLConstructor) {
            try {
                const candidate = explicitScheme
                    ? input
                    : input.slice(0, 2) === "//"
                        ? "https:" + input
                        : "https://" + input;
                const parsed = new URLConstructor(candidate);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    return "";
                }
                input = parsed.hostname;
            } catch (_error) {
                return "";
            }
        } else {
            input = input.replace(/^https?:\/\//i, "").replace(/^\/\//, "");
            input = input.split(/[/?#]/, 1)[0];
            const at = input.lastIndexOf("@");
            if (at !== -1) {
                input = input.slice(at + 1);
            }
            if (input[0] === "[") {
                const bracket = input.indexOf("]");
                if (bracket === -1 || (input.length > bracket + 1 && !/^:\d+$/.test(input.slice(bracket + 1)))) {
                    return "";
                }
                input = input.slice(0, bracket + 1);
            } else {
                const colon = input.lastIndexOf(":");
                if (colon !== -1) {
                    if (input.indexOf(":") !== colon) {
                        if (!/^[0-9a-f:.]+$/i.test(input)) {
                            return "";
                        }
                    } else {
                        if (!/^\d+$/.test(input.slice(colon + 1))) {
                            return "";
                        }
                        input = input.slice(0, colon);
                    }
                }
            }
        }

        let hostname = input.trim().toLowerCase();
        if (hostname[0] === "[" && hostname[hostname.length - 1] === "]") {
            hostname = hostname.slice(1, -1);
        }
        hostname = hostname.replace(/\.+$/, "");
        if (!hostname || hostname.length > 253) {
            return "";
        }
        if (hostname.indexOf(":") !== -1) {
            return /^[0-9a-f:.]+$/.test(hostname) ? hostname : "";
        }
        if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.indexOf("..") !== -1) {
            return "";
        }
        const labels = hostname.split(".");
        for (let index = 0; index < labels.length; index += 1) {
            const label = labels[index];
            if (!label || label.length > 63 || label[0] === "-" || label[label.length - 1] === "-") {
                return "";
            }
        }
        return hostname;
    }

    function normalizeThemePatch(value) {
        if (typeof value === "string") {
            const presetName = normalizeEnum(value, PRESET_IDS, "");
            return presetName ? {preset: presetName} : undefined;
        }
        if (!isRecord(value)) {
            return undefined;
        }
        const theme = {};
        if (hasOwn(value, "preset")) {
            const presetName = normalizeEnum(value.preset, PRESET_IDS, "");
            if (presetName) {
                theme.preset = presetName;
            }
        }
        if (typeof value.brightness === "number" && Number.isFinite(value.brightness)) {
            theme.brightness = normalizeInteger(value.brightness, 50, 150, 100);
        }
        if (typeof value.contrast === "number" && Number.isFinite(value.contrast)) {
            theme.contrast = normalizeInteger(value.contrast, 50, 150, 100);
        }
        const percentageAliases = {
            sepia: ["sepia", "warmth"],
            grayscale: ["grayscale"],
            imageDim: ["imageDim", "imageDimming"]
        };
        Object.keys(percentageAliases).forEach(function normalizePercentage(key) {
            const percentage = firstDefined(value, percentageAliases[key]);
            if (typeof percentage === "number" && Number.isFinite(percentage)) {
                theme[key] = normalizeInteger(percentage, 0, 100, 0);
            }
        });
        const colorAliases = {
            backgroundColor: ["backgroundColor", "darkSchemeBackgroundColor"],
            textColor: ["textColor", "darkSchemeTextColor"]
        };
        Object.keys(colorAliases).forEach(function normalizeColor(key) {
            const candidate = firstDefined(value, colorAliases[key]);
            const color = normalizeHexColor(candidate, "");
            if (color) {
                theme[key] = color;
            }
        });
        return Object.keys(theme).length ? theme : undefined;
    }

    function normalizeSiteRule(value) {
        let source = value;
        if (typeof source === "string") {
            source = {mode: source};
        } else if (typeof source === "boolean") {
            source = {mode: source ? "on" : "off"};
        }
        if (!isRecord(source)) {
            return {mode: "auto"};
        }

        let legacyMode = firstDefined(source, ["mode", "action"]);
        if (legacyMode === "inherit") {
            legacyMode = "auto";
        } else if (legacyMode === "force" || legacyMode === "enabled") {
            legacyMode = "on";
        } else if (legacyMode === "disabled" || legacyMode === "never") {
            legacyMode = "off";
        }
        if (legacyMode === undefined && typeof source.enabled === "boolean") {
            legacyMode = source.enabled ? "on" : "off";
        }
        const rule = {
            mode: normalizeEnum(legacyMode, SITE_MODES, "auto")
        };

        let themeSource = source.theme;
        if (!isRecord(themeSource) && typeof themeSource !== "string") {
            const legacyTheme = {};
            if (hasOwn(source, "preset")) {
                legacyTheme.preset = source.preset;
            }
            THEME_FIELDS.forEach(function liftRuleThemeField(key) {
                if (hasOwn(source, key)) {
                    legacyTheme[key] = source[key];
                }
            });
            themeSource = legacyTheme;
        }
        const theme = normalizeThemePatch(themeSource);
        if (theme) {
            rule.theme = theme;
        }

        const fixes = normalizeFixes(source.fixes);
        if (fixes) {
            rule.fixes = fixes;
        }

        const customCSSValue = firstDefined(source, ["customCSS", "customCss"]);
        if (typeof customCSSValue === "string") {
            const customCSS = sanitizeCustomCSS(customCSSValue);
            if (customCSS) {
                rule.customCSS = customCSS;
            }
        }
        return rule;
    }

    function normalizeSiteRules(value) {
        const entries = [];
        if (Array.isArray(value)) {
            value.forEach(function readLegacyRule(rule) {
                if (!isRecord(rule)) {
                    return;
                }
                const host = firstDefined(rule, ["hostname", "host", "pattern", "url"]);
                entries.push([host, rule]);
            });
        } else if (isRecord(value)) {
            Object.keys(value).forEach(function readMappedRule(host) {
                entries.push([host, value[host]]);
            });
        }

        entries.sort(function compareRules(left, right) {
            const leftHost = String(left[0]);
            const rightHost = String(right[0]);
            return leftHost < rightHost ? -1 : leftHost > rightHost ? 1 : 0;
        });
        const rulesByHost = {};
        entries.forEach(function storeRule(entry) {
            const hostname = sanitizeHostname(entry[0]);
            if (!hostname) {
                return;
            }
            Object.defineProperty(rulesByHost, hostname, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: normalizeSiteRule(entry[1])
            });
        });

        const sortedRules = {};
        Object.keys(rulesByHost).sort().forEach(function sortRule(hostname) {
            Object.defineProperty(sortedRules, hostname, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: rulesByHost[hostname]
            });
        });
        return sortedRules;
    }

    function unwrapSettings(value) {
        if (!isRecord(value)) {
            return value;
        }
        if (isRecord(value.settings)) {
            return value.settings;
        }
        if (isRecord(value[STORAGE_KEY])) {
            return value[STORAGE_KEY];
        }
        return value;
    }

    function migrateSettings(value) {
        const source = unwrapSettings(value);
        if (!isRecord(source)) {
            return {};
        }
        const nestedTheme = isRecord(source.theme) ? source.theme : {};
        const sourceSchedule = isRecord(source.schedule) ? source.schedule : {};
        const migrated = {
            enabled: firstDefined(source, ["enabled", "isEnabled"]),
            activation: firstDefined(source, ["activation", "activationMode"]),
            detectNativeDark: firstDefined(source, ["detectNativeDark", "nativeDarkDetection"]),
            nativeDarkBehavior: firstDefined(source, ["nativeDarkBehavior", "nativeDarkMode"]),
            preset: firstDefined(source, ["preset", "themePreset"]),
            brightness: firstDefined(source, ["brightness"]),
            contrast: firstDefined(source, ["contrast"]),
            sepia: firstDefined(source, ["sepia", "warmth"]),
            grayscale: firstDefined(source, ["grayscale"]),
            imageDim: firstDefined(source, ["imageDim", "imageDimming"]),
            backgroundColor: firstDefined(source, ["backgroundColor", "darkSchemeBackgroundColor"]),
            textColor: firstDefined(source, ["textColor", "darkSchemeTextColor"]),
            schedule: {
                start: firstDefined(sourceSchedule, ["start"]),
                end: firstDefined(sourceSchedule, ["end"])
            },
            showMobileControl: firstDefined(source, ["showMobileControl", "mobileControl"]),
            siteRules: firstDefined(source, ["siteRules", "sites", "perSite", "siteSettings"])
        };

        if (migrated.activation === undefined) {
            if (source.followSystem === true) {
                migrated.activation = "system";
            } else if (source.scheduleEnabled === true) {
                migrated.activation = "schedule";
            }
        }
        if (migrated.nativeDarkBehavior === undefined && source.forceThemeOnDarkSites === true) {
            migrated.nativeDarkBehavior = "theme";
        }
        if (migrated.nativeDarkBehavior === "skip") {
            migrated.nativeDarkBehavior = "preserve";
        } else if (
            migrated.nativeDarkBehavior === "adjust" ||
            migrated.nativeDarkBehavior === "transform"
        ) {
            migrated.nativeDarkBehavior = "theme";
        }
        ["preset"].concat(THEME_FIELDS).forEach(function liftGlobalThemeField(key) {
            if (migrated[key] === undefined && hasOwn(nestedTheme, key)) {
                migrated[key] = nestedTheme[key];
            }
        });
        if (migrated.sepia === undefined && hasOwn(nestedTheme, "warmth")) {
            migrated.sepia = nestedTheme.warmth;
        }
        if (migrated.backgroundColor === undefined) {
            migrated.backgroundColor = firstDefined(nestedTheme, [
                "backgroundColor",
                "darkSchemeBackgroundColor"
            ]);
        }
        if (migrated.textColor === undefined) {
            migrated.textColor = firstDefined(nestedTheme, [
                "textColor",
                "darkSchemeTextColor"
            ]);
        }
        if (migrated.schedule.start === undefined) {
            migrated.schedule.start = firstDefined(source, ["scheduleStart", "startTime"]);
        }
        if (migrated.schedule.end === undefined) {
            migrated.schedule.end = firstDefined(source, ["scheduleEnd", "endTime"]);
        }
        return migrated;
    }

    function normalizeSettings(value) {
        const source = migrateSettings(value);
        const preset = normalizeEnum(source.preset, PRESET_IDS, DEFAULT_SETTINGS.preset);
        const presetDefaults = PRESETS[preset];
        const schedule = isRecord(source.schedule) ? source.schedule : {};
        return {
            version: SCHEMA_VERSION,
            enabled: normalizeBoolean(source.enabled, DEFAULT_SETTINGS.enabled),
            activation: normalizeEnum(source.activation, ACTIVATION_MODES, DEFAULT_SETTINGS.activation),
            detectNativeDark: normalizeBoolean(
                source.detectNativeDark,
                DEFAULT_SETTINGS.detectNativeDark
            ),
            nativeDarkBehavior: normalizeEnum(
                source.nativeDarkBehavior,
                NATIVE_DARK_BEHAVIORS,
                DEFAULT_SETTINGS.nativeDarkBehavior
            ),
            preset: preset,
            brightness: normalizeInteger(source.brightness, 50, 150, presetDefaults.brightness),
            contrast: normalizeInteger(source.contrast, 50, 150, presetDefaults.contrast),
            sepia: normalizeInteger(source.sepia, 0, 100, presetDefaults.sepia),
            grayscale: normalizeInteger(source.grayscale, 0, 100, presetDefaults.grayscale),
            imageDim: normalizeInteger(source.imageDim, 0, 100, presetDefaults.imageDim),
            backgroundColor: normalizeHexColor(source.backgroundColor, presetDefaults.backgroundColor),
            textColor: normalizeHexColor(source.textColor, presetDefaults.textColor),
            schedule: {
                start: normalizeTime(schedule.start, DEFAULT_SETTINGS.schedule.start),
                end: normalizeTime(schedule.end, DEFAULT_SETTINGS.schedule.end)
            },
            showMobileControl: normalizeBoolean(
                source.showMobileControl,
                DEFAULT_SETTINGS.showMobileControl
            ),
            siteRules: normalizeSiteRules(source.siteRules)
        };
    }

    function themeFromSettings(settings) {
        const theme = {};
        THEME_FIELDS.forEach(function copyThemeField(key) {
            theme[key] = settings[key];
        });
        return theme;
    }

    function themeFromPreset(preset) {
        const definition = PRESETS[preset] || PRESETS.neutral;
        const theme = {};
        THEME_FIELDS.forEach(function copyPresetField(key) {
            theme[key] = definition[key];
        });
        return theme;
    }

    function resolveSettingsForHost(value, host) {
        const settings = normalizeSettings(value);
        const hostname = sanitizeHostname(host);
        const rule = hostname && hasOwn(settings.siteRules, hostname)
            ? settings.siteRules[hostname]
            : null;
        const siteMode = rule ? rule.mode : "auto";
        const theme = themeFromSettings(settings);

        if (rule && rule.theme) {
            if (rule.theme.preset) {
                const presetTheme = themeFromPreset(rule.theme.preset);
                THEME_FIELDS.forEach(function applySitePreset(key) {
                    theme[key] = presetTheme[key];
                });
            }
            THEME_FIELDS.forEach(function applySiteThemeField(key) {
                if (hasOwn(rule.theme, key)) {
                    theme[key] = rule.theme[key];
                }
            });
        }

        const effectiveEnabled = settings.enabled && siteMode !== "off";
        const resolved = {
            version: SCHEMA_VERSION,
            hostname: hostname,
            enabled: effectiveEnabled,
            globalEnabled: settings.enabled,
            activation: settings.activation,
            detectNativeDark: settings.detectNativeDark,
            nativeDarkBehavior: settings.nativeDarkBehavior,
            preset: rule && rule.theme && rule.theme.preset
                ? rule.theme.preset
                : settings.preset,
            schedule: cloneValue(settings.schedule),
            showMobileControl: settings.showMobileControl,
            siteMode: siteMode,
            siteRule: rule ? cloneValue(rule) : null,
            theme: theme,
            fixes: rule && rule.fixes ? cloneValue(rule.fixes) : null,
            customCSS: rule && rule.customCSS ? rule.customCSS : ""
        };
        THEME_FIELDS.forEach(function flattenResolvedTheme(key) {
            resolved[key] = theme[key];
        });
        return resolved;
    }

    function requireHostname(host) {
        const hostname = sanitizeHostname(host);
        if (!hostname) {
            throw new TypeError("A valid HTTP(S) hostname is required.");
        }
        return hostname;
    }

    function setSitePatch(value, host, patch) {
        if (!isRecord(patch)) {
            throw new TypeError("Site patch must be an object.");
        }
        const hostname = requireHostname(host);
        const settings = normalizeSettings(value);
        const current = hasOwn(settings.siteRules, hostname)
            ? cloneValue(settings.siteRules[hostname])
            : {mode: "auto"};

        if (hasOwn(patch, "mode")) {
            const mode = normalizeEnum(patch.mode, SITE_MODES, "");
            if (!mode) {
                throw new RangeError("Site mode must be auto, on, or off.");
            }
            current.mode = mode;
        }
        if (hasOwn(patch, "theme")) {
            if (patch.theme === null) {
                delete current.theme;
            } else if (typeof patch.theme === "string") {
                current.theme = patch.theme;
            } else if (isRecord(patch.theme)) {
                const mergedTheme = isRecord(current.theme) ? cloneValue(current.theme) : {};
                Object.keys(patch.theme).forEach(function mergeThemeField(key) {
                    if (patch.theme[key] === null || patch.theme[key] === undefined) {
                        delete mergedTheme[key];
                    } else {
                        mergedTheme[key] = patch.theme[key];
                    }
                });
                current.theme = mergedTheme;
            } else {
                throw new TypeError("Site theme must be an object, preset name, or null.");
            }
        }
        if (hasOwn(patch, "fixes")) {
            if (patch.fixes === null) {
                delete current.fixes;
            } else if (isRecord(patch.fixes)) {
                if (typeof patch.fixes.css === "string" && !validateCustomCSS(patch.fixes.css)) {
                    throw new TypeError("Unsafe CSS is not allowed in site fixes.");
                }
                current.fixes = patch.fixes;
            } else {
                throw new TypeError("Site fixes must be an object or null.");
            }
        }
        if (hasOwn(patch, "customCSS") || hasOwn(patch, "customCss")) {
            const customCSS = firstDefined(patch, ["customCSS", "customCss"]);
            if (customCSS === null || customCSS === "") {
                delete current.customCSS;
            } else if (typeof customCSS !== "string") {
                throw new TypeError("Custom CSS must be a string or null.");
            } else if (!validateCustomCSS(customCSS)) {
                throw new TypeError("Unsafe custom CSS is not allowed.");
            } else {
                current.customCSS = customCSS;
            }
        }

        Object.defineProperty(settings.siteRules, hostname, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: normalizeSiteRule(current)
        });
        return normalizeSettings(settings);
    }

    function setSiteMode(value, host, mode) {
        return setSitePatch(value, host, {mode: mode});
    }

    function removeSiteRule(value, host) {
        const hostname = requireHostname(host);
        const settings = normalizeSettings(value);
        delete settings.siteRules[hostname];
        return normalizeSettings(settings);
    }

    function applyPreset(value, preset) {
        const presetName = normalizeEnum(preset, PRESET_IDS, "");
        if (!presetName) {
            throw new RangeError("Unknown Nightglass preset.");
        }
        const settings = normalizeSettings(value);
        settings.preset = presetName;
        if (presetName !== "custom") {
            const theme = themeFromPreset(presetName);
            THEME_FIELDS.forEach(function applyPresetField(key) {
                settings[key] = theme[key];
            });
        }
        return normalizeSettings(settings);
    }

    function findUnsafeImportedCSS(value, parentKey, seen, depth) {
        if (value === null || typeof value !== "object" || depth > 20) {
            return false;
        }
        const visited = seen || [];
        if (visited.indexOf(value) !== -1) {
            return false;
        }
        visited.push(value);
        const keys = Object.keys(value);
        for (let index = 0; index < keys.length; index += 1) {
            const key = keys[index];
            const child = value[key];
            const lowerKey = key.toLowerCase();
            if (
                typeof child === "string" &&
                (lowerKey === "customcss" || (lowerKey === "css" && parentKey === "fixes")) &&
                !validateCustomCSS(child)
            ) {
                return true;
            }
            if (findUnsafeImportedCSS(child, lowerKey, visited, depth + 1)) {
                return true;
            }
        }
        return false;
    }

    function importSettings(payload) {
        let parsed = payload;
        if (typeof payload === "string") {
            try {
                parsed = JSON.parse(payload);
            } catch (_error) {
                throw new SyntaxError("Nightglass settings JSON is malformed.");
            }
        }
        if (!isRecord(parsed)) {
            throw new TypeError("Nightglass settings import must be a JSON object.");
        }

        const directVersion = firstDefined(parsed, ["schemaVersion", "version"]);
        const wrapped = isRecord(parsed.settings)
            ? parsed.settings
            : isRecord(parsed[STORAGE_KEY])
                ? parsed[STORAGE_KEY]
                : parsed;
        const nestedVersion = firstDefined(wrapped, ["schemaVersion", "version"]);
        const versions = [];
        if (directVersion !== undefined) {
            versions.push(directVersion);
        }
        if (nestedVersion !== undefined && wrapped !== parsed) {
            versions.push(nestedVersion);
        }
        versions.forEach(function validateVersion(version) {
            if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
                throw new RangeError("Nightglass settings version is invalid.");
            }
            if (version > SCHEMA_VERSION) {
                throw new RangeError("This Nightglass settings file uses a newer schema version.");
            }
        });
        if (findUnsafeImportedCSS(wrapped, "", [], 0)) {
            throw new TypeError("Imported settings contain unsafe custom CSS.");
        }
        return normalizeSettings(wrapped);
    }

    function exportSettings(value, pretty) {
        const settings = normalizeSettings(value);
        const indentation = pretty === false
            ? 0
            : typeof pretty === "number" && Number.isFinite(pretty)
                ? Math.min(10, Math.max(0, Math.round(pretty)))
                : 2;
        return JSON.stringify(settings, null, indentation);
    }

    const API = Object.freeze({
        SCHEMA_VERSION: SCHEMA_VERSION,
        STORAGE_KEY: STORAGE_KEY,
        MAX_CUSTOM_CSS_LENGTH: MAX_CUSTOM_CSS_LENGTH,
        ACTIVATION_MODES: ACTIVATION_MODES,
        NATIVE_DARK_BEHAVIORS: NATIVE_DARK_BEHAVIORS,
        PRESET_IDS: PRESET_IDS,
        SITE_MODES: SITE_MODES,
        THEME_FIELDS: THEME_FIELDS,
        PRESETS: PRESETS,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        migrateSettings: migrateSettings,
        normalizeSettings: normalizeSettings,
        normalizeSiteRule: normalizeSiteRule,
        sanitizeHostname: sanitizeHostname,
        resolveSettingsForHost: resolveSettingsForHost,
        setSiteMode: setSiteMode,
        setSitePatch: setSitePatch,
        removeSiteRule: removeSiteRule,
        applyPreset: applyPreset,
        validateCustomCSS: validateCustomCSS,
        sanitizeCustomCSS: sanitizeCustomCSS,
        importSettings: importSettings,
        exportSettings: exportSettings
    });

    root.NightglassSettings = API;
})(typeof globalThis === "object" && globalThis ? globalThis : this);
