(function () {
  "use strict";

  const settingsApi = globalThis.NightglassSettings;
  const storageKey = settingsApi?.STORAGE_KEY || "nightglassSettings";

  const elements = {
    advancedLink: document.querySelector("#advanced-link"),
    brightness: document.querySelector("#brightness"),
    brightnessOutput: document.querySelector("#brightness-output"),
    contrast: document.querySelector("#contrast"),
    contrastOutput: document.querySelector("#contrast-output"),
    followSystem: document.querySelector("#follow-system"),
    globalState: document.querySelector("#global-state"),
    globalToggle: document.querySelector("#global-toggle"),
    imageDim: document.querySelector("#image-dim"),
    imageDimOutput: document.querySelector("#image-dim-output"),
    notice: document.querySelector("#notice"),
    presetInputs: Array.from(document.querySelectorAll('input[name="preset"]')),
    resetSite: document.querySelector("#reset-site"),
    siteHeading: document.querySelector("#site-heading"),
    siteModeFieldset: document.querySelector("#site-mode-fieldset"),
    siteModeInputs: Array.from(document.querySelectorAll('input[name="site-mode"]')),
    siteMonogram: document.querySelector("#site-monogram"),
    statusBadge: document.querySelector("#status-badge"),
    statusDetail: document.querySelector("#status-detail"),
    statusLabel: document.querySelector("#status-label"),
    warmth: document.querySelector("#warmth"),
    warmthOutput: document.querySelector("#warmth-output")
  };

  const sliderBindings = [
    { input: elements.brightness, output: elements.brightnessOutput, setting: "brightness" },
    { input: elements.contrast, output: elements.contrastOutput, setting: "contrast" },
    { input: elements.warmth, output: elements.warmthOutput, setting: "sepia" },
    { input: elements.imageDim, output: elements.imageDimOutput, setting: "imageDim" }
  ];

  let activeTab = null;
  let activeHostname = "";
  let connectionState = "checking";
  let pageStatus = null;
  let settings = null;
  let saveTimer = 0;
  let noticeTimer = 0;
  let saveChain = Promise.resolve();
  let activationBeforeSystem = "always";
  const pendingLocalWrites = new Set();

  function normalizeSettings(value) {
    if (settingsApi?.normalizeSettings) {
      return settingsApi.normalizeSettings(value);
    }
    return value;
  }

  function defaultSettings() {
    return settingsApi?.DEFAULT_SETTINGS || {
      enabled: true,
      activation: "always",
      preset: "neutral",
      brightness: 100,
      contrast: 100,
      sepia: 0,
      imageDim: 0,
      siteRules: {}
    };
  }

  function safeHostname(candidate) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      return "";
    }

    if (settingsApi?.sanitizeHostname) {
      return settingsApi.sanitizeHostname(candidate);
    }

    try {
      const parsed = candidate.includes("://")
        ? new URL(candidate)
        : new URL(`https://${candidate}`);
      return parsed.hostname.toLowerCase();
    } catch (_error) {
      return "";
    }
  }

  function hostnameFromTab(tab) {
    if (!tab?.url) {
      return "";
    }

    try {
      const parsed = new URL(tab.url);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? safeHostname(parsed.hostname)
        : "";
    } catch (_error) {
      return "";
    }
  }

  function isWebPage(tab) {
    return typeof tab?.url === "string" && /^https?:/i.test(tab.url);
  }

  function getSiteRule() {
    if (!activeHostname || !settings?.siteRules) {
      return null;
    }
    return settings.siteRules[activeHostname] || null;
  }

  function getResolvedSiteMode() {
    if (!activeHostname || !settings) {
      return "auto";
    }

    if (settingsApi?.resolveSettingsForHost) {
      try {
        const resolved = settingsApi.resolveSettingsForHost(settings, activeHostname);
        const resolvedMode = resolved?.siteMode || resolved?.mode;
        if (["auto", "on", "off"].includes(resolvedMode)) {
          return resolvedMode;
        }
      } catch (_error) {
        // A malformed or legacy site rule should not make the popup unusable.
      }
    }

    const ruleMode = getSiteRule()?.mode;
    return ["auto", "on", "off"].includes(ruleMode) ? ruleMode : "auto";
  }

  function setStatus(kind, label, detail) {
    elements.statusBadge.dataset.status = kind;
    elements.statusLabel.textContent = label;
    elements.statusDetail.textContent = detail;
  }

  function reasonIncludes(...needles) {
    const reason = String(pageStatus?.reason || "").toLowerCase();
    return needles.some((needle) => reason.includes(needle));
  }

  function renderPageStatus() {
    const globalEnabled = Boolean(settings?.enabled);
    elements.globalState.textContent = globalEnabled
      ? settings?.activation === "system" ? "Follows system" : "Nightglass on"
      : "Nightglass off";

    if (connectionState === "checking") {
      setStatus("checking", "Checking this page…", "Connecting to the current tab.");
      return;
    }

    if (connectionState === "unsupported") {
      setStatus(
        "unsupported",
        "Unsupported",
        "Browsers protect this page from extensions, so Nightglass leaves it unchanged."
      );
      return;
    }

    if (connectionState === "permission") {
      setStatus(
        "permission",
        "Permission needed",
        "Allow Nightglass access to this website in your browser’s extension settings."
      );
      return;
    }

    if (!globalEnabled) {
      setStatus(
        "disabled",
        "Disabled here",
        "Global power is off. Your site preferences are still saved."
      );
      return;
    }

    if (pageStatus?.forcedColors || reasonIncludes("forced-colors", "forced colors")) {
      setStatus(
        "unsupported",
        "Unsupported",
        "Your system’s forced-color palette is in control, so Nightglass is paused."
      );
      return;
    }

    if (reasonIncludes("permission", "access denied", "not allowed")) {
      setStatus(
        "permission",
        "Permission needed",
        "Allow Nightglass access to this website in your browser’s extension settings."
      );
      return;
    }

    if (
      pageStatus?.nativeDark &&
      !pageStatus?.applied &&
      !reasonIncludes("transform", "adjust")
    ) {
      setStatus(
        "native",
        "Native dark detected",
        "This site already has a dark design, so Nightglass is leaving it intact."
      );
      return;
    }

    if (
      pageStatus?.siteMode === "off" ||
      pageStatus?.mode === "off" ||
      getResolvedSiteMode() === "off" ||
      reasonIncludes("site-off", "site off", "disabled", "excluded")
    ) {
      setStatus("disabled", "Disabled here", "This website is excluded from Nightglass.");
      return;
    }

    if (
      !pageStatus?.applied &&
      settings?.activation === "system" &&
      reasonIncludes("system-light")
    ) {
      setStatus(
        "disabled",
        "Disabled here",
        "Waiting for your device to switch to Dark Mode."
      );
      return;
    }

    if (
      !pageStatus?.applied &&
      settings?.activation === "schedule" &&
      reasonIncludes("schedule-inactive")
    ) {
      setStatus("disabled", "Disabled here", "Nightglass is outside its scheduled hours.");
      return;
    }

    if (pageStatus?.applied) {
      setStatus(
        "active",
        "Active",
        "Dynamic color treatment is applied while photos and video stay natural."
      );
      return;
    }

    setStatus(
      "disabled",
      "Disabled here",
      "Nightglass is ready, but this page is not currently being transformed."
    );
  }

  function renderRange(input, output, value) {
    const numericValue = Number.isFinite(Number(value)) ? Number(value) : Number(input.value);
    const boundedValue = Math.min(Number(input.max), Math.max(Number(input.min), numericValue));
    input.value = String(boundedValue);
    input.setAttribute("aria-valuetext", `${boundedValue} percent`);
    output.textContent = `${boundedValue}%`;

  }

  function renderSettings() {
    if (!settings) {
      return;
    }

    const isEnabled = Boolean(settings.enabled);
    elements.globalToggle.setAttribute("aria-checked", String(isEnabled));
    elements.globalToggle.setAttribute(
      "aria-label",
      isEnabled ? "Turn Nightglass off everywhere" : "Turn Nightglass on everywhere"
    );

    const mode = getResolvedSiteMode();
    for (const input of elements.siteModeInputs) {
      input.checked = input.value === mode;
    }

    const knownPreset = elements.presetInputs.some((input) => input.value === settings.preset);
    for (const input of elements.presetInputs) {
      input.checked = knownPreset && input.value === settings.preset;
    }

    for (const binding of sliderBindings) {
      renderRange(binding.input, binding.output, settings[binding.setting]);
    }

    elements.followSystem.checked = settings.activation === "system";
    renderPageStatus();
    renderSiteContext();
  }

  function renderSiteContext() {
    const canControlSite = Boolean(activeHostname);
    elements.siteModeFieldset.disabled = !canControlSite;
    elements.resetSite.disabled = !canControlSite || !getSiteRule();

    if (canControlSite) {
      elements.siteHeading.textContent = activeHostname;
      elements.siteHeading.title = activeHostname;
      elements.siteMonogram.textContent = activeHostname.charAt(0);
      return;
    }

    elements.siteHeading.textContent = isWebPage(activeTab) ? "Website access needed" : "Browser page";
    elements.siteHeading.removeAttribute("title");
    elements.siteMonogram.textContent = "–";
  }

  function showNotice(message, kind = "error") {
    globalThis.clearTimeout(noticeTimer);
    elements.notice.textContent = message;
    elements.notice.dataset.kind = kind;
    elements.notice.hidden = false;
    noticeTimer = globalThis.setTimeout(() => {
      elements.notice.hidden = true;
    }, 3200);
  }

  async function getPageStatus() {
    pageStatus = null;
    connectionState = "checking";
    renderPageStatus();

    let response;
    try {
      response = await browser.tabs.sendMessage(activeTab.id, { type: "nightglass:get-status" });
    } catch (_error) {
      connectionState = isWebPage(activeTab) ? "permission" : "unsupported";
      renderPageStatus();
      return;
    }

    pageStatus = response?.status || response || null;
    if (pageStatus?.hostname) {
      activeHostname = safeHostname(pageStatus.hostname) || activeHostname;
    }
    connectionState = pageStatus ? "connected" : isWebPage(activeTab) ? "permission" : "unsupported";
    renderSettings();
  }

  function serializeSettings(value) {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return "";
    }
  }

  async function notifySettingsUpdated(snapshot) {
    const message = { type: "nightglass:settings-updated", settings: snapshot };
    const deliveries = [browser.runtime.sendMessage(message)];

    if (activeTab?.id != null) {
      deliveries.push(browser.tabs.sendMessage(activeTab.id, message));
      deliveries.push(browser.tabs.sendMessage(activeTab.id, { type: "nightglass:apply" }));
    }

    await Promise.allSettled(deliveries);
  }

  function queueSave(delay = 0) {
    globalThis.clearTimeout(saveTimer);
    saveTimer = globalThis.setTimeout(() => {
      const snapshot = normalizeSettings(settings);
      const serialized = serializeSettings(snapshot);
      pendingLocalWrites.add(serialized);

      saveChain = saveChain
        .catch(() => undefined)
        .then(async () => {
          await browser.storage.local.set({ [storageKey]: snapshot });
          await notifySettingsUpdated(snapshot);
          globalThis.setTimeout(() => {
            if (activeTab?.id != null) {
              void getPageStatus();
            }
          }, 80);
        })
        .catch(() => {
          pendingLocalWrites.delete(serialized);
          showNotice("Nightglass couldn’t save that change. Please try again.");
        });
    }, delay);
  }

  function updateSettings(nextSettings, options = {}) {
    settings = normalizeSettings(nextSettings);
    renderSettings();
    queueSave(options.delay || 0);
  }

  function setSiteMode(mode) {
    if (!activeHostname) {
      return;
    }

    if (settingsApi?.setSiteMode) {
      updateSettings(settingsApi.setSiteMode(settings, activeHostname, mode));
      return;
    }

    updateSettings({
      ...settings,
      siteRules: {
        ...(settings.siteRules || {}),
        [activeHostname]: {
          ...(settings.siteRules?.[activeHostname] || {}),
          mode
        }
      }
    });
  }

  function resetSite() {
    if (!activeHostname) {
      return;
    }

    if (settingsApi?.removeSiteRule) {
      updateSettings(settingsApi.removeSiteRule(settings, activeHostname));
    } else {
      const siteRules = { ...(settings.siteRules || {}) };
      delete siteRules[activeHostname];
      updateSettings({ ...settings, siteRules });
    }
    showNotice(`Reset ${activeHostname}.`, "success");
  }

  function selectPreset(presetId) {
    const preset = settingsApi?.PRESETS?.[presetId];
    if (!preset) {
      showNotice("That preset isn’t available in this build.");
      renderSettings();
      return;
    }

    if (settingsApi?.applyPreset) {
      updateSettings(settingsApi.applyPreset(settings, presetId));
      return;
    }

    const presetFields = [
      "brightness",
      "contrast",
      "sepia",
      "grayscale",
      "imageDim",
      "backgroundColor",
      "textColor"
    ];
    const patch = { preset: presetId };
    for (const field of presetFields) {
      if (Object.hasOwn(preset, field)) {
        patch[field] = preset[field];
      }
    }
    updateSettings({ ...settings, ...patch });
  }

  function bindEvents() {
    elements.globalToggle.addEventListener("click", () => {
      updateSettings({ ...settings, enabled: !settings.enabled });
    });

    for (const input of elements.siteModeInputs) {
      input.addEventListener("change", () => {
        if (input.checked) {
          setSiteMode(input.value);
        }
      });
    }

    for (const input of elements.presetInputs) {
      input.addEventListener("change", () => {
        if (input.checked) {
          selectPreset(input.value);
        }
      });
    }

    for (const binding of sliderBindings) {
      binding.input.addEventListener("input", () => {
        const value = Number(binding.input.value);
        renderRange(binding.input, binding.output, value);
        settings = normalizeSettings({
          ...settings,
          preset: "custom",
          [binding.setting]: value
        });
        for (const presetInput of elements.presetInputs) {
          presetInput.checked = false;
        }
        queueSave(140);
      });
      binding.input.addEventListener("change", () => queueSave(0));
    }

    elements.followSystem.addEventListener("change", () => {
      if (elements.followSystem.checked) {
        if (settings.activation !== "system") {
          activationBeforeSystem = settings.activation || "always";
        }
        updateSettings({ ...settings, activation: "system" });
      } else {
        updateSettings({
          ...settings,
          activation: activationBeforeSystem === "system" ? "always" : activationBeforeSystem
        });
      }
    });

    elements.resetSite.addEventListener("click", resetSite);

    elements.advancedLink.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        await browser.runtime.openOptionsPage();
        globalThis.close();
      } catch (_error) {
        globalThis.location.assign(elements.advancedLink.href);
      }
    });

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[storageKey]?.newValue) {
        return;
      }

      const serialized = serializeSettings(changes[storageKey].newValue);
      if (pendingLocalWrites.has(serialized)) {
        pendingLocalWrites.delete(serialized);
        return;
      }

      settings = normalizeSettings(changes[storageKey].newValue);
      renderSettings();
    });
  }

  async function initialize() {
    if (!settingsApi) {
      elements.globalToggle.disabled = true;
      elements.siteModeFieldset.disabled = true;
      setStatus(
        "unsupported",
        "Unsupported",
        "Nightglass settings could not be loaded. Reinstall or reload the extension."
      );
      return;
    }

    try {
      const stored = await browser.storage.local.get(storageKey);
      settings = normalizeSettings(stored[storageKey] || defaultSettings());
      activationBeforeSystem = settings.activation === "system" ? "always" : settings.activation;

      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      activeTab = tabs[0] || null;
      activeHostname = hostnameFromTab(activeTab);
      renderSettings();
      bindEvents();

      if (!activeTab?.id) {
        connectionState = "unsupported";
        renderPageStatus();
        return;
      }

      await getPageStatus();
    } catch (_error) {
      settings = settings || normalizeSettings(defaultSettings());
      connectionState = "unsupported";
      renderSettings();
      showNotice("Nightglass couldn’t connect to the browser right now.");
    }
  }

  void initialize();
})();
