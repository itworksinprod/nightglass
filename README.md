# Nightglass

Nightglass is a private, local-only dark-mode reader for websites. It uses a
dynamic color engine rather than applying a global inversion filter, preserving
photos and video while recalculating page colors, gradients, controls, SVGs,
and dynamically inserted content.

The project produces:

- an unpacked Manifest V3 extension for Chrome and Edge;
- a Firefox Manifest V3 build;
- Safari Web Extension resources ready for Apple's packager;
- a self-contained userscript for iPhone Safari through the free, open-source
  Userscripts app.

Nightglass has no account, server, analytics, ads, telemetry, or remote code.
Settings stay in the browser's local extension storage. The iPhone userscript
stores its settings through the userscript manager. See the documented
[privacy boundary](docs/PRIVACY.md) and [privacy audit](docs/PRIVACY_AUDIT.md).

## Development

```sh
npm run verify
```

Generated browser builds are written to `dist/`. Install and platform-specific
instructions are generated into `dist/INSTALL.md`.

## Project status

Version 0.1.0 is packaged for personal use. Automated tests, build-policy
validation, and archive checks cover every target. Real packaged-extension smoke
tests have passed in Chrome 148, Firefox 154.0.1, and Safari 26.6.2. Safari checks
covered live page transformation, dynamically inserted content, native-dark
preservation, the toolbar popup, settings, and all-website access on HTTPS. The
userscript has also been exercised with an iPhone-sized browser viewport;
installation on a physical iPhone remains a device-side check. See
`docs/ARCHITECTURE.md` for design boundaries and known platform limitations.
