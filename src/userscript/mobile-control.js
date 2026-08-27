/* Nightglass top-frame mobile control. Its stylesheet is embedded by the build. */
(function startNightglassMobileControl(global) {
    "use strict";

    try {
        if (global.self !== global.top) {
            return;
        }
    } catch (_error) {
        return;
    }

    const controller = global.__nightglassUserscriptController;
    const Settings = global.NightglassSettings;
    const cssText = global.NightglassMobileControlCSS;
    if (!global.document || !controller || !Settings || typeof cssText !== "string") {
        return;
    }
    if (global.__nightglassMobileControl) {
        return;
    }

    const HOST_ID = "nightglass-mobile-control";
    const PRESET_IDS = ["neutral", "warm", "oled", "contrast"];
    const state = {
        destroyed: false,
        host: null,
        shadow: null,
        unsubscribe: null,
        reattachObserver: null,
        sliderTimer: null,
        snapshot: null,
        busy: false,
        open: false
    };

    function waitForRoot() {
        if (global.document.documentElement) {
            return Promise.resolve(global.document.documentElement);
        }
        return new Promise(function wait(resolve) {
            const observer = new MutationObserver(function inspect() {
                if (global.document.documentElement) {
                    observer.disconnect();
                    resolve(global.document.documentElement);
                }
            });
            observer.observe(global.document, {childList: true});
        });
    }

    function stopPageEvent(event) {
        event.stopPropagation();
    }

    function isTrustedUserEvent(event) {
        return Boolean(event && event.isTrusted);
    }

    function presetMarkup() {
        return PRESET_IDS.map(function presetOption(id) {
            const definition = Settings.PRESETS[id];
            const label = definition && definition.label || id;
            return "<span class=\"ng-preset\">" +
                "<input type=\"radio\" name=\"ng-preset\" id=\"ng-preset-" + id + "\" value=\"" + id + "\">" +
                "<label for=\"ng-preset-" + id + "\">" +
                "<span class=\"ng-swatch\" data-swatch=\"" + id + "\" aria-hidden=\"true\"></span>" +
                "<span>" + label + "</span>" +
                "</label></span>";
        }).join("");
    }

    function rangeMarkup(id, label, minimum, maximum) {
        return "<div class=\"ng-range\">" +
            "<label for=\"ng-" + id + "\">" + label + "</label>" +
            "<input id=\"ng-" + id + "\" name=\"" + id + "\" type=\"range\" min=\"" + minimum + "\" max=\"" + maximum + "\" step=\"1\">" +
            "<output id=\"ng-" + id + "-output\" for=\"ng-" + id + "\">0%</output>" +
            "</div>";
    }

    function createControl(rootElement) {
        if (state.destroyed || state.host) {
            return;
        }
        const host = global.document.createElement("div");
        host.id = HOST_ID;
        host.dataset.nightglassOwned = "mobile-control";
        host.setAttribute("aria-label", "Nightglass controls");
        host.style.setProperty("position", "fixed", "important");
        host.style.setProperty("right", "0", "important");
        host.style.setProperty("bottom", "0", "important");
        host.style.setProperty("z-index", "2147483646", "important");
        const shadow = host.attachShadow({mode: "closed"});
        const style = global.document.createElement("style");
        style.textContent = cssText;
        shadow.appendChild(style);
        const container = global.document.createElement("div");
        container.className = "ng-root";
        container.dataset.open = "false";
        container.innerHTML =
            "<button class=\"ng-launcher\" type=\"button\" aria-label=\"Open Nightglass controls\" aria-expanded=\"false\" aria-controls=\"ng-sheet\">" +
            "<span class=\"ng-crescent\" aria-hidden=\"true\"></span></button>" +
            "<button class=\"ng-backdrop\" type=\"button\" aria-label=\"Close Nightglass controls\" tabindex=\"-1\"></button>" +
            "<section class=\"ng-sheet\" id=\"ng-sheet\" role=\"dialog\" aria-modal=\"false\" aria-labelledby=\"ng-title\" aria-hidden=\"true\">" +
            "<div class=\"ng-handle\" aria-hidden=\"true\"></div>" +
            "<div class=\"ng-heading\"><div><p class=\"ng-eyebrow\" id=\"ng-hostname\">Current website</p>" +
            "<h2 id=\"ng-title\">Nightglass</h2></div>" +
            "<button class=\"ng-close\" type=\"button\" aria-label=\"Close Nightglass controls\">×</button></div>" +
            "<div class=\"ng-status\" id=\"ng-status\" data-state=\"checking\" role=\"status\" aria-live=\"polite\">" +
            "<span class=\"ng-status-dot\" aria-hidden=\"true\"></span><span id=\"ng-status-text\">Checking this page…</span></div>" +
            "<fieldset class=\"ng-group\" id=\"ng-site-group\"><legend>This website</legend>" +
            "<div class=\"ng-segments\">" +
            "<span class=\"ng-segment\"><input type=\"radio\" name=\"ng-site-mode\" id=\"ng-mode-auto\" value=\"auto\"><label for=\"ng-mode-auto\">Auto</label></span>" +
            "<span class=\"ng-segment\"><input type=\"radio\" name=\"ng-site-mode\" id=\"ng-mode-on\" value=\"on\"><label for=\"ng-mode-on\">On</label></span>" +
            "<span class=\"ng-segment\"><input type=\"radio\" name=\"ng-site-mode\" id=\"ng-mode-off\" value=\"off\"><label for=\"ng-mode-off\">Off</label></span>" +
            "</div></fieldset>" +
            "<fieldset class=\"ng-group\" id=\"ng-preset-group\"><legend>Preset</legend><div class=\"ng-presets\">" + presetMarkup() + "</div></fieldset>" +
            "<section class=\"ng-group\" aria-labelledby=\"ng-tune-title\"><h3 class=\"ng-section-title\" id=\"ng-tune-title\">Fine tune</h3>" +
            "<div class=\"ng-ranges\">" +
            rangeMarkup("brightness", "Brightness", 50, 150) +
            rangeMarkup("contrast", "Contrast", 50, 150) +
            rangeMarkup("sepia", "Warmth", 0, 100) +
            rangeMarkup("imageDim", "Image dim", 0, 100) +
            "</div><p class=\"ng-note\">Fine tuning applies on every website.</p></section>" +
            "</section>";
        shadow.appendChild(container);
        rootElement.appendChild(host);
        state.host = host;
        state.shadow = shadow;

        ["click", "dblclick", "pointerdown", "pointerup", "touchstart", "touchend"].forEach(function isolate(type) {
            host.addEventListener(type, stopPageEvent);
        });
        bindEvents();
        installReattachObserver(rootElement);
        if (state.snapshot) {
            render(state.snapshot);
        }
    }

    function installReattachObserver(rootElement) {
        if (state.reattachObserver) {
            state.reattachObserver.disconnect();
        }
        state.reattachObserver = new MutationObserver(function restoreControl() {
            if (!state.destroyed && state.host && !state.host.isConnected) {
                rootElement.appendChild(state.host);
            }
        });
        state.reattachObserver.observe(rootElement, {childList: true});
    }

    function setOpen(open) {
        if (!state.shadow || state.destroyed) {
            return;
        }
        state.open = Boolean(open);
        const root = state.shadow.querySelector(".ng-root");
        const launcher = state.shadow.querySelector(".ng-launcher");
        const sheet = state.shadow.querySelector(".ng-sheet");
        root.dataset.open = String(state.open);
        launcher.setAttribute("aria-expanded", String(state.open));
        sheet.setAttribute("aria-hidden", String(!state.open));
        if (state.open) {
            global.setTimeout(function focusClose() {
                if (state.open && state.shadow) {
                    state.shadow.querySelector(".ng-close").focus({preventScroll: true});
                }
            }, 20);
        } else {
            launcher.focus({preventScroll: true});
        }
    }

    function statusCopy(snapshot) {
        if (snapshot.error) {
            return {state: "off", text: "Nightglass hit a local rendering error."};
        }
        const labels = {
            "globally-disabled": "Off globally",
            "site-disabled": "Off for this website",
            "site-forced": "On for this website",
            "system-dark": "On · device is in Dark Mode",
            "system-light": "Waiting for device Dark Mode",
            "schedule-active": "On · scheduled hours",
            "schedule-inactive": "Waiting for scheduled hours",
            "native-dark": "Site already has a dark design",
            "native-adjusted": "Native dark design · media adjusted",
            "forced-colors": "Paused for system high contrast",
            "renderer-error": "Nightglass could not theme this page",
            "starting": "Checking this page…",
            "sampling": "Checking the site’s colors…",
            "always": "On"
        };
        return {
            state: snapshot.applied ? "on" : snapshot.reason === "starting" || snapshot.reason === "sampling" ? "checking" : "off",
            text: labels[snapshot.reason] || (snapshot.applied ? "Nightglass is on" : "Nightglass is off")
        };
    }

    function setRadio(name, value) {
        const inputs = state.shadow.querySelectorAll('input[name="' + name + '"]');
        inputs.forEach(function select(input) {
            input.checked = input.value === value;
        });
    }

    function setRange(name, value) {
        const input = state.shadow.querySelector('input[name="' + name + '"]');
        const output = state.shadow.getElementById("ng-" + name + "-output");
        if (!input || !output) {
            return;
        }
        input.value = String(value);
        output.value = String(input.value) + "%";
        output.textContent = String(input.value) + "%";
    }

    function render(snapshot) {
        state.snapshot = snapshot;
        if (snapshot.destroyed || snapshot.settings && snapshot.settings.showMobileControl === false) {
            destroy();
            return;
        }
        if (!state.shadow) {
            return;
        }
        const status = statusCopy(snapshot);
        const statusElement = state.shadow.getElementById("ng-status");
        statusElement.dataset.state = status.state;
        state.shadow.getElementById("ng-status-text").textContent = status.text;
        state.shadow.getElementById("ng-hostname").textContent = snapshot.hostname || "Current website";
        setRadio("ng-site-mode", snapshot.siteMode || "auto");
        setRadio("ng-preset", PRESET_IDS.indexOf(snapshot.preset) === -1 ? "" : snapshot.preset);
        const settings = snapshot.settings || {};
        setRange("brightness", settings.brightness === undefined ? 100 : settings.brightness);
        setRange("contrast", settings.contrast === undefined ? 100 : settings.contrast);
        setRange("sepia", settings.sepia === undefined ? 0 : settings.sepia);
        setRange("imageDim", settings.imageDim === undefined ? 0 : settings.imageDim);
        state.shadow.querySelector(".ng-root").setAttribute("aria-busy", String(state.busy));
        state.shadow.querySelectorAll("input").forEach(function disable(input) {
            input.disabled = state.busy;
        });
    }

    function perform(operation) {
        if (state.busy || state.destroyed) {
            return;
        }
        state.busy = true;
        if (state.snapshot) {
            render(state.snapshot);
        }
        Promise.resolve().then(operation).catch(function showError() {
            if (state.shadow) {
                const status = state.shadow.getElementById("ng-status");
                status.dataset.state = "off";
                state.shadow.getElementById("ng-status-text").textContent = "Could not save that setting.";
            }
        }).finally(function finish() {
            state.busy = false;
            if (state.snapshot && !state.destroyed) {
                render(state.snapshot);
            }
        });
    }

    function readThemeControls() {
        const patch = {};
        ["brightness", "contrast", "sepia", "imageDim"].forEach(function read(name) {
            patch[name] = Number(state.shadow.querySelector('input[name="' + name + '"]').value);
        });
        return patch;
    }

    function scheduleThemeSave(event) {
        if (!isTrustedUserEvent(event)) {
            return;
        }
        if (state.sliderTimer !== null) {
            global.clearTimeout(state.sliderTimer);
        }
        state.sliderTimer = global.setTimeout(function saveTheme() {
            state.sliderTimer = null;
            const patch = readThemeControls();
            perform(function persistTheme() { return controller.updateTheme(patch); });
        }, 140);
    }

    function bindEvents() {
        const shadow = state.shadow;
        shadow.querySelector(".ng-launcher").addEventListener("click", function open(event) {
            if (isTrustedUserEvent(event)) {
                setOpen(true);
            }
        });
        shadow.querySelector(".ng-close").addEventListener("click", function close(event) {
            if (isTrustedUserEvent(event)) {
                setOpen(false);
            }
        });
        shadow.querySelector(".ng-backdrop").addEventListener("click", function closeBackdrop(event) {
            if (isTrustedUserEvent(event)) {
                setOpen(false);
            }
        });
        shadow.addEventListener("keydown", function closeOnEscape(event) {
            if (isTrustedUserEvent(event) && event.key === "Escape" && state.open) {
                event.preventDefault();
                setOpen(false);
            }
        });
        shadow.querySelectorAll('input[name="ng-site-mode"]').forEach(function bindMode(input) {
            input.addEventListener("change", function changeMode(event) {
                if (isTrustedUserEvent(event) && input.checked) {
                    perform(function persistMode() { return controller.setSiteMode(input.value); });
                }
            });
        });
        shadow.querySelectorAll('input[name="ng-preset"]').forEach(function bindPreset(input) {
            input.addEventListener("change", function changePreset(event) {
                if (isTrustedUserEvent(event) && input.checked) {
                    perform(function persistPreset() { return controller.applyPreset(input.value); });
                }
            });
        });
        shadow.querySelectorAll(".ng-range input").forEach(function bindRange(input) {
            input.addEventListener("input", function previewRange(event) {
                if (!isTrustedUserEvent(event)) {
                    return;
                }
                const output = shadow.getElementById(input.id + "-output");
                output.value = input.value + "%";
                output.textContent = input.value + "%";
                scheduleThemeSave(event);
            });
            input.addEventListener("change", scheduleThemeSave);
        });
        PRESET_IDS.forEach(function colorSwatch(id) {
            const definition = Settings.PRESETS[id];
            const swatch = shadow.querySelector('[data-swatch="' + id + '"]');
            if (definition && swatch) {
                swatch.style.setProperty("--ng-swatch", definition.backgroundColor);
            }
        });
    }

    function destroy() {
        if (state.destroyed) {
            return;
        }
        state.destroyed = true;
        if (state.sliderTimer !== null) {
            global.clearTimeout(state.sliderTimer);
            state.sliderTimer = null;
        }
        if (state.unsubscribe) {
            state.unsubscribe();
            state.unsubscribe = null;
        }
        if (state.reattachObserver) {
            state.reattachObserver.disconnect();
            state.reattachObserver = null;
        }
        if (state.host) {
            state.host.remove();
            state.host = null;
            state.shadow = null;
        }
        if (global.__nightglassMobileControl === API) {
            delete global.__nightglassMobileControl;
        }
    }

    const API = Object.freeze({destroy: destroy, open: function open() { setOpen(true); }, close: function close() { setOpen(false); }});
    global.__nightglassMobileControl = API;

    controller.start().then(function initialize(snapshot) {
        if (snapshot.destroyed || snapshot.settings.showMobileControl === false) {
            destroy();
            return;
        }
        state.snapshot = snapshot;
        return waitForRoot().then(function mount(rootElement) {
            if (state.destroyed) {
                return;
            }
            createControl(rootElement);
            state.unsubscribe = controller.subscribe(render);
        });
    }).catch(function abandonControl() {
        destroy();
    });
})(globalThis);
