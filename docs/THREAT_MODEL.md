# Threat model

## Assets and trust boundaries

Nightglass executes on untrusted webpages while holding broad website access.
The principal assets are the user's browsing confidentiality, authenticated
browser session, page integrity, and local preferences. Webpage scripts,
stylesheet content, cross-origin resources, and imported settings are untrusted.

## Security properties

1. There is no privileged page-to-background network bridge. The background
   worker performs only the user-configured keyboard toggle.
2. Renderer compatibility reads use the document's native Fetch API and browser
   CORS boundary. They accept only validated public HTTPS domain names, reject
   redirects, omit credentials and referrers, and bound time, size, concurrency,
   queue length, per-document request count, and per-document bytes.
3. Extension pages use a strict local-only Content Security Policy. There is no
   `eval`, dynamic executable import, inline event handler, or remote script.
4. Imported settings are normalized against a versioned schema. Custom CSS
   rejects remote `@import`, external `url()`, and legacy executable bindings.
5. Per-site state stores a canonical hostname, never a path, query, fragment,
   username, or password.
6. Generated theme changes are reversible. Failure tears the renderer down and
   leaves the page usable.
7. Vendor code is pinned by exact version and SHA-256 and shipped with its
   license. Builds fail if the pinned bundle changes unexpectedly.
8. Renderer resource results are memory-only and cleared on teardown; page
   URLs, CSS bodies, and image details are not written to page storage.
9. Page scripts cannot traverse the iPhone control's closed shadow root or use
   synthetic events to invoke a userscript-manager-backed settings write.

## Residual risks

- A malicious page can construct adversarially large or frequently mutating CSS
  to consume CPU. The renderer and per-document budgets impose limits, but
  iframe fan-out and theme work can still make such a page slower.
- An allowed resource host sees ordinary network metadata such as the user's IP
  address. Nightglass sends no identifier, settings, page text, or credentials.
- A hostile public hostname can change its DNS result. Nightglass does not add
  extension or GM network privilege to that request: native page CORS, mixed
  content, certificate validation, and browser private-network rules remain in
  force. Nightglass also rejects literal IPs and local or single-label names.
- User-authored custom CSS can make a page unusable even without remote code.
  It applies only where the user saved it and can be removed from settings.
- The userscript route inherits the security and availability of the installed
  userscript manager. Nightglass recommends the open-source Userscripts app and
  does not install or update that app itself.
- Browser and OS extension APIs enforce inaccessible areas such as privileged
  pages, protected viewers, and some frames. Nightglass fails open there.

## Out of scope

Nightglass does not intercept network traffic, cookies, form submissions,
canvas calls, or browser UI. It is not an ad blocker, password manager, content
filter, or anonymity tool.
