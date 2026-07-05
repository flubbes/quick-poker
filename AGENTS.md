# Quick Poker — Agent Reference

Single-container planning poker app for remote teams. Works in Firefox and Chromium-based browsers.

## Living Documentation

This file is maintained by opencode alongside code changes. After any non-trivial code change, before considering the task done, review and update the relevant docs so they stay in sync:

- **AGENTS.md** — if a new command, module, test category, convention, or gotcha is introduced.
- **README.md** — if user-facing commands, ports, or behavior change.
- **reviews/todo.md** — check off completed items, add new ones for deferred work.
- **privacy-policy.md** — keep section placeholders flagged until filled in.

Doc updates ship in the same commit (or PR) as the code change that motivated them. Never leave docs out of sync with the code they describe.

## README Structure

`README.md` is the user-facing entry point and must follow this order:

1. **What the app is** — one short paragraph: what it does and who it's for.
2. **How to use it** — short steps and the URL/local address where it runs.
3. **Self-hosting (Docker)** — short section: `docker build` + `docker run`, plus the `TRUST_PROXY` env if relevant.
4. **Development** — covers: tech stack, running locally, developing, troubleshooting.

When editing `README.md`, keep this order. New sections slot in; the order does not change.

## Architecture

- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: Vue 3 (global build, served from container)
- **Styling**: Vanilla CSS, dark mode only
- **Container**: Single Docker container

## Running Locally

```bash
npm start          # esbuild frontend + tsx server on PORT (default 3000)
npm run dev        # alias for npm start
```

Open `http://localhost:3000` — a new lobby is created on every visit.

Notes:

- The server does **not** hot-reload. Restart with `npm start` after code changes to pick them up.
- `AUTO_START=false` is for tests only. Do **not** set it for local runs — the server will silently fail to bind.
- Node version is pinned in `.node-version` — always use latest LTS. See [ADR-0002](docs/adr/0002-node-version-policy.md).

## Known Gotchas

- `AUTO_START=false` prevents the server from binding on module load. It is used by `tests/server.test.ts` to run the server in-process. Do not set it for `npm start`.
- The running server keeps serving its in-memory code. After a `git pull`, `git merge`, or PR merge, restart the server to pick up changes.
- **Dockerfile Node version must match `.node-version`** — when bumping the Node version, update both `.node-version` and the image tag in `Dockerfile:1`. A mismatch between the two means the container runs a different runtime than development/CI.

## Requirements

### Lobby / Session Lifecycle

1. Opening `/` creates a new planning session.
2. URL updates to a sharable link with a non-guessable lobby ID (URL hash).
3. Opening an existing lobby link shows current participants.
4. A lobby can be used to estimate multiple times (resettable rounds).
5. Lobby starts in "ready to estimate" state with all cards hidden.

### Estimation Flow

1. Possible estimations: `0, 1, 2, 3, 5, 8, 13, 20, 40`.
2. Until someone clicks **Reveal**, all cards stay hidden.
3. The first person to estimate can still change their mind until reveal.
4. Everyone can change their estimate freely before reveal — no one can see others' choices.
5. When **all active (connected) non-PO participants have estimated**, the **Reveal** button becomes active.
6. When **Reveal** is pressed:
   - All cards are revealed.
   - No re-estimation is possible.
   - The **Reveal** button turns into a **Reset** button.
7. Clicking **Reset** starts a new estimation round (all cards hidden, estimates cleared).

### Disconnect Handling

For the full design rationale and trade-offs, see
[docs/adr/0001-disconnect-reconnect-semantics.md](docs/adr/0001-disconnect-reconnect-semantics.md) and
[docs/adr/0003-presence-and-reconnect-reliability.md](docs/adr/0003-presence-and-reconnect-reliability.md). The contract:

1. The client shows a yellow **You are offline. Retrying to reconnect in Xs…** countdown banner as soon as it has reason to believe the network is down — whichever fires first:
   - The browser fires the `offline` event (e.g. Chrome dev-tools "Offline" toggle, OS losing Wi-Fi). This is the fast path and bypasses the 5 s grace period below.
   - The socket fires `disconnect` and stays disconnected for **5 seconds**.
   - A **failed initial connect** also arms the banner after 5 s (it never emits `disconnect`).
2. The banner is informational only — the client never exposes a manual **Reconnect** button. Reconnection runs automatically in the background.
3. On the browser's `offline` event, the client forces the socket into a disconnected state locally so button clicks do not enqueue against a stale transport.
4. The client runs **one** retry loop (`reconnection: false` on socket.io) with exponential backoff **1 s → 2 s → 4 s → 8 s → 15 s cap, ±20 % jitter**. The banner counts down to the real next attempt.
5. On the browser's `online` event, and whenever the tab becomes visible again, the client proactively calls `socket.connect()` immediately, then continues the countdown loop until the actual socket `connect` event arrives.
6. When the socket reconnects, the client automatically re-joins the lobby and the server carries the previous `name`, PO status and **estimate** over (see ADR-0003) — a network blip does not lose a vote. The name (`qp-name`) and PO status (`qp-user-po`) still come from `localStorage`; see [ADR-0001 §Persistence model](docs/adr/0001-disconnect-reconnect-semantics.md#persistence-model). The banner is cleared by the actual `connect` event, not by `online`, so the rejoin path always runs.
7. The client sends a persistent `qp-user-id` (localStorage) plus a per-tab `qp-session-id` (sessionStorage). On join, the server removes stale participants from the same user/session even before the heartbeat timeout marks the old socket as a ghost; active participants from other tabs with the same `qp-user-id` are kept.
8. Every participant has a **presence**: `active` (connected, tab visible), `away` (connected, tab in the background) or `offline` (ghost). The client reports tab visibility with the `visibility` event on `visibilitychange` and after joining.
9. On the server, disconnected participants are kept in the lobby as **ghosts** (`connected: false`) for `GHOST_TIMEOUT` (60s) so others can see who dropped off.
10. The server uses **`HEARTBEAT_TIMEOUT` = 15 s** for foreground tabs and **`AWAY_HEARTBEAT_TIMEOUT` = 90 s** for backgrounded tabs (browsers throttle hidden-tab timers to ~1 beat/minute). A real disconnect still ghosts immediately via the transport; the timeout only covers silent deaths.
11. The client heartbeat (5 s cadence) is **acknowledged** by the server. A missing ack after **8 s** proves the link is half-open and the client forces a reconnect.
12. **`offline` and `away` participants never block Reveal or Reset** — only `active` non-PO participants have to have estimated. Their estimate still counts if they already cast one.
13. Ghost participants are rendered with reduced opacity and a strikethrough name (`(offline)`); backgrounded participants show `(tab in background)` on a dashed card.

### Product Owner (PO) Role

1. A user can flag themselves as PO via the settings modal.
2. POs are **not** counted toward the group that must estimate.
3. The Reveal button becomes active based only on non-PO participants.

### User Settings

1. A cogwheel icon in the top-right opens a settings modal.
2. Users can change their display name.
3. Username is persisted in `localStorage`.
4. Username is limited to 15 characters.
5. Users can toggle PO status in the same modal.

### UI / UX

1. Dark mode only.
2. Clean and simple visual design.
3. Cards show a placeholder (`?` or `✓`) while hidden, actual value when revealed.
4. Own card is visually distinguished.
5. PO participants are visually distinguished (e.g., border color).

### Browser Compatibility

- Firefox (latest)
- Chromium-based browsers (Chrome, Edge, Brave, etc.)

## Testing

### Running Tests

```bash
npm test          # run once
npm run test:watch # watch mode
```

Tests use **Vitest** + **Socket.IO client** + **Supertest**. They run against the actual server in-process (`AUTO_START=false` prevents the server from binding to a port on module load).

### Test Coverage

`tests/server.test.ts` covers:

- **Lobby Lifecycle**: creation, joining, UUID validation, prototype-pollution resistance, max-participants cap, disconnect cleanup
- **Estimation Flow**: allowed values, value whitelist, changing mind before reveal, reveal preconditions, reset behavior, multi-round support
- **PO Role**: self-assignment, exclusion from reveal condition, server-side estimate blocking
- **State Redaction**: hidden votes show `✓`/`?`, own estimate visible, no raw value leakage before reveal
- **Connection Status**: ghost participants marked `connected: false`, `canReveal` ignores ghosts, grace-period cleanup via `GHOST_TIMEOUT`
- **Presence**: `active` / `away` / `offline` projection, `visibility` event round-trip, backgrounded participants stay connected, a delayed background heartbeat does not ghost them, away timeout drops them
- **Away/Offline Gating**: backgrounded and offline participants do not block Reveal or Reset
- **Heartbeat**: timestamp refresh, rate limit, ack callback, presence-aware timeout
- **Rejoin State Carry-Over**: name, PO status and estimate survive a reconnect of the same session or user
- **Reconnect Loop**: exponential backoff (1 s → 15 s, jitter), 8 s heartbeat-ack timeout forces a reconnect, tab becoming visible probes immediately
- **Rejoin Identity**: stable `qp-user-id` in localStorage plus per-tab `qp-session-id` in sessionStorage; stale participants from the same user/session are pruned on join; active participants from other tabs with the same `qp-user-id` are kept
- **Browser Offline/Online Signals**: `offline` shows banner immediately with a retry countdown, `online` proactively calls `socket.connect()`
- **Name Sanitization**: HTML metacharacter stripping, 15-char truncation
- **Rate Limiting**: join, estimate, reveal, reset, setName per-socket limits
- **Authorization / Security Regressions**: non-participants blocked from reveal, reset, setName, setPO, estimate; reveal blocked until all non-POs estimated
- **Multi-Lobby**: parallel lobby membership
- **HTTP Layer**: static files, security headers, HTTP 429 rate limit
- **Utilities**: `isValidLobbyId`, `sanitizeName`, `getClientIp` (with `TRUST_PROXY` env)

### After Any Code Change

1. **Run formatting check**: `npm run format:check`. If formatting issues are found, run `npm run format` to fix them.
2. **Run the full test suite**: `npm test`. If tests fail, fix the code or update tests if the behavior change is intentional. Never leave the test suite failing.

## Commit Conventions

All commits **must** follow the [Conventional Commits](https://www.conventionalcommits.org/) format (semantic commits):

```
<type>: <description>
```

Common types used in this project:

- `feat:` — new feature or behavior
- `fix:` — bug fix
- `docs:` — documentation-only changes
- `test:` — adding or updating tests
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `chore:` — tooling, dependency updates, or other maintenance

Examples:

```
feat: add heartbeat rate limiting to socket events
fix: prevent PO from submitting estimates
 docs: document TRUST_PROXY runtime opt-in
```

**Do not** create commits without a semantic prefix. If unsure, default to `chore:`.
