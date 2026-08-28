# Privacy audit

Audit date: 2026-08-27

Nightglass was reviewed specifically for data collection, harvesting,
persistence, outbound transmission, remote code, and webpage-to-extension
privilege boundaries.

## Result

Nightglass contains no analytics, telemetry, advertising, tracking identifiers,
account system, backend service, crash reporting, remote configuration, fixed
collection endpoint, or remotely loaded executable code.

The only data persisted by Nightglass is the user's appearance configuration:
global theme settings, exact-hostname site rules, and optional local CSS entered
by the user. Desktop settings use local extension storage; iPhone settings use
the userscript manager's local value storage. Nightglass does not use browser
sync storage.

The color renderer temporarily processes page styles and image metadata in
memory. Its upstream page-origin `sessionStorage` caches were removed. Renderer
caches are cleared on teardown and are not written to page storage, extension
storage, or userscript storage.

## Network boundary

Nightglass has no Nightglass-operated server, fixed outbound destination, or
privileged cross-origin request broker. Its background worker has no network
function, extension pages use `connect-src 'none'`, and the iPhone userscript
has neither `GM.xmlHttpRequest` nor `@connect` permission.

A dynamic color engine sometimes must retrieve a stylesheet or image already
selected by the current webpage when the renderer cannot read it directly. Both
desktop and userscript builds make that functional request through the
document's native Fetch API, so the browser's ordinary page CORS boundary stays
in force. The request:

- is limited to public HTTPS domain names and GET;
- sends no cookies, credentials, authorization data, or referrer;
- rejects credentials embedded in URLs, non-default ports, redirects, final URL
  changes, literal IPs, and single-label or local-network names;
- cannot read a response unless browser CORS authorizes the current page;
- has request timeout, per-response size, concurrency, queue, per-document
  request-count, and per-document byte limits; and
- is used only in memory for the current rendering operation.

As with any ordinary web resource request, the selected resource host can see
connection metadata such as the device's IP address. Nightglass does not attach
an identifier or send preferences, page text, form values, passwords, history,
or other Nightglass data.

## Findings remediated

The initial repository scan reported five privacy/security gaps. All five were
remediated before packaging:

1. Redirects could bypass private-network destination checks. The privileged
   broker was removed entirely; native page CORS requests reject redirects and
   revalidate final URLs.
2. Privileged cross-origin resource bodies could bypass page CORS. Desktop and
   iPhone builds now have no privileged cross-origin transport, so browser CORS
   is authoritative.
3. A webpage could inspect and synthesize events in the iPhone settings control.
   It now uses a closed shadow root and accepts persistent writes only from
   trusted user events.
4. The vendored renderer cached full resource URLs and page-derived bodies in
   webpage `sessionStorage`. Those caches are now memory-only.
5. Resource requests lacked an aggregate budget. Requests now have bounded
   concurrency, queue length, response size, duration, per-document count, and
   per-document total bytes.

Build hardening also pins the exact locally bundled renderer hashes, refuses to
build if the dependency has changed, forbids arbitrary userscripts from being
packaged, and scans production source for collection-capable channels.

## Verification

- `npm run verify`: 42 of 42 tests passed.
- Build policy validated all three desktop targets, pinned dependency hashes,
  Content Security Policy, assets, and local-code rules.
- Packaging validation produced deterministic Chromium, Firefox, Safari, and
  iPhone userscript artifacts.
- A clean Chrome 148 packaged-extension run verified initial and dynamic page
  rendering, native-dark-page preservation, popup loading, and settings loading.
- A real HTTPS cross-origin test verified that the packaged extension and the
  userscript transformed a CORS-authorized stylesheet while leaving an otherwise
  identical non-CORS stylesheet untouched. Server logs showed `mode: cors` with
  the page origin for renderer reads.
- Safari was visually verified with Nightglass actively transforming a live
  page and its toolbar popup reporting local-only settings.
- The iPhone userscript was exercised in an iPhone-sized real-browser viewport;
  the closed control boundary, Off/On/Auto behavior, dynamic content, and
  native-dark preservation passed.

The regression suite specifically checks for analytics, telemetry, sync
storage, fixed collectors, page-origin renderer storage, unsafe renderer
networking, userscript control exposure, vendor tampering, and unintended
userscript packaging.
