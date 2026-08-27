# Installation

Nightglass has two installation routes. The desktop extension has the fullest
toolbar experience. The iPhone route uses the same renderer in a self-contained
userscript so it does not require an Apple developer subscription.

## Chrome or Edge on the Mac

1. Run `npm run build` from the `nightglass` directory.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select `dist/chromium`.
5. Pin Nightglass to the toolbar and allow it on the websites you want themed.

Browser-internal pages, extension stores, and built-in PDF viewers do not allow
ordinary content extensions to run.

## Firefox on the Mac

For a temporary development install:

1. Run `npm run build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**.
4. Select `dist/firefox/manifest.json`.

Firefox removes temporary add-ons when it quits. Permanent personal signing can
be added later through Mozilla's normal add-on signing workflow.

## Safari on iPhone without an Apple developer subscription

This route uses [Userscripts for Safari](https://apps.apple.com/us/app/userscripts/id1463298887),
a free, [open-source](https://github.com/quoid/userscripts) userscript runner.
It is only the local runner; the Nightglass script itself contains the complete
theme engine and makes no remote-code requests.

1. Build Nightglass with `npm run build`.
2. Install and open Userscripts on the iPhone.
3. In Userscripts, select a script folder. A folder in iCloud Drive can also
   make the script file available to Safari on the Mac.
4. In iPhone Settings, open **Apps → Safari → Extensions → Userscripts**,
   enable it, and grant **Always Allow** for **All Websites**.
5. Put `dist/nightglass.user.js` into the selected Userscripts folder. You can
   transfer it with AirDrop, iCloud Drive, or the Files app.
6. Open the Userscripts extension menu once so it refreshes its script list,
   then reload a webpage.
7. Use the small Nightglass crescent on the page for site and theme controls.

All-site permission is necessary because automatic theming is implemented by a
content script running on each website. Nightglass does not persist page text,
form values, cookies, or browsing-history paths. It stores only preferences and
hostnames used for per-site rules.

The Userscripts project notes that iCloud may evict script files when storage is
optimized. On current iOS/macOS versions, mark the Nightglass script or its
folder **Keep Downloaded** if using iCloud.

## Native Safari Web Extension route

The generated `dist/safari-web-extension` directory is ready for Apple's Safari
Web Extension packager. With full Xcode installed, run:

```sh
xcrun safari-web-extension-packager \
  /absolute/path/to/nightglass/dist/safari-web-extension \
  --project-location /absolute/path/to/output \
  --app-name Nightglass \
  --bundle-identifier com.personal.nightglass \
  --swift
```

Apple's current documentation says physical-iPhone testing of a Safari Web
Extension requires paid Apple Developer Program membership. Simulator testing
is free. This is why the Userscripts build is the default iPhone route for this
personal project.

- [Apple: Packaging a web extension for Safari](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- [Apple: Running a Safari web extension](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)
- [Apple Developer Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment)

## Updating

Rebuild after source changes. Desktop unpacked extensions can be reloaded from
their extensions page. Replace the `.user.js` file on iPhone and open the
Userscripts extension menu once to refresh it.
