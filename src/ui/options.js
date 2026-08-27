(() => {
  "use strict";

  const Settings = globalThis.NightglassSettings;
  const browserApi = globalThis.browser;
  const FALLBACK_STORAGE_KEY = "nightglassSettings";
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;
  const PRESET_DESCRIPTIONS = Object.freeze({
    neutral: "Balanced and true to the page",
    warm: "Softer tones for late reading",
    oled: "Deep black for OLED displays",
    contrast: "Sharper text and boundaries",
    custom: "Your detailed adjustments"
  });
  const MODE_LABELS = Object.freeze({
    auto: "Global",
    on: "Always on",
    off: "Always off"
  });

  const $ = (id) => document.getElementById(id);
  const refs = {
    form: $("settings-form"),
    saveStatus: $("save-status"),
    enabled: $("enabled"),
    scheduleFields: $("schedule-fields"),
    scheduleStart: $("schedule-start"),
    scheduleEnd: $("schedule-end"),
    presetList: $("preset-list"),
    brightness: $("brightness"),
    contrast: $("contrast"),
    sepia: $("sepia"),
    grayscale: $("grayscale"),
    imageDim: $("image-dim"),
    brightnessOutput: $("brightness-output"),
    contrastOutput: $("contrast-output"),
    sepiaOutput: $("sepia-output"),
    grayscaleOutput: $("grayscale-output"),
    imageDimOutput: $("image-dim-output"),
    backgroundColor: $("background-color"),
    backgroundColorPicker: $("background-color-picker"),
    textColor: $("text-color"),
    textColorPicker: $("text-color-picker"),
    detectNativeDark: $("detect-native-dark"),
    nativeDarkBehavior: $("native-dark-behavior"),
    showMobileControl: $("show-mobile-control"),
    siteHostname: $("site-hostname"),
    siteMode: $("site-mode"),
    addSiteRule: $("add-site-rule"),
    siteFormMessage: $("site-form-message"),
    siteRuleList: $("site-rule-list"),
    emptyRules: $("empty-rules"),
    ruleCount: $("rule-count"),
    siteEditor: $("site-editor"),
    editorHostname: $("editor-hostname"),
    editorSiteMode: $("editor-site-mode"),
    siteCustomCss: $("site-custom-css"),
    cssValidation: $("css-validation"),
    saveSiteEditor: $("save-site-editor"),
    removeSelectedRule: $("remove-selected-rule"),
    closeSiteEditor: $("close-site-editor"),
    settingsJson: $("settings-json"),
    importMessage: $("import-message"),
    prepareExport: $("prepare-export"),
    downloadExport: $("download-export"),
    importFile: $("import-file"),
    importJson: $("import-json"),
    openResetDialog: $("open-reset-dialog"),
    resetDialog: $("reset-dialog"),
    confirmReset: $("confirm-reset"),
    toast: $("toast")
  };

  let state = null;
  let selectedHostname = null;
  let isDirty = false;
  let isWriting = false;
  let toastTimer = null;
  let cssValidationTimer = null;

  function clone(value) {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function setStatus(message, status = "idle") {
    refs.saveStatus.textContent = message;
    refs.saveStatus.dataset.state = status;
  }

  function setMessage(element, message = "", status = "idle") {
    element.textContent = message;
    element.dataset.state = status;
  }

  function showToast(message, status = "success") {
    globalThis.clearTimeout(toastTimer);
    refs.toast.textContent = message;
    refs.toast.dataset.state = status;
    refs.toast.hidden = false;
    toastTimer = globalThis.setTimeout(() => {
      refs.toast.hidden = true;
    }, 3200);
  }

  function normalize(raw) {
    return Settings.normalizeSettings(raw);
  }

  function markDirty() {
    if (!state) {
      return;
    }
    isDirty = true;
    setStatus("Unsaved changes", "saving");
  }

  function setRadioValue(name, value) {
    const radio = refs.form.querySelector(`input[name="${name}"][value="${CSS.escape(String(value))}"]`);
    if (radio) {
      radio.checked = true;
    }
  }

  function getRadioValue(name, fallback) {
    return refs.form.querySelector(`input[name="${name}"]:checked`)?.value ?? fallback;
  }

  function setRangeValue(input, output, value) {
    input.value = String(value);
    output.value = `${value}%`;
    output.textContent = `${value}%`;
  }

  function updateRangeOutputs() {
    setRangeValue(refs.brightness, refs.brightnessOutput, Number(refs.brightness.value));
    setRangeValue(refs.contrast, refs.contrastOutput, Number(refs.contrast.value));
    setRangeValue(refs.sepia, refs.sepiaOutput, Number(refs.sepia.value));
    setRangeValue(refs.grayscale, refs.grayscaleOutput, Number(refs.grayscale.value));
    setRangeValue(refs.imageDim, refs.imageDimOutput, Number(refs.imageDim.value));
  }

  function updateScheduleVisibility() {
    refs.scheduleFields.hidden = getRadioValue("activation", "always") !== "schedule";
  }

  function updateNativeDarkAvailability() {
    refs.nativeDarkBehavior.disabled = !refs.detectNativeDark.checked;
  }

  function setColorField(textInput, picker, value) {
    const safeValue = HEX_COLOR.test(value) ? value.toUpperCase() : "#101419";
    textInput.value = safeValue;
    textInput.setAttribute("aria-invalid", "false");
    picker.value = safeValue;
  }

  function renderPresetOptions() {
    const fragment = document.createDocumentFragment();
    for (const [id, preset] of Object.entries(Settings.PRESETS || {})) {
      const label = document.createElement("label");
      label.className = "preset-card";
      label.dataset.preset = id;

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "preset";
      input.value = id;

      const content = document.createElement("span");
      content.className = "preset-card__content";
      const preview = document.createElement("span");
      preview.className = "preset-card__preview";
      preview.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.className = "preset-card__name";
      name.textContent = preset.label || id;
      const description = document.createElement("small");
      description.className = "preset-card__description";
      description.textContent = PRESET_DESCRIPTIONS[id] || "Saved Nightglass theme";

      copy.append(name, description);
      content.append(preview, copy);
      label.append(input, content);
      fragment.append(label);
    }
    refs.presetList.replaceChildren(fragment);
  }

  function applyPresetToForm(presetId) {
    const preset = Settings.PRESETS?.[presetId];
    if (!preset || presetId === "custom") {
      return;
    }
    setRangeValue(refs.brightness, refs.brightnessOutput, preset.brightness);
    setRangeValue(refs.contrast, refs.contrastOutput, preset.contrast);
    setRangeValue(refs.sepia, refs.sepiaOutput, preset.sepia);
    setRangeValue(refs.grayscale, refs.grayscaleOutput, preset.grayscale);
    setRangeValue(refs.imageDim, refs.imageDimOutput, preset.imageDim);
    setColorField(refs.backgroundColor, refs.backgroundColorPicker, preset.backgroundColor);
    setColorField(refs.textColor, refs.textColorPicker, preset.textColor);
  }

  function selectCustomPreset() {
    const custom = refs.form.querySelector('input[name="preset"][value="custom"]');
    if (custom) {
      custom.checked = true;
    }
  }

  function renderForm() {
    refs.enabled.checked = state.enabled;
    setRadioValue("activation", state.activation);
    refs.scheduleStart.value = state.schedule.start;
    refs.scheduleEnd.value = state.schedule.end;
    setRadioValue("preset", state.preset);
    setRangeValue(refs.brightness, refs.brightnessOutput, state.brightness);
    setRangeValue(refs.contrast, refs.contrastOutput, state.contrast);
    setRangeValue(refs.sepia, refs.sepiaOutput, state.sepia);
    setRangeValue(refs.grayscale, refs.grayscaleOutput, state.grayscale);
    setRangeValue(refs.imageDim, refs.imageDimOutput, state.imageDim);
    setColorField(refs.backgroundColor, refs.backgroundColorPicker, state.backgroundColor);
    setColorField(refs.textColor, refs.textColorPicker, state.textColor);
    refs.detectNativeDark.checked = state.detectNativeDark;
    refs.nativeDarkBehavior.value = state.nativeDarkBehavior;
    refs.showMobileControl.checked = state.showMobileControl;
    updateScheduleVisibility();
    updateNativeDarkAvailability();
    renderSiteRules();
  }

  function readForm() {
    const backgroundColor = refs.backgroundColor.value.trim();
    const textColor = refs.textColor.value.trim();
    refs.backgroundColor.setAttribute("aria-invalid", String(!HEX_COLOR.test(backgroundColor)));
    refs.textColor.setAttribute("aria-invalid", String(!HEX_COLOR.test(textColor)));
    if (!HEX_COLOR.test(backgroundColor) || !HEX_COLOR.test(textColor)) {
      throw new Error("Enter both colors as six-digit hex values, such as #101419.");
    }

    return normalize({
      ...state,
      enabled: refs.enabled.checked,
      activation: getRadioValue("activation", state.activation),
      schedule: {
        start: refs.scheduleStart.value,
        end: refs.scheduleEnd.value
      },
      preset: getRadioValue("preset", state.preset),
      brightness: Number(refs.brightness.value),
      contrast: Number(refs.contrast.value),
      sepia: Number(refs.sepia.value),
      grayscale: Number(refs.grayscale.value),
      imageDim: Number(refs.imageDim.value),
      backgroundColor: backgroundColor.toUpperCase(),
      textColor: textColor.toUpperCase(),
      detectNativeDark: refs.detectNativeDark.checked,
      nativeDarkBehavior: refs.nativeDarkBehavior.value,
      showMobileControl: refs.showMobileControl.checked
    });
  }

  async function persist(nextState, message = "Settings saved") {
    const normalized = normalize(nextState);
    const storageKey = Settings.STORAGE_KEY || FALLBACK_STORAGE_KEY;
    isWriting = true;
    setStatus("Saving…", "saving");
    try {
      await browserApi.storage.local.set({[storageKey]: normalized});
      state = normalized;
      isDirty = false;
      setStatus("Saved locally", "saved");
      showToast(message);
    } catch (error) {
      setStatus("Could not save", "error");
      showToast(error?.message || "Nightglass could not save these settings.", "error");
      throw error;
    } finally {
      isWriting = false;
    }
  }

  function normalizedHostname(input) {
    const value = input.trim();
    if (!value) {
      throw new Error("Enter a hostname, such as example.com.");
    }
    let url;
    try {
      url = new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      throw new Error("That hostname is not valid.");
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname.length > 253 || hostname.includes("..")) {
      throw new Error("That hostname is not valid.");
    }
    return hostname;
  }

  function getSiteRules() {
    return state.siteRules && typeof state.siteRules === "object" ? state.siteRules : {};
  }

  function ruleHasCustomCss(rule) {
    return typeof rule?.customCSS === "string" && rule.customCSS.trim().length > 0;
  }

  function renderSiteRules() {
    const rules = Object.entries(getSiteRules()).sort(([left], [right]) => left.localeCompare(right));
    refs.ruleCount.textContent = String(rules.length);
    refs.emptyRules.hidden = rules.length !== 0;
    const fragment = document.createDocumentFragment();

    for (const [hostname, rule] of rules) {
      const row = document.createElement("div");
      row.className = "rule-item";
      row.dataset.mode = rule.mode;
      row.dataset.selected = String(hostname === selectedHostname);

      const edit = document.createElement("button");
      edit.className = "rule-item__main";
      edit.type = "button";
      edit.setAttribute("aria-label", `Edit rule for ${hostname}`);
      const host = document.createElement("span");
      host.className = "rule-item__host";
      host.textContent = hostname;
      const meta = document.createElement("span");
      meta.className = "rule-item__meta";
      meta.textContent = ruleHasCustomCss(rule) ? "Includes a custom CSS fix" : "No custom CSS";
      edit.append(host, meta);
      edit.addEventListener("click", () => openSiteEditor(hostname));

      const badge = document.createElement("span");
      badge.className = "mode-badge";
      badge.textContent = MODE_LABELS[rule.mode] || rule.mode;

      const remove = document.createElement("button");
      remove.className = "icon-button";
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove rule for ${hostname}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => removeRule(hostname));

      row.append(edit, badge, remove);
      fragment.append(row);
    }
    refs.siteRuleList.replaceChildren(fragment);

    if (selectedHostname && getSiteRules()[selectedHostname]) {
      populateSiteEditor(selectedHostname);
    } else {
      closeSiteEditor();
    }
  }

  function openSiteEditor(hostname) {
    selectedHostname = hostname;
    populateSiteEditor(hostname);
    refs.siteEditor.hidden = false;
    renderSiteRules();
    refs.editorSiteMode.focus({preventScroll: true});
  }

  function populateSiteEditor(hostname) {
    const rule = getSiteRules()[hostname];
    if (!rule) {
      closeSiteEditor();
      return;
    }
    refs.editorHostname.textContent = hostname;
    refs.editorSiteMode.value = rule.mode;
    refs.siteCustomCss.value = typeof rule.customCSS === "string" ? rule.customCSS : "";
    refs.siteCustomCss.setAttribute("aria-invalid", "false");
    setMessage(refs.cssValidation, "");
    refs.siteEditor.hidden = false;
  }

  function closeSiteEditor() {
    selectedHostname = null;
    refs.siteEditor.hidden = true;
    refs.siteCustomCss.value = "";
    setMessage(refs.cssValidation, "");
    for (const row of refs.siteRuleList.querySelectorAll(".rule-item")) {
      row.dataset.selected = "false";
    }
  }

  async function addRule() {
    try {
      const hostname = normalizedHostname(refs.siteHostname.value);
      const alreadyExists = Boolean(getSiteRules()[hostname]);
      const next = Settings.setSiteMode(state, hostname, refs.siteMode.value);
      await persist(next, alreadyExists ? `Updated ${hostname}` : `Added ${hostname}`);
      refs.siteHostname.value = "";
      setMessage(refs.siteFormMessage, alreadyExists ? "Rule updated." : "Rule added.", "success");
      selectedHostname = hostname;
      renderSiteRules();
      openSiteEditor(hostname);
    } catch (error) {
      setMessage(refs.siteFormMessage, error?.message || "Could not add that site rule.", "error");
      refs.siteHostname.focus();
    }
  }

  async function removeRule(hostname) {
    try {
      const next = Settings.removeSiteRule(state, hostname);
      if (selectedHostname === hostname) {
        selectedHostname = null;
      }
      await persist(next, `Removed ${hostname}`);
      renderSiteRules();
    } catch (error) {
      showToast(error?.message || `Could not remove ${hostname}.`, "error");
    }
  }

  function validateCss(css) {
    if (!css.trim()) {
      return {valid: true, message: "No custom CSS will be applied."};
    }
    try {
      const result = Settings.validateCustomCSS(css);
      if (typeof result === "boolean") {
        return {valid: result, message: result ? "CSS passed the local safety check." : "This CSS is not allowed."};
      }
      if (Array.isArray(result)) {
        return {
          valid: result.length === 0,
          message: result.length ? String(result[0]) : "CSS passed the local safety check."
        };
      }
      if (result && typeof result === "object") {
        const errors = Array.isArray(result.errors) ? result.errors : [];
        const valid = result.valid ?? result.ok ?? errors.length === 0;
        const firstError = errors[0];
        const errorText = typeof firstError === "string" ? firstError : firstError?.message;
        return {
          valid: Boolean(valid),
          message: result.message || result.error || errorText || (valid ? "CSS passed the local safety check." : "This CSS is not allowed.")
        };
      }
      return {valid: true, message: "CSS passed the local safety check."};
    } catch (error) {
      return {valid: false, message: error?.message || "This CSS is not allowed."};
    }
  }

  function showCssValidation() {
    const result = validateCss(refs.siteCustomCss.value);
    refs.siteCustomCss.setAttribute("aria-invalid", String(!result.valid));
    setMessage(refs.cssValidation, result.message, result.valid ? "success" : "error");
    return result;
  }

  function sanitizeCss(css) {
    const result = Settings.sanitizeCustomCSS(css);
    if (typeof result === "string") {
      return result;
    }
    if (result && typeof result.css === "string") {
      return result.css;
    }
    if (result && typeof result.value === "string") {
      return result.value;
    }
    return css;
  }

  async function saveSiteEditor() {
    if (!selectedHostname || !getSiteRules()[selectedHostname]) {
      return;
    }
    const validation = showCssValidation();
    if (!validation.valid) {
      refs.siteCustomCss.focus();
      return;
    }

    try {
      const originalCss = refs.siteCustomCss.value;
      const safeCss = originalCss.trim() ? sanitizeCss(originalCss) : "";
      let next = Settings.setSiteMode(state, selectedHostname, refs.editorSiteMode.value);
      next = Settings.setSitePatch(next, selectedHostname, {customCSS: safeCss});
      await persist(next, `Saved ${selectedHostname}`);
      refs.siteCustomCss.value = safeCss;
      setMessage(
        refs.cssValidation,
        safeCss !== originalCss ? "Saved after removing unsafe or unsupported CSS." : "Site rule saved.",
        "success"
      );
      renderSiteRules();
    } catch (error) {
      setMessage(refs.cssValidation, error?.message || "Could not save this site rule.", "error");
    }
  }

  function exportText() {
    const exported = Settings.exportSettings(state, true);
    return typeof exported === "string" ? exported : JSON.stringify(exported, null, 2);
  }

  function prepareExport() {
    try {
      refs.settingsJson.value = exportText();
      refs.settingsJson.focus();
      refs.settingsJson.select();
      setMessage(refs.importMessage, "Export prepared. Copy it or download the file.", "success");
    } catch (error) {
      setMessage(refs.importMessage, error?.message || "Could not prepare this export.", "error");
    }
  }

  function downloadExport() {
    try {
      const blob = new Blob([exportText()], {type: "application/json"});
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      link.href = objectUrl;
      link.download = `nightglass-settings-${date}.json`;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setMessage(refs.importMessage, "Settings backup downloaded.", "success");
    } catch (error) {
      setMessage(refs.importMessage, error?.message || "Could not download this export.", "error");
    }
  }

  async function importFromText() {
    try {
      if (!refs.settingsJson.value.trim()) {
        throw new Error("Paste settings JSON or choose a backup file first.");
      }
      const imported = Settings.importSettings(refs.settingsJson.value);
      await persist(imported, "Settings imported");
      selectedHostname = null;
      renderForm();
      setMessage(refs.importMessage, "Import complete. The backup was validated and normalized.", "success");
    } catch (error) {
      setMessage(refs.importMessage, error?.message || "That backup is not valid Nightglass JSON.", "error");
      refs.settingsJson.focus();
    }
  }

  async function loadImportFile() {
    const [file] = refs.importFile.files;
    if (!file) {
      return;
    }
    try {
      refs.settingsJson.value = await file.text();
      setMessage(refs.importMessage, `${file.name} is ready. Select Import from text to apply it.`, "success");
      refs.settingsJson.focus();
    } catch (error) {
      setMessage(refs.importMessage, error?.message || "Could not read that file.", "error");
    } finally {
      refs.importFile.value = "";
    }
  }

  async function resetAll() {
    try {
      const defaults = normalize(clone(Settings.DEFAULT_SETTINGS));
      await persist(defaults, "Nightglass reset to defaults");
      selectedHostname = null;
      refs.settingsJson.value = "";
      setMessage(refs.importMessage, "");
      setMessage(refs.siteFormMessage, "");
      renderForm();
    } catch {
      // persist() already reports a useful error.
    }
  }

  function bindEvents() {
    refs.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await persist(readForm());
        renderForm();
      } catch (error) {
        if (error?.message) {
          showToast(error.message, "error");
        }
      }
    });

    for (const radio of refs.form.querySelectorAll('input[name="activation"]')) {
      radio.addEventListener("change", () => {
        updateScheduleVisibility();
        markDirty();
      });
    }

    refs.presetList.addEventListener("change", (event) => {
      const input = event.target.closest('input[name="preset"]');
      if (!input) {
        return;
      }
      applyPresetToForm(input.value);
      markDirty();
    });

    const detailedRanges = [refs.brightness, refs.contrast, refs.sepia, refs.grayscale, refs.imageDim];
    for (const input of detailedRanges) {
      input.addEventListener("input", () => {
        updateRangeOutputs();
        selectCustomPreset();
        markDirty();
      });
    }

    const simpleInputs = [
      refs.enabled,
      refs.scheduleStart,
      refs.scheduleEnd,
      refs.nativeDarkBehavior,
      refs.showMobileControl
    ];
    for (const input of simpleInputs) {
      input.addEventListener("change", markDirty);
    }

    refs.detectNativeDark.addEventListener("change", () => {
      updateNativeDarkAvailability();
      markDirty();
    });

    const colorPairs = [
      [refs.backgroundColor, refs.backgroundColorPicker],
      [refs.textColor, refs.textColorPicker]
    ];
    for (const [textInput, picker] of colorPairs) {
      picker.addEventListener("input", () => {
        textInput.value = picker.value.toUpperCase();
        textInput.setAttribute("aria-invalid", "false");
        selectCustomPreset();
        markDirty();
      });
      textInput.addEventListener("input", () => {
        const value = textInput.value.trim();
        const isValid = HEX_COLOR.test(value);
        textInput.setAttribute("aria-invalid", String(!isValid));
        if (isValid) {
          picker.value = value;
        }
        selectCustomPreset();
        markDirty();
      });
    }

    refs.addSiteRule.addEventListener("click", addRule);
    refs.siteHostname.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addRule();
      }
    });
    refs.saveSiteEditor.addEventListener("click", saveSiteEditor);
    refs.removeSelectedRule.addEventListener("click", () => {
      if (selectedHostname) {
        removeRule(selectedHostname);
      }
    });
    refs.closeSiteEditor.addEventListener("click", closeSiteEditor);
    refs.siteCustomCss.addEventListener("input", () => {
      globalThis.clearTimeout(cssValidationTimer);
      setMessage(refs.cssValidation, "Checking CSS…");
      cssValidationTimer = globalThis.setTimeout(showCssValidation, 280);
    });

    refs.prepareExport.addEventListener("click", prepareExport);
    refs.downloadExport.addEventListener("click", downloadExport);
    refs.importFile.addEventListener("change", loadImportFile);
    refs.importJson.addEventListener("click", importFromText);

    refs.openResetDialog.addEventListener("click", () => {
      if (typeof refs.resetDialog.showModal === "function") {
        refs.resetDialog.returnValue = "";
        refs.resetDialog.showModal();
      }
    });
    refs.resetDialog.addEventListener("close", () => {
      if (refs.resetDialog.returnValue === "confirm") {
        resetAll();
      }
    });

    if (browserApi.storage.onChanged) {
      browserApi.storage.onChanged.addListener((changes, areaName) => {
        const storageKey = Settings.STORAGE_KEY || FALLBACK_STORAGE_KEY;
        if (areaName !== "local" || !changes[storageKey] || isDirty || isWriting) {
          return;
        }
        state = normalize(changes[storageKey].newValue);
        renderForm();
        setStatus("Updated from another Nightglass window", "saved");
      });
    }
  }

  function disablePage(message) {
    setStatus("Setup error", "error");
    for (const control of refs.form.querySelectorAll("button, input, select, textarea")) {
      control.disabled = true;
    }
    showToast(message, "error");
  }

  async function initialize() {
    if (!Settings || !browserApi?.storage?.local) {
      disablePage("Nightglass could not load its local settings service.");
      return;
    }

    try {
      renderPresetOptions();
      const storageKey = Settings.STORAGE_KEY || FALLBACK_STORAGE_KEY;
      const stored = await browserApi.storage.local.get(storageKey);
      state = normalize(stored[storageKey]);
      renderForm();
      bindEvents();
      isDirty = false;
      setStatus("Saved locally", "saved");
    } catch (error) {
      disablePage(error?.message || "Nightglass could not read its settings.");
    }
  }

  initialize();
})();
