# Architecture

Nightglass has one rendering controller and several thin platform adapters.
The dynamic color work is delegated to the pinned, MIT-licensed Dark Reader API
engine. Nightglass owns activation rules, native-dark detection, privacy
boundaries, presets, per-site settings, user interface, packaging, and tests.

## Platform targets

- Chromium 148+ and current Edge: Manifest V3 service worker.
- Firefox 128+: Manifest V3 background script.
- Safari 18.4+: resources suitable for a multiplatform Safari Web Extension.
- iPhone Safari: a self-contained userscript for the free Userscripts runner.

The Safari app wrapper is deliberately thin. Apple requires the full Xcode
toolchain and paid Apple Developer Program membership to run a Safari Web
Extension on a physical iPhone. The userscript build avoids that recurring
cost while keeping the same renderer and local settings model.

## Security and privacy invariants

- No page text, form data, cookies, history paths, or account information is
  persisted.
- Per-site rules use hostnames only.
- There is no analytics, telemetry, update ping, remote configuration, or
  remotely executed code.
- Renderer resource results live only in memory. The pinned engine is patched
  so it never caches URLs, CSS, or image details in page-origin storage.
- Cross-origin resource retrieval uses only native page-context CORS—never a
  privileged background or userscript-manager request. It accepts only public
  HTTPS domain names, rejects redirects, omits credentials and referrers, and
  imposes time, response-size, concurrency, queue, per-document request, and
  per-document byte limits.
- Extension pages have `connect-src 'none'`; the background worker contains no
  fetch or message broker. The userscript has no `@connect` or privileged
  network grant.
- The iPhone control uses a closed shadow root and requires trusted user events
  before changing persistent settings.
- Ordinary builds verify the exact patched renderer, license, and pin record
  before producing output and package only the generated userscript.
- Turning Nightglass off removes generated theme nodes and restores the page.
- Unsupported and privileged browser pages fail open without modification.

## Known hard limits

Browser UI, internal settings pages, built-in PDF viewers, Reader View,
third-party extension pages, closed shadow roots, inaccessible cross-origin
frames, and pixels drawn inside canvases cannot always be recolored. Nightglass
does not globally invert photos or video.

Resource fetching is a renderer compatibility feature, not telemetry. A
resource without page CORS permission is deliberately left untransformed. An
allowed page resource host still sees ordinary connection metadata such as the
device IP address; Nightglass adds no identifier or user data to the request.
