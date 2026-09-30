# ADR-0002: Node.js version policy

- **Status**: Accepted
- **Date**: 2026-07-06

## Context

The project needs a consistent Node.js runtime for development, CI, and
container builds. Without a pinned policy, different contributors and
CI runners may use different Node versions, leading to subtle runtime
differences or type mismatches.

## Decision

1. **Node.js runtime** — always use the **latest active LTS** version.
   LTS releases provide a stable API surface and long support window.
2. **`@types/node`** — pin to the **same major** as the runtime
   version, at the latest available 24.x release. This prevents type
   mismatches where type declarations reference APIs not yet available
   in the actual runtime. (`@types/node` minor versions do not track
   Node minor versions exactly.)

## Enforcement

- The runtime version is pinned in `.node-version` (consumed by mise,
  nvm, and similar tools).
- CI reads the same pin via `actions/setup-node`'s `node-version-file`.
- The global mise config at `~/.config/mise/config.toml` mirrors the
  same version.
- `@types/node` in `package.json` is updated whenever the runtime
  version changes.
- The `FROM node:<version>-alpine*` tag in `Dockerfile:1` must match
  the `.node-version` pin.

## Consequences

- Developers and CI run the same Node version.
- TypeScript type checking stays aligned with runtime capabilities.
- Upgrading Node requires a deliberate update to `.node-version`,
  `Dockerfile`, `mise config.toml`, and `@types/node` simultaneously —
  making the change visible and reviewed.
