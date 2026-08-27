# Privacy statement

Nightglass is designed for private, local use. It has no analytics, telemetry,
advertising, tracking identifier, account, backend, crash reporter, remote
configuration, or remotely loaded executable code.

## Data Nightglass stores

- Global appearance preferences.
- Per-site preferences keyed by hostname, such as `example.com`.
- Optional local site-fix CSS entered by the user.

## Data Nightglass does not store or transmit

- Page text or images.
- Form values, passwords, or autofill data.
- Cookies, authentication tokens, or browser history.
- Full page URLs, paths, queries, or fragments.
- Analytics, diagnostics, crash reports, advertising identifiers, or device
  fingerprints.

Nightglass has no account system, backend service, analytics SDK, remote
configuration, remote code, or extension-specific update request. Browser or
userscript-manager installation mechanisms may perform their own normal update
checks; those are outside Nightglass.

The renderer may temporarily hold stylesheet text and image-analysis results in
memory while it calculates page colors. Nightglass patches the pinned Dark
Reader engine so those resource results are never written to the webpage's
`sessionStorage`, extension storage, or userscript storage. The memory cache is
discarded when the renderer is torn down or the page ends.

## Why it asks for website access

A dark-mode content extension must inspect and modify page styles on the sites
where it runs. The desktop extension therefore requests access to HTTP and HTTPS
pages. Safari lets the user restrict this permission per site. If permission is
denied, Nightglass leaves the page unchanged.

Nightglass does not use an extension-privileged network broker. Its background
worker has no network function, and extension pages have `connect-src 'none'`.
The iPhone userscript requests no `GM.xmlHttpRequest` grant and has no `@connect`
permission.

When the renderer needs a stylesheet or image already selected by the current
page, both builds use the document's native Fetch API and ordinary browser CORS.
Nightglass therefore cannot read a cross-origin response that the current page
is not allowed to read. The helper accepts only public HTTPS domain names, sends
GET requests without cookies, credentials, or a referrer, rejects redirects,
literal IPs, single-label/local names, and non-default ports, and enforces a
20-second timeout, a 5 MiB per-response limit, four-request concurrency, a
bounded queue, and per-document request and byte budgets. Responses are used
only in memory for the current rendering operation.

Like any page resource request, an allowed stylesheet or image host can see normal
connection metadata such as the device's IP address. Nightglass does not add an
identifier or send settings, page text, form data, browsing history, or any
other Nightglass data with that request.

The on-page iPhone control is held in a closed shadow root and accepts
persistent-setting changes only from trusted user events. Website scripts
cannot traverse the control or synthesize a settings change.

## Removing local data

Use **Reset all settings** in Nightglass settings, remove the userscript through
Userscripts, or uninstall the desktop extension. Browser-managed extension
storage is removed according to the browser's uninstall behavior. There is no
Nightglass server copy to delete.
