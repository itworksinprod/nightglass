(function enableNightglassRenderingPreview(root) {
  "use strict";

  if (new URLSearchParams(root.location.search).get("nightglass-preview") !== "1") {
    return;
  }

  const renderer = root.document.createElement("script");
  renderer.src = "../vendor/darkreader/darkreader.js";
  renderer.addEventListener("load", function applyNightglassTheme() {
    if (!root.DarkReader) {
      return;
    }
    root.DarkReader.setFetchMethod(function fetchPublicResource(url, init) {
      return root.fetch(url, Object.assign({}, init, {
        credentials: "omit",
        redirect: "error"
      }));
    });
    root.DarkReader.enable({
      mode: 1,
      brightness: 100,
      contrast: 100,
      sepia: 0,
      grayscale: 0,
      darkSchemeBackgroundColor: "#101c34",
      darkSchemeTextColor: "#f4faff"
    });
  }, {once: true});
  root.document.head.append(renderer);
})(globalThis);
