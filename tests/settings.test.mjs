import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const settingsSource = fs.readFileSync(
    new URL("../src/shared/settings.js", import.meta.url),
    "utf8"
);

function loadSettings(extraGlobals = {}) {
    const context = vm.createContext({...extraGlobals});
    vm.runInContext(settingsSource, context, {
        filename: "src/shared/settings.js"
    });
    return context.NightglassSettings;
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertThrowsNamed(callback, expectedName) {
    assert.throws(callback, (error) => error && error.name === expectedName);
}

test("loads as a browser IIFE in a bare Node VM", () => {
    const api = loadSettings();

    assert.equal(api.SCHEMA_VERSION, 1);
    assert.equal(api.STORAGE_KEY, "nightglassSettings");
    assert.equal(api.DEFAULT_SETTINGS.enabled, true);
    assert.equal(api.DEFAULT_SETTINGS.activation, "always");
    assert.equal(api.DEFAULT_SETTINGS.detectNativeDark, true);
    assert.equal(api.DEFAULT_SETTINGS.nativeDarkBehavior, "preserve");
    assert.equal(api.DEFAULT_SETTINGS.showMobileControl, true);
    assert.deepEqual(
        plain(api.PRESET_IDS),
        ["neutral", "warm", "oled", "contrast", "custom"]
    );
    assert.equal(Object.isFrozen(api), true);
    assert.equal(Object.isFrozen(api.DEFAULT_SETTINGS.schedule), true);
    assert.equal(Object.isFrozen(api.PRESETS.neutral), true);
});

test("normalizes defaults, strict types, bounds, colors, and times", () => {
    const api = loadSettings();
    const normalized = api.normalizeSettings({
        enabled: "false",
        activation: " SYSTEM ",
        detectNativeDark: 0,
        nativeDarkBehavior: "THEME",
        preset: "neutral",
        brightness: 12,
        contrast: 999,
        sepia: -8,
        grayscale: 42.6,
        imageDim: Number.POSITIVE_INFINITY,
        backgroundColor: " #AbC ",
        textColor: "not-a-color",
        schedule: {start: "7:05", end: "25:00"},
        showMobileControl: false,
        unknown: "discard me"
    });

    assert.deepEqual(plain(normalized), {
        version: 1,
        enabled: true,
        activation: "system",
        detectNativeDark: true,
        nativeDarkBehavior: "theme",
        preset: "neutral",
        brightness: 50,
        contrast: 150,
        sepia: 0,
        grayscale: 43,
        imageDim: 0,
        backgroundColor: "#aabbcc",
        textColor: "#f4faff",
        schedule: {start: "07:05", end: "07:00"},
        showMobileControl: false,
        siteRules: {}
    });
});

test("uses preset values as missing-field defaults and keeps custom values isolated", () => {
    const api = loadSettings();
    const warm = api.normalizeSettings({preset: "warm"});
    const custom = api.normalizeSettings({
        preset: "custom",
        brightness: 118,
        contrast: 87,
        imageDim: 100,
        backgroundColor: "#12345678"
    });

    assert.equal(warm.sepia, api.PRESETS.warm.sepia);
    assert.equal(warm.backgroundColor, api.PRESETS.warm.backgroundColor);
    assert.equal(custom.brightness, 118);
    assert.equal(custom.contrast, 87);
    assert.equal(custom.imageDim, 100);
    assert.equal(custom.backgroundColor, "#12345678");

    warm.schedule.start = "01:00";
    warm.siteRules["example.com"] = {mode: "off"};
    assert.equal(api.DEFAULT_SETTINGS.schedule.start, "20:00");
    assert.deepEqual(plain(api.DEFAULT_SETTINGS.siteRules), {});
    assert.throws(() => {
        api.PRESETS.neutral.brightness = 50;
    }, TypeError);
});

test("migrates legacy nested settings without mutating the input", () => {
    const api = loadSettings();
    const legacy = {
        isEnabled: false,
        followSystem: true,
        nativeDarkDetection: false,
        forceThemeOnDarkSites: true,
        theme: {
            preset: "custom",
            brightness: 121,
            warmth: 19,
            darkSchemeBackgroundColor: "#222"
        },
        schedule: {},
        scheduleStart: "21:15",
        scheduleEnd: "6:30",
        mobileControl: false,
        sites: [
            {
                url: "https://User:Secret@Example.COM:8443/private?token=hidden",
                action: "force",
                theme: {contrast: 133}
            },
            {host: "second.example", enabled: false}
        ]
    };
    const before = structuredClone(legacy);
    const normalized = api.normalizeSettings(legacy);

    assert.deepEqual(legacy, before);
    assert.equal(normalized.enabled, false);
    assert.equal(normalized.activation, "system");
    assert.equal(normalized.detectNativeDark, false);
    assert.equal(normalized.nativeDarkBehavior, "theme");
    assert.equal(normalized.brightness, 121);
    assert.equal(normalized.sepia, 19);
    assert.equal(normalized.backgroundColor, "#222222");
    assert.deepEqual(plain(normalized.schedule), {start: "21:15", end: "06:30"});
    assert.deepEqual(Object.keys(normalized.siteRules), ["example.com", "second.example"]);
    assert.equal(normalized.siteRules["example.com"].mode, "on");
    assert.equal(normalized.siteRules["second.example"].mode, "off");
    assert.equal(normalized.siteRules["example.com"].theme.contrast, 133);
    assert.equal(api.exportSettings(normalized).includes("private"), false);
    assert.equal(api.exportSettings(normalized).includes("Secret"), false);
    assert.deepEqual(
        plain(api.normalizeSettings(normalized)),
        plain(normalized),
        "normalization is idempotent"
    );
});

test("sanitizes URL-like inputs to exact hostnames only", () => {
    const api = loadSettings();

    assert.equal(api.sanitizeHostname(" EXAMPLE.com. "), "example.com");
    assert.equal(
        api.sanitizeHostname("https://name:password@Sub.Example.com:443/a/b?q=secret#fragment"),
        "sub.example.com"
    );
    assert.equal(api.sanitizeHostname("localhost:8080/path"), "localhost");
    assert.equal(api.sanitizeHostname("127.0.0.1:3000"), "127.0.0.1");
    assert.equal(api.sanitizeHostname("[::1]:8080/path"), "::1");
    assert.equal(api.sanitizeHostname("::1"), "::1");
    assert.equal(api.sanitizeHostname("chrome://settings"), "");
    assert.equal(api.sanitizeHostname("file:///private/file"), "");
    assert.equal(api.sanitizeHostname("bad host.example"), "");
    assert.equal(api.sanitizeHostname("__proto__"), "");
    assert.equal(api.sanitizeHostname("evil-example.com"), "evil-example.com");
});

test("custom CSS validation rejects network and executable escape variants", () => {
    const api = loadSettings();
    const safe = [
        "html { color-scheme: dark; }",
        "a::after { content: \"url(example)\"; }",
        "/* @import and url() in a comment */ body { color: #eee; }",
        ":root { --image-url: none; }"
    ];
    const unsafe = [
        "@import \"https://example.com/x.css\";",
        "@IMPORT 'x.css';",
        "@/**/import 'x.css';",
        "@\\69mport 'x.css';",
        "body { background: u\\72l(https://example.com/x.png); }",
        "body { background: URL (https://example.com/x.png); }",
        "x { -moz-\\62inding: url(x); }",
        "x { expression(alert(1)); }",
        "x { behavior: foo; }",
        "x { color: red; } </style><script>alert(1)</script>",
        "/* unfinished"
    ];

    safe.forEach((css) => assert.equal(api.validateCustomCSS(css), true, css));
    unsafe.forEach((css) => {
        assert.equal(api.validateCustomCSS(css), false, css);
        assert.equal(api.sanitizeCustomCSS(css), "", css);
    });
    assert.equal(api.validateCustomCSS(null), false);
    assert.equal(api.validateCustomCSS("x".repeat(api.MAX_CUSTOM_CSS_LENGTH + 1)), false);
    assert.equal(api.sanitizeCustomCSS("  body { color: red; }\r\n  "), "body { color: red; }");
});

test("site-rule CRUD is immutable, deep, and validates inputs", () => {
    const api = loadSettings();
    const original = api.normalizeSettings({enabled: true});
    const originalSnapshot = api.exportSettings(original);
    const disabled = api.setSiteMode(original, "https://Example.com/private", "off");
    const patched = api.setSitePatch(disabled, "example.com", {
        theme: {preset: "warm", brightness: 112, imageDim: 101, unknown: 5},
        fixes: {
            invert: [".logo", "", 12],
            ignoreInlineStyle: ["[style]"],
            css: ".legacy { background: #111; }",
            unknown: true
        },
        customCSS: " article { max-width: 70ch; } "
    });

    assert.equal(api.exportSettings(original), originalSnapshot);
    assert.equal(original.siteRules["example.com"], undefined);
    assert.equal(patched.siteRules["example.com"].mode, "off");
    assert.deepEqual(plain(patched.siteRules["example.com"].theme), {
        preset: "warm",
        brightness: 112,
        imageDim: 100
    });
    assert.deepEqual(plain(patched.siteRules["example.com"].fixes), {
        invert: [".logo"],
        ignoreInlineStyle: ["[style]"],
        css: ".legacy { background: #111; }"
    });
    assert.equal(patched.siteRules["example.com"].customCSS, "article { max-width: 70ch; }");

    const cleared = api.setSitePatch(patched, "example.com", {
        theme: {brightness: null},
        customCSS: null,
        fixes: null
    });
    assert.deepEqual(plain(cleared.siteRules["example.com"].theme), {
        preset: "warm",
        imageDim: 100
    });
    assert.equal("customCSS" in cleared.siteRules["example.com"], false);
    assert.equal("fixes" in cleared.siteRules["example.com"], false);

    const removed = api.removeSiteRule(cleared, "example.com");
    assert.deepEqual(plain(removed.siteRules), {});
    assert.equal(cleared.siteRules["example.com"].mode, "off");

    assertThrowsNamed(() => api.setSiteMode(original, "bad host", "on"), "TypeError");
    assertThrowsNamed(() => api.setSiteMode(original, "example.com", "maybe"), "RangeError");
    assertThrowsNamed(
        () => api.setSitePatch(original, "example.com", {customCSS: "x{background:url(x)}"}),
        "TypeError"
    );
    assertThrowsNamed(
        () => api.setSitePatch(original, "example.com", {fixes: {css: "@import 'x';"}}),
        "TypeError"
    );
});

test("resolves effective enablement and theme overrides for one exact host", () => {
    const api = loadSettings();
    const settings = api.normalizeSettings({
        enabled: false,
        preset: "custom",
        brightness: 88,
        contrast: 91,
        siteRules: {
            "example.com": {
                mode: "on",
                theme: {preset: "oled", brightness: 111, textColor: "#abc"},
                fixes: {invert: [".logo"]},
                customCSS: "main { background: #000; }"
            },
            "evil-example.com": {mode: "off"}
        }
    });
    const resolved = api.resolveSettingsForHost(settings, "https://EXAMPLE.com/a?private=1");
    const unrelated = api.resolveSettingsForHost(settings, "notexample.com");

    assert.equal(resolved.hostname, "example.com");
    assert.equal(resolved.globalEnabled, false);
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.siteMode, "on");
    assert.equal(resolved.preset, "oled");
    assert.equal(resolved.theme.backgroundColor, api.PRESETS.oled.backgroundColor);
    assert.equal(resolved.theme.brightness, 111);
    assert.equal(resolved.brightness, 111);
    assert.equal(resolved.textColor, "#aabbcc");
    assert.deepEqual(plain(resolved.fixes), {invert: [".logo"]});
    assert.equal(resolved.customCSS, "main { background: #000; }");

    assert.equal(unrelated.siteMode, "auto");
    assert.equal(unrelated.enabled, false);
    assert.equal(unrelated.brightness, 88);
    assert.equal(unrelated.siteRule, null);
});

test("applies named presets while preserving custom controls", () => {
    const api = loadSettings();
    const initial = api.normalizeSettings({preset: "custom", brightness: 123, sepia: 33});
    const oled = api.applyPreset(initial, "oled");
    const custom = api.applyPreset(oled, "custom");

    assert.equal(initial.brightness, 123);
    assert.equal(oled.preset, "oled");
    assert.equal(oled.brightness, api.PRESETS.oled.brightness);
    assert.equal(oled.backgroundColor, api.PRESETS.oled.backgroundColor);
    assert.equal(custom.preset, "custom");
    assert.equal(custom.brightness, oled.brightness);
    assertThrowsNamed(() => api.applyPreset(initial, "unknown"), "RangeError");
});

test("exports deterministic versioned JSON and imports it safely", () => {
    const api = loadSettings();
    const source = {
        enabled: false,
        siteRules: {
            "z.example": {mode: "off"},
            "A.example": {mode: "on", customCSS: "body { color: #ddd; }"}
        }
    };
    const exported = api.exportSettings(source);
    const exportedAgain = api.exportSettings(source);
    const parsed = JSON.parse(exported);
    const imported = api.importSettings(exported);

    assert.equal(exported, exportedAgain);
    assert.equal(parsed.version, 1);
    assert.deepEqual(Object.keys(parsed.siteRules), ["a.example", "z.example"]);
    assert.deepEqual(plain(imported), plain(api.normalizeSettings(source)));
    assert.equal(api.exportSettings(source, false).includes("\n"), false);
    assert.deepEqual(
        plain(api.importSettings({schemaVersion: 1, settings: source})),
        plain(api.normalizeSettings(source))
    );
    assert.deepEqual(
        plain(api.importSettings({nightglassSettings: source})),
        plain(api.normalizeSettings(source))
    );

    assertThrowsNamed(() => api.importSettings("{"), "SyntaxError");
    assertThrowsNamed(() => api.importSettings("[]"), "TypeError");
    assertThrowsNamed(() => api.importSettings('{"version":2}'), "RangeError");
    assertThrowsNamed(
        () => api.importSettings({schemaVersion: 1, settings: {version: 2}}),
        "RangeError"
    );
    assertThrowsNamed(
        () => api.importSettings({nightglassSettings: {version: 2}}),
        "RangeError"
    );
    assertThrowsNamed(
        () => api.importSettings({
            version: 1,
            siteRules: {"example.com": {customCSS: "@import 'x';"}}
        }),
        "TypeError"
    );
});

test("hostile property names cannot pollute prototypes", () => {
    const api = loadSettings();
    const hostile = JSON.parse(
        '{"siteRules":{"__proto__":{"polluted":true},"constructor":{"mode":"off"}}}'
    );
    const normalized = api.normalizeSettings(hostile);

    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.deepEqual(Object.keys(normalized.siteRules), ["constructor"]);
    assert.equal(normalized.siteRules.constructor.mode, "off");
    assert.equal({}.polluted, undefined);
});
