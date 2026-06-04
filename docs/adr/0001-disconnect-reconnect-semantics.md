# ADR-0001: Disconnect and rejoin semantics

- **Status**: Accepted
- **Date**: 2026-06-04
- **Context**: PR #6 — `fix/ghost-lobby-disconnect-indicator`

## Context

The lobby needs to handle dropped connections in a way that is both
**visible** (the rest of the team can see who is gone) and
**recoverable** (the disconnected user comes back automatically, and
does not leave a stale "ghost-self" entry in the lobby).

Three concrete problems had to be solved:

1. **Silent ghost lobby** — when a user lost their connection, the
   server removed their participant immediately. The remaining team
   either kept seeing them as if nothing had happened (no UI signal
   for the disconnect), or saw the row vanish with no explanation.
2. **Ghost-self on refresh** — a page refresh got a fresh socket id
   and a fresh participant entry, while the previous socket's
   `disconnect` event had turned the old entry into a "ghost". The
   user saw themselves twice: once active, once offline.
3. **Buttons stuck after coming back** — when Chrome's "Offline"
   toggle was flipped off again, the banner never reliably appeared
   and the estimate/reveal/reset buttons did nothing, because
   `socket.io-client` was waiting on engine.io's ping timeout
   (~20 s) before the transport reported the disconnect. Emits from
   the buttons queued against a stale transport that the server no
   longer had.

## Decision

### Identity layering

| Scope           | Storage          | Purpose                                                                                                                                       |
| --------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `qp-user-id`    | `localStorage`   | Persistent across sessions. Prunes same-user ghosts on rejoin.                                                                                |
| `qp-session-id` | `sessionStorage` | Per-tab. Lets the server recognise "same person, same tab refresh" and drop the matching **active** entry, even before the heartbeat timeout. |

The two-layer identity keeps multi-tab sessions independent
(same `userId`, different `sessionId` → both stay) while letting
in-tab refreshes land cleanly (same `userId` + same `sessionId`
on a fresh socket → the old one is pruned).

### Server-side lifecycle

1. On socket `disconnect` or heartbeat timeout, the participant is
   kept as a **ghost** (`connected: false`) for `GHOST_TIMEOUT = 60 s`
   instead of being removed.
2. `canReveal` and `reveal` ignore ghosts. A single dropped connection
   no longer blocks the round.
3. `runPeriodicCleanup` prunes ghosts older than `GHOST_TIMEOUT`.
4. `HEARTBEAT_TIMEOUT = 7 s` (5 s client heartbeat cadence → ghost
   visible to peers within ~7-12 s).
5. `getLobbyState` projects the public fields explicitly
   (`{ id, name, po, connected, estimate }`) so `userId`,
   `sessionId`, and `disconnectedAt` never leak to clients.
6. On `join`, the server prunes:
   - Any participant with matching `userId` + matching `sessionId`
     (active or ghost — covers in-tab refresh).
   - Any **ghost** with matching `userId` (covers cross-tab/session
     where the same user came back, possibly from a different tab).

### Client-side reconnect

1. The yellow banner reads **"You are offline. Retrying to reconnect
   in Xs…"** with a live countdown. There is **no manual Reconnect
   button** — recovery is fully automatic.
2. Two signals race to set `disconnected = true`:
   - Browser `offline` event — fast path (bypasses the 5 s grace).
   - Socket `disconnect` that stays down for **5 s** — covers cases
     the OS didn't notice.
3. On `offline`, the client **calls `socket.disconnect()`** so emits
   from button clicks don't enqueue against the stale transport.
4. The countdown calls `socket.connect()` every 5 s and resets to 5.
5. On `online`, the client proactively calls `socket.connect()`
   immediately, then keeps the countdown loop running until the real
   socket `connect` event arrives.
6. The actual `connect` event clears the banner and re-joins the
   lobby. `online` alone does **not** clear the banner — only the
   real `connect` does — so the rejoin path always runs.
7. The page is intentionally **quiet at load** when
   `navigator.onLine === false`. The 5 s socket-disconnect fallback
   covers that path.

## Consequences

**Positive**

- Disconnect is visible immediately, not after a silent 30 s wait.
- Refresh does not leave a ghost-self card.
- Multi-tab sessions are independent and not clobbered by another
  tab's disconnect.
- Recovery is automatic — no manual button to click.

**Trade-offs (deliberate)**

- **False-positive ghosts** — 5 s heartbeat + 7 s timeout means a
  single delayed heartbeat (~1-2 s blip) can briefly mark a healthy
  client as a ghost. Accepted for the visibility benefit.
- **Tight heartbeat** — a real connection blip lasting >7 s will mark
  the user as offline for up to 60 s of grace plus 7-12 s
  re-detection. Documented as a known trade-off.
- **State redaction** — requires explicit field projection in
  `getLobbyState` (not `...p` spread). The function is exported
  specifically so the redaction is asserted in tests.
- **Per-tab sessionId resets on tab close** — closing and reopening
  a tab gets a new `sessionId`, so the old ghost stays for the full
  60 s grace period. Accepted: the user explicitly closed.

## Implementation references

- `src/server.ts:294-313` — `getLobbyState` explicit field projection.
- `src/server.ts:204-220` — `markParticipantGhosts`.
- `src/server.ts:415-428` — join handler prune rules.
- `src/server.ts:294` — `GHOST_TIMEOUT` constant.
- `public/app.ts:97-124` — countdown loop.
- `public/app.ts:174-184` — `offline` / `online` handlers.
- `public/app.ts:3-13` / `15-25` — `getUserId` / `getSessionId`.
- `tests/server.test.ts` — `Connection Status`, `Public state
redaction`, `join payload compatibility`, `Multi-tab refresh flow`
  describe blocks.
- `tests/frontend.test.ts` — `DISCONNECT HANDLING` block.
