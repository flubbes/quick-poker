# ADR-0003: Presence and reconnect reliability

- **Status**: Accepted
- **Date**: 2026-10-21
- **Context**: flaky mobile networks, background tabs, half-open connections

## Context

Remote teams join a planning-poker round from laptops, phones and
home connections. Three failure modes hurt much more than a clean
disconnect:

1. **Backgrounded tabs.** Browsers throttle timers in hidden tabs
   (roughly one tick per minute, and frozen entirely after a while).
   The client heartbeat stops, the server's 7 s timeout fires, and the
   team sees `(offline)` for somebody who is still sitting in the
   session, just reading another tab. The team then waits for, or
   distrusts, a teammate who is not actually gone.
2. **Half-open connections.** On flaky links a TCP connection can die
   without a FIN. The socket still reports `connected`, emits are
   black-holed, and the UI stays stale until engine.io's own ping
   timeout (~20-45 s) gives up. Meanwhile the user's clicks look like
   they worked.
3. **Vote loss on reconnect.** The join handler pruned the old
   participant and created a fresh one with `estimate: null`, so a
   10-second blip erased a vote that had already been cast.

ADR-0001 defined the ghost/rejoin contract. This ADR extends it.

## Decision

### Presence model

A participant has one of three presences, derived on the server:

| presence  | meaning                          | `connected` | blocks a Reveal |
| --------- | -------------------------------- | ----------- | --------------- |
| `active`  | connected, tab in the foreground | `true`      | yes             |
| `away`    | connected, tab in the background | `true`      | **no**          |
| `offline` | socket gone (ghost)              | `false`     | no              |

Tab visibility belongs to the browser tab, not to the lobby, so it is
tracked **per socket** (`socketAwayAt`) and projected per participant.
The client emits `visibility(lobbyId, visible)` on `visibilitychange`
and right after joining. `connected` keeps its old meaning
(`disconnectedAt === null`) so existing clients keep working.

`away` and `offline` participants are excluded from the Reveal check
and from any other gate: if somebody is not in the room, the round
must not wait for them. Reset was never gated on other participants
and stays that way.

### Liveness

| signal                               | value | why                                                                         |
| ------------------------------------ | ----- | --------------------------------------------------------------------------- |
| client heartbeat cadence             | 5 s   | unchanged                                                                   |
| client heartbeat ack timeout         | 8 s   | proves a half-open link in ≤13 s, then forces a reconnect                   |
| server timeout, `active` participant | 15 s  | tolerates one delayed beat on a slow link                                   |
| server timeout, `away` participant   | 90 s  | hidden tabs are throttled to ~1 beat/minute; 90 s tolerates one missed beat |
| ghost retention (`GHOST_TIMEOUT`)    | 60 s  | unchanged                                                                   |

The app heartbeat is only the **fast** dead-connection detector. A real
disconnect is still immediate through the TCP FIN / engine.io path;
the 15 s timeout covers clients that die silently (browser crash,
laptop lid). The server acknowledges every heartbeat even when the
socket is rate limited — a missing ack would make a healthy client
drop itself.

When an `away` participant exceeds the 90 s budget the server
force-disconnects the socket like the active path; the client
reconnects and re-joins when the tab wakes up.

### Reconnect loop

`socket.io`'s built-in auto-reconnect is **disabled**
(`reconnection: false`). There is exactly one retry loop:

- exponential backoff `1 s → 2 s → 4 s → 8 s → 15 s` (cap) with ±20 %
  jitter so clients do not retry in lockstep,
- the banner counts down to the **real** next attempt,
- `visibilitychange → visible` and the browser `online` event trigger
  an immediate attempt instead of waiting for the next tick,
- a failed **initial** connect also arms the banner after the 5 s
  grace (previously the page stayed silent forever).

Transport order is `websocket` first with an automatic `polling`
fallback (`tryAllTransports`), which avoids the polling→websocket
upgrade dance on flaky links while still working behind proxies that
block websockets.

### State carry-over

On join, when a participant with the same `userId` (same `sessionId`,
or a ghost of the same user) is pruned, its `name`, `po` and `estimate`
are carried into the new entry. A reconnect therefore keeps the vote.
A round that was reset while the user was away has already cleared the
ghost's estimate, so the carry-over cannot resurrect a stale one.

## Consequences

**Positive**

- A backgrounded tab is shown as `(tab in background)` instead of
  `(offline)`, and it no longer holds up the Reveal.
- A network blip costs at most the reconnect time, not the vote.
- Half-open links are detected in seconds instead of tens of seconds.
- One retry loop, with jitter, instead of two competing ones.

**Trade-offs (deliberate)**

- **Away participants don't block the round.** If somebody switches
  tabs without voting, the team can reveal without them. They cannot
  estimate after a reveal — same rule as ghosts.
- **A frozen tab looks offline.** Browsers may freeze background tabs
  entirely (Chrome after ~5 min, Firefox energy saver); a frozen tab
  cannot answer pings and is treated as gone. Recovery is automatic
  when it wakes.
- **Ghost visibility for silent deaths slows to ~15-20 s** (was
  ~7-12 s). Real disconnects are still immediate.
- **Carry-over is per user, not per tab.** A different tab of the same
  user inherits the vote that was already cast. This matches the
  identity model from ADR-0001.

## Implementation references

- `src/server.ts` — `Presence`, `socketAwayAt`, `getPresence`,
  `isActiveParticipant`, `visibility` handler, heartbeat ack,
  `runHeartbeatCleanup`, join carry-over, `getLobbyState` projection.
- `public/app.ts` — `sendHeartbeat` (ack), `startReconnectCountdown`
  (backoff), `onVisibilityChange`, `connect_error` handling,
  `presenceSuffix`.
- `public/index.html`, `public/style.css` — `(tab in background)` label
  and the `.card.away` style.
- `tests/server.test.ts` — `PRESENCE (BACKGROUND TABS)` block.
- `tests/frontend.test.ts` — visibility, ack heartbeat, backoff and
  label tests.
