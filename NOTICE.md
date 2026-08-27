# Third-party notices

Nightglass uses the public Dark Reader API engine, version 4.9.125, which is
licensed under the MIT License. The upstream project is available at
<https://github.com/darkreader/darkreader>.

Nightglass carries a small, documented privacy patch over that pinned upstream
bundle: Dark Reader's page-origin `sessionStorage` resource caches are replaced
with memory-only maps that are cleared when the renderer is torn down, and its
cross-origin candidate filter validates protocol and host before caching an
approval. The upstream and patched SHA-256 digests are recorded in
`vendor/darkreader/VERSION` and enforced by the build.

Dark Reader is a trademark of its respective owner. Nightglass is an
independent personal project and is not affiliated with or endorsed by Dark
Reader Ltd. Nightglass does not use Dark Reader branding or proprietary Safari
application code.

The full upstream license is included at
`vendor/darkreader/LICENSE` and is copied into every generated package.
