# Blitz maintenance branch

Personal fork: https://github.com/MrFam0s/iPhone-mcp
Branch: `maintenance/blitz-tooling`.

The 0.1.18-blitz.1 source changes were previously maintained locally and are
identical to `helpers/iphone-mcp-overlay/maintenance.patch` in the Blitz fork at
commit 9474f98b43e33ccc498c16443b420e3c7cbbacbb.

They provide scoped IDB companions, explicit simulator targeting, bounded and
serialized input without automatic replay, layout-aware German/US text input,
companion-backed UI scans and screen dimensions, reliable stdio shutdown, and
physical-device discovery that excludes Xcode simulated entries.

Run `npm test` with Node 22: TypeScript build, 17 Node regression tests and
7 Python keyboard tests. No live simulator or App Store mutation is required.

Blitz bundles the package reproducibly from pinned upstream plus its overlay;
this branch is a source backup, not an npm publication. Keep future runtime
changes synchronized with the Blitz overlay and package version. GitHub is used
only for free source hosting; no Actions workflow or paid service is enabled.
