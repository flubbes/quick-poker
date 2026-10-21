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
4. `HEARTBEAT_TIMEOUT = 15 s` for foreground tabs, `90 s` for
   backgrounded tabs (see ADR-0003). A real disconnect still ghosts
   immediately; the heartbeat timeout only covers silent deaths.
5. `getLobbyState` projects the public fields explicitly
   (`{ id, name, po, connected, presence, estimate }`) so `userId`,
   `sessionId`, and `disconnectedAt` never leak to clients.
6. On `join`, the server prunes:
   - Any participant with matching `userId` + matching `sessionId`
     (active or ghost — covers in-tab refresh).
   - Any **ghost** with matching `userId` (covers cross-tab/session
     where the same user came back, possibly from a different tab).
     The pruned participant's `name`, `po` and `estimate` are carried
     over to the new entry (ADR-0003).

### Client-side reconnect

> **Extended by [ADR-0003](0003-presence-and-reconnect-reliability.md):**
> the fixed 5 s retry cadence described below was replaced by a single
> exponential backoff loop (1 s → 15 s, ±20 % jitter), the client
> disables socket.io's own auto-reconnect, and a backgrounded tab is
> reported as `away` instead of turning into a ghost. The visibility
> contract of this ADR (banner copy, no manual button, rejoin on
> `connect`) is unchanged.

1. The yellow banner reads **"You are offline. Retrying to reconnect
   in Xs…"** with a live countdown. There is **no manual Reconnect
   button** — recovery is fully automatic.
2. Two signals race to set `disconnected = true`:
   - Browser `offline` event — fast path (bypasses the 5 s grace).
   - Socket `disconnect` that stays down for **5 s** — covers cases
     the OS didn't notice.
3. On `offline`, the client **calls `socket.disconnect()`** so emits
   from button clicks don't enqueue against the stale transport.
4. The countdown calls `socket.connect()` on every attempt and resets
   to the next backoff delay.
5. On `online`, the client proactively calls `socket.connect()`
   immediately, then keeps the countdown loop running until the real
   socket `connect` event arrives.
6. The actual `connect` event clears the banner and re-joins the
   lobby. `online` alone does **not** clear the banner — only the
   real `connect` does — so the rejoin path always runs.
7. A failed initial connect arms the 5 s banner too, so a load with no
   network is no longer silent forever.
8. The page stays quiet for the first 5 s after load even when
   `navigator.onLine === false`; after that the banner appears and the
   retry loop takes over.

### Persistence model

User-visible preferences survive a hard reload (`location.reload()`,
tab restore, OS kill) by mirroring a small subset of state into
`localStorage`. The server is the source of truth; `localStorage` is
a cache that primes Vue data on mount and is overwritten by the next
server `state` event.

| Key          | Purpose      | Read on mount | Write trigger                                                                                             | Strict value check                                                               |
| ------------ | ------------ | ------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `qp-name`    | Display name | yes           | Optimistic — `updateName()` writes to `localStorage` in the same tick as the `setName` socket emit.       | Any string, max 15 chars (server-trimmed).                                       |
| `qp-user-po` | PO role flag | yes           | Pessimistic — the `state` event handler writes `"1"` (or `removeItem`s) when `me.po` is server-confirmed. | `=== "1"`; any other value (including `"0"`, `"true"`, or `null`) seeds `false`. |

The split is deliberate:

- **`qp-name` is optimistic** — a user typing their name should not
  see it flicker back to the previous value while the round-trip is
  in flight. The `setName` socket emit is fire-and-forget from the
  client's perspective.
- **`qp-user-po` is pessimistic** — a refresh must mirror whatever
  the server has, not whatever the previous client optimistically
  emitted. Writing only in the `state` handler means a tab that
  lost its socket, reconnected, and re-joined always gets a
  fresh, authoritative value.

`localStorage` is the only browser store used for preferences. The
persisted value is cleared by the relevant handler on logout /
revert; the only ways for it to get out of sync with the server
are (a) the server reset its in-memory lobby between sessions
(`localStorage` still says PO) — the next `state` event will
overwrite it; or (b) the user manually edits `localStorage` — the
`=== "1"` check keeps the seed safe.

Identity keys (`qp-user-id`, `qp-session-id`) are a separate concern
and are documented in **Identity layering** above.

## Consequences

**Positive**

- Disconnect is visible immediately, not after a silent 30 s wait.
- Refresh does not leave a ghost-self card.
- Multi-tab sessions are independent and not clobbered by another
  tab's disconnect.
- Recovery is automatic — no manual button to click.

**Trade-offs (deliberate)**

- **False-positive ghosts are no longer a concern** — ADR-0003 raised
  the foreground timeout to 15 s and gave background tabs a 90 s
  budget, so a delayed heartbeat no longer turns a healthy client into
  a ghost.
- **Slower silent-death detection** — a client that dies without a
  FIN is shown offline after ~15-20 s (was ~7-12 s). Real disconnects
  still ghost immediately.
- **State redaction** — requires explicit field projection in
  `getLobbyState` (not `...p` spread). The function is exported
  specifically so the redaction is asserted in tests.
- **Per-tab sessionId resets on tab close** — closing and reopening
  a tab gets a new `sessionId`, so the old ghost stays for the full
  60 s grace period. Accepted: the user explicitly closed.

## Implementation references

- `src/server.ts` — `getLobbyState` explicit field projection,
  `markParticipantGhosts`, the join-handler prune rules, and
  `GHOST_TIMEOUT`.
- `src/server.ts` — presence, heartbeat timeouts and rejoin carry-over
  now live in ADR-0003.
- `public/app.ts` — the retry loop (`startReconnectCountdown`),
  `offline` / `online` handlers, `getUserId` / `getSessionId`, the
  preference seeds in `data()` and the `state` mirror for
  `qp-user-po`.
- `tests/server.test.ts` — `Connection Status`, `Public state
  redaction`, `join payload compatibility`, `Multi-tab refresh flow`
  describe blocks.
- `tests/frontend.test.ts` — `DISCONNECT HANDLING` block.
