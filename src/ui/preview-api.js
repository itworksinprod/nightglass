(function attachNightglassLocalPreview(root) {
  "use strict";

  const isLocalPreview =
    (root.location.hostname === "127.0.0.1" || root.location.hostname === "localhost") &&
    new URLSearchParams(root.location.search).get("preview") === "1";

  if (!isLocalPreview || root.browser) {
    return;
  }

  let storedSettings;
  const changeListeners = new Set();

  root.browser = {
    runtime: {
      async openOptionsPage() {},
      async sendMessage() {}
    },
    storage: {
      local: {
        async get(key) {
          return storedSettings === undefined ? {} : {[key]: storedSettings};
        },
        async set(update) {
          const [key] = Object.keys(update);
          const previous = storedSettings;
          storedSettings = update[key];
          const changes = {[key]: {oldValue: previous, newValue: storedSettings}};
          for (const listener of changeListeners) {
            listener(changes, "local");
          }
        }
      },
      onChanged: {
        addListener(listener) {
          changeListeners.add(listener);
        }
      }
    },
    tabs: {
      async query() {
        return [{id: 1, url: "https://example.com/"}];
      },
      async sendMessage(_tabId, message) {
        if (message?.type === "nightglass:get-status") {
          return {
            status: {
              applied: true,
              hostname: "example.com",
              reason: "enabled",
              siteMode: "auto"
            }
          };
        }
        return {ok: true};
      }
    }
  };
})(globalThis);
