/* Nightglass background worker. It has no network capability. */
(function startNightglassBackground(global) {
    "use strict";

    const STORAGE_KEY = "nightglassSettings";
    const browserAPI = global.browser;

    async function toggleGlobally() {
        const stored = await browserAPI.storage.local.get(STORAGE_KEY);
        const current = stored && stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === "object"
            ? stored[STORAGE_KEY]
            : {};
        const next = Object.assign({}, current, {enabled: current.enabled === false});
        await browserAPI.storage.local.set({[STORAGE_KEY]: next});
        return next.enabled;
    }

    function onCommand(command) {
        if (command === "toggle-nightglass") {
            toggleGlobally().catch(() => {
                // Storage failure leaves the current state untouched.
            });
        }
    }

    global.NightglassRuntimeTest = Object.assign(global.NightglassRuntimeTest || {}, {
        toggleGlobally
    });

    if (browserAPI && browserAPI.commands && browserAPI.commands.onCommand) {
        browserAPI.commands.onCommand.addListener(onCommand);
    }
})(globalThis);
