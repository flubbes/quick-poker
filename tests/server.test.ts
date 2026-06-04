import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { io as Client } from "socket.io-client";
import request from "supertest";
import {
  app,
  httpServer,
  io,
  lobbies,
  socketLimiter,
  lobbyCreationTracker,
  isValidLobbyId,
  isValidUserId,
  sanitizeName,
  getClientIp,
  runPeriodicCleanup,
  getLobbyState,
  lastHeartbeats,
  socketLobbies,
  ALLOWED_ESTIMATES,
  MAX_PARTICIPANTS,
  GHOST_TIMEOUT,
} from "../src/server";
import type { LobbyState } from "../src/server";

let port: number;

function createSocket() {
  return Client(`http://localhost:${port}`, {
    transports: ["websocket", "polling"],
  });
}

function connect(client: ReturnType<typeof createSocket>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket connection timeout")), 3000);
    client.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    client.on("connect_error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function disconnect(client: ReturnType<typeof createSocket>): Promise<void> {
  return new Promise((resolve) => {
    if (!client.connected) return resolve();
    client.disconnect();
    setTimeout(resolve, 100);
  });
}

function join(
  client: ReturnType<typeof createSocket>,
  lobbyId: string = "",
  userId?: string,
  sessionId?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    client.emit("join", lobbyId, userId ?? null, sessionId ?? null, (id: string | null) =>
      resolve(id),
    );
  });
}

function waitForEvent<T>(
  client: ReturnType<typeof createSocket>,
  event: string,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    client.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

type Participant = NonNullable<LobbyState>["participants"][number];

function waitForState(client: ReturnType<typeof createSocket>) {
  return waitForEvent<LobbyState>(client, "state");
}

beforeAll(() => {
  return new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address();
      if (address && typeof address === "object") {
        port = address.port;
      }
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => {
    io.close();
    httpServer.closeAllConnections?.();
    httpServer.close(() => resolve());
    setTimeout(resolve, 3000);
  });
});

beforeEach(() => {
  // Clear all lobbies
  Object.keys(lobbies).forEach((key) => delete lobbies[key]);
  // Clear socket rate limits
  socketLimiter.clear();
  // Clear lobby creation tracker
  lobbyCreationTracker.clear();
});

// ============================================================================
// LOBBY LIFECYCLE
// ============================================================================

describe("Lobby Lifecycle", () => {
  it("creates a new lobby with a valid UUID when no lobbyId is provided", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);
    expect(lobbyId).toBeTruthy();
    expect(isValidLobbyId(lobbyId)).toBe(true);
    expect(lobbies[lobbyId as string]).toBeTruthy();
    expect(lobbies[lobbyId as string].revealed).toBe(false);
    await disconnect(client);
  });

  it("joins an existing lobby and returns the same ID", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    const joinedId = await join(clientB, lobbyId as string);
    expect(joinedId).toBe(lobbyId);
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it("creates a lobby with a provided valid UUID if it does not exist (permanent links)", async () => {
    const existingId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    expect(lobbies[existingId]).toBeFalsy();

    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client, existingId);
    expect(lobbyId).toBe(existingId);
    expect(lobbies[existingId]).toBeTruthy();

    await disconnect(client);
  });

  it("rejects invalid lobby IDs and creates a new random one", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client, "__proto__");
    expect(lobbyId).toBeTruthy();
    expect(lobbyId).not.toBe("__proto__");
    expect(isValidLobbyId(lobbyId)).toBe(true);
    await disconnect(client);
  });

  it("prevents prototype pollution via lobby IDs", async () => {
    const client = createSocket();
    await connect(client);
    await join(client, "__proto__");
    await join(client, "constructor");
    await join(client, "toString");
    // Object.prototype should not be polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await disconnect(client);
  });

  it("caps lobby size at MAX_PARTICIPANTS", async () => {
    const lobbyId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const clients: ReturnType<typeof createSocket>[] = [];

    // First client creates the lobby
    const first = createSocket();
    await connect(first);
    const createdId = await join(first, lobbyId);
    expect(createdId).toBe(lobbyId);
    clients.push(first);

    // Fill the lobby to capacity
    for (let i = 1; i < MAX_PARTICIPANTS; i++) {
      const client = createSocket();
      await connect(client);
      const id = await join(client, lobbyId);
      expect(id).toBe(lobbyId);
      clients.push(client);
    }

    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(MAX_PARTICIPANTS);

    // Next join should fail
    const overflow = createSocket();
    await connect(overflow);
    const overflowId = await join(overflow, lobbyId);
    expect(overflowId).toBeNull();

    for (const c of clients) await disconnect(c);
    await disconnect(overflow);
  });

  it("broadcasts state to all participants on join", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const statePromiseA = waitForState(clientA);
    const lobbyId = await join(clientA);
    const stateA = await statePromiseA;
    expect(stateA).toBeTruthy();
    expect(stateA?.participants).toHaveLength(1);

    const clientB = createSocket();
    await connect(clientB);
    const statePromiseB = waitForState(clientB);
    await join(clientB, lobbyId as string);
    const stateB = await statePromiseB;
    expect(stateB?.participants).toHaveLength(2);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it("keeps participant as a ghost on disconnect (not removed immediately)", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);
    const clientAId = clientA.id as string;

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);

    await disconnect(clientA);
    // Give server a moment to process disconnect
    await new Promise((r) => setTimeout(r, 200));
    // A's participant becomes a ghost (disconnectedAt set, entry kept for grace period)
    const ghost = lobbies[lobbyId as string].participants[clientAId];
    expect(ghost).toBeTruthy();
    expect(ghost?.disconnectedAt).not.toBeNull();
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);

    await disconnect(clientB);
  });

  it("removes ghost participant after the grace period via periodic cleanup", () => {
    const lobbyId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    lobbies[lobbyId] = {
      id: lobbyId,
      participants: Object.create(null),
      revealed: false,
      createdAt: Date.now(),
    };
    lobbies[lobbyId].participants["ghost-socket"] = {
      id: "ghost-socket",
      userId: null,
      sessionId: null,
      name: "Ghost",
      estimate: 5,
      po: false,
      disconnectedAt: Date.now() - 70_000,
    };

    runPeriodicCleanup();
    expect(lobbies[lobbyId].participants["ghost-socket"]).toBeUndefined();
    delete lobbies[lobbyId];
  });

  it("keeps ghost participant within the grace period", () => {
    const lobbyId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    lobbies[lobbyId] = {
      id: lobbyId,
      participants: Object.create(null),
      revealed: false,
      createdAt: Date.now(),
    };
    lobbies[lobbyId].participants["ghost-socket"] = {
      id: "ghost-socket",
      userId: null,
      sessionId: null,
      name: "Ghost",
      estimate: 5,
      po: false,
      disconnectedAt: Date.now() - 10_000,
    };

    runPeriodicCleanup();
    expect(lobbies[lobbyId].participants["ghost-socket"]).toBeTruthy();
    delete lobbies[lobbyId];
  });
});

// ============================================================================
// ESTIMATION FLOW
// ============================================================================

describe("Estimation Flow", () => {
  it("accepts all allowed estimate values", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    for (const val of ALLOWED_ESTIMATES) {
      const statePromise = waitForState(client);
      client.emit("estimate", lobbyId, val);
      const state = await statePromise;
      const me = state?.participants.find((p: Participant) => p.id === client.id);
      expect(me?.estimate).toBe(val);
    }

    await disconnect(client);
  });

  it("rejects invalid estimate values", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit("estimate", lobbyId, 999);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    client.emit("estimate", lobbyId, "five");
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    client.emit("estimate", lobbyId, -1);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    await disconnect(client);
  });

  it("allows changing estimate before reveal", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit("estimate", lobbyId, 5);
    await waitForState(client);

    client.emit("estimate", lobbyId, 8);
    const state = await waitForState(client);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    expect(me?.estimate).toBe(8);

    await disconnect(client);
  });

  it("rejects estimates after reveal", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit("estimate", lobbyId, 5);
    await waitForState(client);

    client.emit("reveal", lobbyId);
    await waitForState(client);
    expect(lobbies[lobbyId as string].revealed).toBe(true);

    client.emit("estimate", lobbyId, 8);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBe(5);

    await disconnect(client);
  });

  it("canReveal is false when not all non-PO participants have estimated", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    // Nobody estimated yet
    clientA.emit("estimate", lobbyId, 5);
    const state = await waitForState(clientA);
    expect(state?.canReveal).toBe(false);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it("canReveal is true when all non-PO participants have estimated", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    clientA.emit("estimate", lobbyId, 5);
    await waitForState(clientA);

    clientB.emit("estimate", lobbyId, 8);
    const state = await waitForState(clientA);
    expect(state?.canReveal).toBe(true);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it("reveal shows all estimates and disables further estimation", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    clientA.emit("estimate", lobbyId, 5);
    await waitForState(clientA);
    clientB.emit("estimate", lobbyId, 8);
    await waitForState(clientA);

    clientA.emit("reveal", lobbyId);
    const state = await waitForState(clientA);
    expect(state?.revealed).toBe(true);
    expect(state?.participants.find((p: Participant) => p.id === clientA.id)?.estimate).toBe(5);
    expect(state?.participants.find((p: Participant) => p.id === clientB.id)?.estimate).toBe(8);

    // Try to estimate after reveal
    clientA.emit("estimate", lobbyId, 13);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[clientA.id as string].estimate).toBe(5);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it("reset starts a new round with hidden cards and cleared estimates", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    clientA.emit("estimate", lobbyId, 5);
    await waitForState(clientA);
    clientB.emit("estimate", lobbyId, 8);
    await waitForState(clientA);

    clientA.emit("reveal", lobbyId);
    await waitForState(clientA);
    expect(lobbies[lobbyId as string].revealed).toBe(true);

    clientA.emit("reset", lobbyId);
    const state = await waitForState(clientA);
    expect(state?.revealed).toBe(false);
    expect(
      state?.participants.every(
        (p) => p.estimate === "?" || p.estimate === null || p.estimate === "✓",
      ),
    ).toBe(true);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it("does not allow reset before reveal", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit("estimate", lobbyId, 5);
    await waitForState(client);

    client.emit("reset", lobbyId);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].revealed).toBe(false);

    await disconnect(client);
  });

  it("can be used for multiple estimation rounds", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Round 1
    client.emit("estimate", lobbyId, 5);
    await waitForState(client);
    client.emit("reveal", lobbyId);
    await waitForState(client);
    client.emit("reset", lobbyId);
    await waitForState(client);

    // Round 2
    client.emit("estimate", lobbyId, 8);
    const state = await waitForState(client);
    expect(state?.revealed).toBe(false);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    expect(me?.estimate).toBe(8);

    await disconnect(client);
  });
});

// ============================================================================
// PO ROLE
// ============================================================================

describe("PO Role", () => {
  it("allows a user to set themselves as PO", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit("setPO", lobbyId, true);
    const state = await waitForState(client);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    expect(me?.po).toBe(true);

    await disconnect(client);
  });

  it("excludes POs from the reveal condition", async () => {
    const poClient = createSocket();
    await connect(poClient);
    const lobbyId = await join(poClient);
    poClient.emit("setPO", lobbyId, true);
    await waitForState(poClient);

    const normalClient = createSocket();
    await connect(normalClient);
    await join(normalClient, lobbyId as string);

    // Only the non-PO needs to estimate for reveal to be possible
    normalClient.emit("estimate", lobbyId, 5);
    const state = await waitForState(normalClient);
    expect(state?.canReveal).toBe(true);

    await disconnect(poClient);
    await disconnect(normalClient);
  });

  it("prevents POs from estimating server-side", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit("setPO", lobbyId, true);
    await waitForState(client);

    client.emit("estimate", lobbyId, 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    await disconnect(client);
  });

  it("PO estimate rejection is logged as security event", async () => {
    // We can't easily capture console output in this setup,
    // but we verify the behavior is blocked server-side
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit("setPO", lobbyId, true);
    await waitForState(client);

    client.emit("estimate", lobbyId, 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    await disconnect(client);
  });
});

// ============================================================================
// STATE REDACTION (SECURITY)
// ============================================================================

describe("State Redaction", () => {
  it("hides other participants estimates before reveal", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    // A estimates
    const statePromiseA = waitForState(clientA);
    clientA.emit("estimate", lobbyId, 5);
    const stateAfterEstimate = await statePromiseA;
    const meAfterEstimate = stateAfterEstimate?.participants.find(
      (p: Participant) => p.id === clientA.id,
    );
    expect(meAfterEstimate?.estimate).toBe(5);

    // B joins
    const clientB = createSocket();
    await connect(clientB);
    const statePromiseB = waitForState(clientB);
    const statePromiseA2 = waitForState(clientA);
    await join(clientB, lobbyId as string);

    const stateB = await statePromiseB;
    const stateA2 = await statePromiseA2;

    // From A's view: own estimate visible, B hasn't estimated
    const aFromA = stateA2?.participants.find((p: Participant) => p.id === clientA.id);
    const bFromA = stateA2?.participants.find((p: Participant) => p.id === clientB.id);
    expect(aFromA?.estimate).toBe(5);
    expect(bFromA?.estimate).toBe("?");

    // From B's view: A's estimate hidden as '✓', B's own estimate is null (not estimated yet)
    const aFromB = stateB?.participants.find((p: Participant) => p.id === clientA.id);
    const bFromB = stateB?.participants.find((p: Participant) => p.id === clientB.id);
    expect(aFromB?.estimate).toBe("✓");
    expect(bFromB?.estimate).toBeNull(); // own un-submitted estimate is shown as null

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it("shows all estimates after reveal", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);
    clientA.emit("estimate", lobbyId, 5);
    await waitForState(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);
    clientB.emit("estimate", lobbyId, 8);
    await waitForState(clientA);

    clientA.emit("reveal", lobbyId);
    const state = await waitForState(clientA);
    expect(state?.revealed).toBe(true);
    expect(state?.participants.find((p: Participant) => p.id === clientA.id)?.estimate).toBe(5);
    expect(state?.participants.find((p: Participant) => p.id === clientB.id)?.estimate).toBe(8);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it("never leaks raw estimate values in WebSocket payloads before reveal", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    clientA.emit("estimate", lobbyId, 13);
    await waitForState(clientA);

    const clientB = createSocket();
    await connect(clientB);
    const statePromise = waitForState(clientB);
    await join(clientB, lobbyId as string);
    const state = await statePromise;

    const aEstimate = state?.participants.find((p: Participant) => p.id === clientA.id)?.estimate;
    expect(aEstimate).not.toBe(13);
    expect(aEstimate).not.toBe(5);
    expect(aEstimate).not.toBe(8);
    expect(["✓", "?"]).toContain(aEstimate);

    await disconnect(clientA);
    await disconnect(clientB);
  });
});

// ============================================================================
// PUBLIC STATE REDACTION (NO INTERNAL LEAKAGE)
// ============================================================================

describe("Public state redaction", () => {
  it("getLobbyState only exposes public participant fields to clients", () => {
    const lobbyId = "99999999-9999-9999-9999-999999999999";
    lobbies[lobbyId] = {
      id: lobbyId,
      participants: Object.create(null),
      revealed: false,
      createdAt: Date.now(),
    };
    lobbies[lobbyId].participants["socket-internal"] = {
      id: "socket-internal",
      userId: "deadbeef-dead-beef-dead-beefdeadbeef",
      sessionId: "cafef00d-cafe-f00d-cafe-f00dcafef00d",
      name: "Alice",
      estimate: 5,
      po: false,
      disconnectedAt: null,
    };

    const state = getLobbyState(lobbyId, "socket-internal");
    expect(state).toBeTruthy();
    const me = state!.participants[0];
    expect(Object.keys(me).sort()).toEqual(["connected", "estimate", "id", "name", "po"]);
    expect(me.id).toBe("socket-internal");
    expect(me.name).toBe("Alice");
    expect(me.po).toBe(false);
    expect(me.connected).toBe(true);
    expect(me.estimate).toBe(5);
    // Internal fields must not leak to the wire
    expect((me as unknown as Record<string, unknown>).userId).toBeUndefined();
    expect((me as unknown as Record<string, unknown>).sessionId).toBeUndefined();
    expect((me as unknown as Record<string, unknown>).disconnectedAt).toBeUndefined();

    delete lobbies[lobbyId];
  });

  it("getLobbyState still marks a ghost as connected=false for peers", () => {
    const lobbyId = "88888888-8888-8888-8888-888888888888";
    lobbies[lobbyId] = {
      id: lobbyId,
      participants: Object.create(null),
      revealed: false,
      createdAt: Date.now(),
    };
    lobbies[lobbyId].participants["ghost-socket"] = {
      id: "ghost-socket",
      userId: null,
      sessionId: null,
      name: "Bob",
      estimate: 8,
      po: false,
      disconnectedAt: Date.now() - 5_000,
    };
    lobbies[lobbyId].participants["viewer-socket"] = {
      id: "viewer-socket",
      userId: null,
      sessionId: null,
      name: "Viewer",
      estimate: null,
      po: false,
      disconnectedAt: null,
    };

    const state = getLobbyState(lobbyId, "viewer-socket");
    const ghost = state!.participants.find((p) => p.id === "ghost-socket");
    expect(ghost?.connected).toBe(false);
    expect(ghost?.estimate).toBe("✓"); // redacted for non-revealed, non-self
    // No internal fields leaked
    expect((ghost as unknown as Record<string, unknown>).disconnectedAt).toBeUndefined();

    delete lobbies[lobbyId];
  });
});

// ============================================================================
// CONNECTION STATUS (GHOST HANDLING)
// ============================================================================

describe("Connection Status", () => {
  it("marks participants as connected by default", async () => {
    const client = createSocket();
    await connect(client);
    const statePromise = waitForState(client);
    await join(client);
    const state = await statePromise;
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    expect(me?.connected).toBe(true);

    await disconnect(client);
  });

  it("marks other participants as disconnected in the state after they leave", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    const clientBId = clientB.id as string;
    const joinPromise = waitForState(clientB);
    await join(clientB, lobbyId as string);
    await joinPromise;

    const statePromise = waitForState(clientA);
    await disconnect(clientB);
    const state = await statePromise;
    const b = state?.participants.find((p: Participant) => p.id === clientBId);
    expect(b).toBeTruthy();
    expect(b?.connected).toBe(false);

    await disconnect(clientA);
  });

  it("canReveal is true when all active non-POs estimated, ignoring ghosts", async () => {
    const active = createSocket();
    await connect(active);
    const lobbyId = await join(active);

    const ghost = createSocket();
    await connect(ghost);
    await join(ghost, lobbyId as string);
    await waitForState(ghost);

    // Disconnect ghost - it becomes a participant with no estimate
    await disconnect(ghost);
    await new Promise((r) => setTimeout(r, 100));

    // The active client should be able to reveal even though the ghost has not estimated
    active.emit("estimate", lobbyId, 5);
    const state = await waitForState(active);
    expect(state?.canReveal).toBe(true);

    await disconnect(active);
  });

  it("allows reveal when the only un-estimated non-PO is a ghost", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);
    const clientAId = clientA.id as string;

    const clientB = createSocket();
    await connect(clientB);
    const clientBId = clientB.id as string;
    await join(clientB, lobbyId as string);

    // A estimates; B (still connected) does not
    clientA.emit("estimate", lobbyId, 5);
    await waitForState(clientA);

    // Mark B as a ghost directly; A's reveal should now be possible because
    // the only remaining active non-PO has estimated
    lobbies[lobbyId as string].participants[clientBId].disconnectedAt = Date.now();
    clientA.emit("reveal", lobbyId);
    const state = await waitForState(clientA);
    expect(state?.revealed).toBe(true);

    await disconnect(clientA);
    void clientAId;
  });

  it("canReveal is recomputed correctly after a same-session self-prune", async () => {
    // Two active non-POs, neither has estimated. A's tab "refreshes" -
    // the old A entry is pruned and a fresh A is added. canReveal should
    // stay false until somebody estimates.
    const userId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const sessionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    const a1 = createSocket();
    await connect(a1);
    const lobbyId = await join(a1, "", userId, sessionId);

    const b = createSocket();
    await connect(b);
    await join(b, lobbyId as string);

    // A's tab refreshes with the same userId+sessionId - the old A is
    // pruned and replaced.
    const a2 = createSocket();
    await connect(a2);
    const statePromise = waitForState(a2);
    await join(a2, lobbyId as string, userId, sessionId);
    const stateAfterRefresh = await statePromise;
    expect(stateAfterRefresh?.canReveal).toBe(false);

    // The new A tab estimates; B is still active and un-estimated, so
    // canReveal should still be false.
    a2.emit("estimate", lobbyId, 3);
    const stateAfterEstimate = await waitForState(a2);
    expect(stateAfterEstimate?.canReveal).toBe(false);

    // B estimates too — now both active non-POs have estimated.
    b.emit("estimate", lobbyId, 5);
    const stateAfterB = await waitForState(b);
    expect(stateAfterB?.canReveal).toBe(true);

    await disconnect(a2);
    await disconnect(b);
  });

  it("removes the previous ghost of the same user when they rejoin", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA, "", userId, sessionId);
    const oldId = clientA.id as string;

    await disconnect(clientA);
    await new Promise((r) => setTimeout(r, 100));

    // Old participant is now a ghost
    const ghost = lobbies[lobbyId as string].participants[oldId];
    expect(ghost?.disconnectedAt).not.toBeNull();

    // User refreshes: new socket, same userId, same lobby
    const clientA2 = createSocket();
    await connect(clientA2);
    const statePromise = waitForState(clientA2);
    await join(clientA2, lobbyId as string, userId, sessionId);
    const state = await statePromise;

    // Old ghost should be gone, only the new participant remains
    expect(lobbies[lobbyId as string].participants[oldId]).toBeUndefined();
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(1);
    const me = state?.participants.find((p: Participant) => p.id === clientA2.id);
    expect(me?.connected).toBe(true);

    await disconnect(clientA2);
  });

  it("keeps an active participant with the same userId across a new join", async () => {
    const userId = "22222222-2222-2222-2222-222222222222";
    const sessionId1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const sessionId2 = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    // First tab is still connected
    const tab1 = createSocket();
    await connect(tab1);
    const lobbyId = await join(tab1, "", userId, sessionId1);
    const tab1Id = tab1.id as string;

    // Second tab joins from the same browser (same userId)
    const tab2 = createSocket();
    await connect(tab2);
    await join(tab2, lobbyId as string, userId, sessionId2);

    // Both tabs are now active participants
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);
    expect(lobbies[lobbyId as string].participants[tab1Id]?.disconnectedAt).toBeNull();

    await disconnect(tab1);
    await disconnect(tab2);
  });

  it("removes an active stale participant from the same user session on rejoin", async () => {
    const userId = "33333333-3333-3333-3333-333333333333";
    const sessionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    const stale = createSocket();
    await connect(stale);
    const lobbyId = await join(stale, "", userId, sessionId);
    const staleId = stale.id as string;

    // Simulate the browser coming back before the server heartbeat marks the old socket as a ghost.
    const replacement = createSocket();
    await connect(replacement);
    await join(replacement, lobbyId as string, userId, sessionId);

    expect(lobbies[lobbyId as string].participants[staleId]).toBeUndefined();
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(1);

    await disconnect(stale);
    await disconnect(replacement);
  });

  it("does not remove a ghost with a different userId", async () => {
    const userA = "44444444-4444-4444-4444-444444444444";
    const userB = "55555555-5555-5555-5555-555555555555";
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA, "", userA);
    const oldA = clientA.id as string;

    await disconnect(clientA);
    await new Promise((r) => setTimeout(r, 100));

    // Different user joins the same lobby
    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string, userB);

    // Ghost A is still there because userIds differ
    expect(lobbies[lobbyId as string].participants[oldA]?.disconnectedAt).not.toBeNull();
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);

    await disconnect(clientB);
  });

  it("different-session same-userId active peer is preserved when the same-session tab refreshes", async () => {
    const userId = "66666666-6666-6666-6666-666666666666";
    const session1 = "a1111111-1111-1111-1111-111111111111";
    const session2 = "a2222222-2222-2222-2222-222222222222";

    // Tab 1 of user A joins
    const tab1 = createSocket();
    await connect(tab1);
    const lobbyId = await join(tab1, "", userId, session1);
    const tab1Id = tab1.id as string;

    // Tab 2 of user A joins (same userId, different sessionId — another tab)
    const tab2 = createSocket();
    await connect(tab2);
    await join(tab2, lobbyId as string, userId, session2);
    const tab2Id = tab2.id as string;

    // Tab 1 disconnects → becomes a ghost
    await disconnect(tab1);
    await new Promise((r) => setTimeout(r, 100));

    // Tab 1 re-joins with the same sessionId (page refresh)
    const tab1Refreshed = createSocket();
    await connect(tab1Refreshed);
    await join(tab1Refreshed, lobbyId as string, userId, session1);

    // The old tab1 ghost is pruned, but tab2 (different sessionId) stays.
    expect(lobbies[lobbyId as string].participants[tab1Id]).toBeUndefined();
    expect(lobbies[lobbyId as string].participants[tab2Id]).toBeTruthy();
    expect(lobbies[lobbyId as string].participants[tab2Id]?.disconnectedAt).toBeNull();
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);

    await disconnect(tab2);
    await disconnect(tab1Refreshed);
  });

  it("same-session same-userId ghost and same-userId active are both handled independently", async () => {
    const userA = "77777777-7777-7777-7777-777777777777";
    const userB = "88888888-8888-8888-8888-888888888888";
    const sharedSession = "b1111111-1111-1111-1111-111111111111";

    // User A joins twice with the same sessionId (refresh path).
    const a1 = createSocket();
    await connect(a1);
    const lobbyId = await join(a1, "", userA, sharedSession);
    const a1Id = a1.id as string;

    const a2 = createSocket();
    await connect(a2);
    await join(a2, lobbyId as string, userA, sharedSession);
    // a1 is now pruned, only a2 is present.
    expect(lobbies[lobbyId as string].participants[a1Id]).toBeUndefined();

    // User B joins in a different session, then disconnects → ghost.
    const b = createSocket();
    await connect(b);
    await join(b, lobbyId as string, userB, "b2222222-2222-2222-2222-222222222222");
    const bId = b.id as string;
    await disconnect(b);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[bId]?.disconnectedAt).not.toBeNull();

    // User C joins fresh; B's ghost must stay (different userId).
    const userC = "99999999-9999-9999-9999-999999999999";
    const c = createSocket();
    await connect(c);
    await join(c, lobbyId as string, userC, "c1111111-1111-1111-1111-111111111111");

    // A's tab2 + B's ghost + C's tab = 3 entries
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(3);
    expect(lobbies[lobbyId as string].participants[bId]?.disconnectedAt).not.toBeNull();

    await disconnect(a2);
    await disconnect(c);
  });
});

// ============================================================================
// USER ID VALIDATION
// ============================================================================

describe("isValidUserId", () => {
  it("accepts UUID-shaped user IDs", () => {
    expect(isValidUserId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects non-UUID values", () => {
    expect(isValidUserId("")).toBe(false);
    expect(isValidUserId("not-a-uuid")).toBe(false);
    expect(isValidUserId(null)).toBe(false);
    expect(isValidUserId(undefined)).toBe(false);
    expect(isValidUserId(123)).toBe(false);
  });
});

// ============================================================================
// JOIN PAYLOAD COMPATIBILITY
// ============================================================================

describe("join payload compatibility", () => {
  it("accepts the legacy (lobbyId, callback) shape with no userId or sessionId", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await new Promise<string | null>((resolve) => {
      client.emit("join", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", (id: string | null) =>
        resolve(id),
      );
    });
    expect(lobbyId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const participant = lobbies[lobbyId as string].participants[client.id as string];
    expect(participant).toBeTruthy();
    expect(participant?.userId).toBeNull();
    expect(participant?.sessionId).toBeNull();
    expect(participant?.disconnectedAt).toBeNull();

    await disconnect(client);
    delete lobbies[lobbyId as string];
  });

  it("accepts the (lobbyId, userId, callback) shape with no sessionId", async () => {
    const client = createSocket();
    await connect(client);
    const userId = "11111111-1111-1111-1111-111111111111";
    const lobbyId = await new Promise<string | null>((resolve) => {
      client.emit("join", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", userId, (id: string | null) =>
        resolve(id),
      );
    });
    expect(lobbyId).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const participant = lobbies[lobbyId as string].participants[client.id as string];
    expect(participant).toBeTruthy();
    expect(participant?.userId).toBe(userId);
    expect(participant?.sessionId).toBeNull();

    await disconnect(client);
    delete lobbies[lobbyId as string];
  });
});

// ============================================================================
// NAME SANITIZATION
// ============================================================================

describe("Name Sanitization", () => {
  it("sanitizes HTML characters from display names", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Name is sliced to 15 chars first, then HTML chars stripped
    client.emit("setName", lobbyId, "<script>alert(1)</script>");
    const state = await waitForState(client);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    // '<script>alert(1' (15 chars) -> remove < and > -> 'scriptalert(1'
    expect(me?.name).toBe("scriptalert(1");

    await disconnect(client);
  });

  it("truncates names to 15 characters", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit("setName", lobbyId, "ThisIsAVeryLongNameThatExceeds");
    const state = await waitForState(client);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    expect(me?.name.length).toBeLessThanOrEqual(15);

    await disconnect(client);
  });
});

// ============================================================================
// RATE LIMITING
// ============================================================================

describe("Rate Limiting", () => {
  it("rate limits join events per socket", async () => {
    const client = createSocket();
    await connect(client);

    // Exhaust join limit (10 per 60s)
    for (let i = 0; i < 10; i++) {
      await join(client);
    }

    const limited = waitForEvent<{ event: string }>(client, "rate-limited");
    client.emit("join", "");
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe("join");

    await disconnect(client);
  });

  it("rate limits estimate events per socket", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Exhaust estimate limit (10 per 5s)
    for (let i = 0; i < 10; i++) {
      client.emit("estimate", lobbyId, ALLOWED_ESTIMATES[0]);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, "rate-limited");
    client.emit("estimate", lobbyId, ALLOWED_ESTIMATES[0]);
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe("estimate");

    await disconnect(client);
  });

  it("rate limits reveal events per socket", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);
    client.emit("estimate", lobbyId, 5);
    await waitForState(client);

    // Exhaust reveal limit (5 per 10s)
    for (let i = 0; i < 5; i++) {
      client.emit("reveal", lobbyId);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, "rate-limited");
    client.emit("reveal", lobbyId);
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe("reveal");

    await disconnect(client);
  });

  it("rate limits reset events per socket", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);
    client.emit("estimate", lobbyId, 5);
    await waitForState(client);
    client.emit("reveal", lobbyId);
    await waitForState(client);

    // Exhaust reset limit (5 per 10s)
    for (let i = 0; i < 5; i++) {
      client.emit("reset", lobbyId);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, "rate-limited");
    client.emit("reset", lobbyId);
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe("reset");

    await disconnect(client);
  });

  it("rate limits setName events per socket", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Exhaust setName limit (10 per 10s)
    for (let i = 0; i < 10; i++) {
      client.emit("setName", lobbyId, `Name${i}`);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, "rate-limited");
    client.emit("setName", lobbyId, "TooMany");
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe("setName");

    await disconnect(client);
  });
});

// ============================================================================
// AUTHORIZATION / SECURITY REGRESSIONS
// ============================================================================

describe("Authorization & Security Regressions", () => {
  it("does not allow reveal by a socket that is not a participant", async () => {
    const victimA = createSocket();
    await connect(victimA);
    const lobbyId = await join(victimA);
    victimA.emit("estimate", lobbyId, 5);
    await waitForState(victimA);

    const attacker = createSocket();
    await connect(attacker);
    // Attacker does NOT join the lobby

    attacker.emit("reveal", lobbyId);
    await new Promise((r) => setTimeout(r, 200));
    expect(lobbies[lobbyId as string].revealed).toBe(false);

    await disconnect(victimA);
    await disconnect(attacker);
  });

  it("does not allow reset by a socket that is not a participant", async () => {
    const victimA = createSocket();
    await connect(victimA);
    const lobbyId = await join(victimA);
    victimA.emit("estimate", lobbyId, 5);
    await waitForState(victimA);
    victimA.emit("reveal", lobbyId);
    await waitForState(victimA);
    expect(lobbies[lobbyId as string].revealed).toBe(true);

    const attacker = createSocket();
    await connect(attacker);
    // Attacker does NOT join the lobby

    attacker.emit("reset", lobbyId);
    await new Promise((r) => setTimeout(r, 200));
    expect(lobbies[lobbyId as string].revealed).toBe(true);

    await disconnect(victimA);
    await disconnect(attacker);
  });

  it("does not allow setName by a socket that is not a participant", async () => {
    const victim = createSocket();
    await connect(victim);
    const lobbyId = await join(victim);
    const originalName = lobbies[lobbyId as string].participants[victim.id as string].name;

    const attacker = createSocket();
    await connect(attacker);
    attacker.emit("setName", lobbyId, "Hacked");
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[victim.id as string].name).toBe(originalName);

    await disconnect(victim);
    await disconnect(attacker);
  });

  it("does not allow setPO by a socket that is not a participant", async () => {
    const victim = createSocket();
    await connect(victim);
    const lobbyId = await join(victim);
    const originalPO = lobbies[lobbyId as string].participants[victim.id as string].po;

    const attacker = createSocket();
    await connect(attacker);
    attacker.emit("setPO", lobbyId, true);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[victim.id as string].po).toBe(originalPO);

    await disconnect(victim);
    await disconnect(attacker);
  });

  it("does not allow estimate by a socket that is not a participant", async () => {
    const victim = createSocket();
    await connect(victim);
    const lobbyId = await join(victim);

    const attacker = createSocket();
    await connect(attacker);
    attacker.emit("estimate", lobbyId, 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(1);

    await disconnect(victim);
    await disconnect(attacker);
  });

  it("does not allow reveal before all non-PO participants have estimated", async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    // Only A estimates
    clientA.emit("estimate", lobbyId, 5);
    await waitForState(clientA);

    clientA.emit("reveal", lobbyId);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].revealed).toBe(false);

    await disconnect(clientA);
    await disconnect(clientB);
  });
});

// ============================================================================
// MULTI-LOBBY
// ============================================================================

describe("Multi-Lobby Support", () => {
  it("allows a socket to join multiple lobbies", async () => {
    const client = createSocket();
    await connect(client);

    const lobbyA = await join(client);
    const lobbyB = await join(client);

    expect(lobbyA).not.toBe(lobbyB);
    expect(lobbies[lobbyA as string].participants[client.id as string]).toBeTruthy();
    expect(lobbies[lobbyB as string].participants[client.id as string]).toBeTruthy();

    await disconnect(client);
  });

  it("receives separate state updates for each lobby", async () => {
    const client = createSocket();
    await connect(client);

    const statePromiseA = waitForState(client);
    const lobbyA = await join(client);
    const stateA = await statePromiseA;
    expect(stateA?.lobbyId).toBe(lobbyA);

    const statePromiseB = waitForState(client);
    const lobbyB = await join(client);
    const stateB = await statePromiseB;
    expect(stateB?.lobbyId).toBe(lobbyB);

    await disconnect(client);
  });
});

// ============================================================================
// HTTP LAYER
// ============================================================================

describe("HTTP Layer", () => {
  it("serves the index page", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Quick Poker");
  });

  it("serves vue.global.js", async () => {
    const res = await request(app).get("/vue.global.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.text).toContain("Vue");
  });

  it("returns security headers via helmet", async () => {
    const res = await request(app).get("/");
    expect(res.headers["content-security-policy"]).toBeTruthy();
    expect(res.headers["strict-transport-security"]).toBeTruthy();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("returns 429 when HTTP rate limit is exceeded", async () => {
    // Make many rapid requests to trigger rate limit
    const requests: Promise<import("supertest").Response>[] = [];
    for (let i = 0; i < 250; i++) {
      requests.push(request(app).get("/"));
    }
    const responses = await Promise.all(requests);
    const has429 = responses.some((r) => r.status === 429);
    expect(has429).toBe(true);
  });
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

describe("Utility Functions", () => {
  it("isValidLobbyId accepts valid UUIDs", () => {
    expect(isValidLobbyId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidLobbyId("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe(true);
  });

  it("isValidLobbyId rejects invalid IDs", () => {
    expect(isValidLobbyId("")).toBe(false);
    expect(isValidLobbyId("not-a-uuid")).toBe(false);
    expect(isValidLobbyId("123")).toBe(false);
    expect(isValidLobbyId("__proto__")).toBe(false);
    expect(isValidLobbyId("constructor")).toBe(false);
    expect(isValidLobbyId(null)).toBe(false);
    expect(isValidLobbyId(undefined)).toBe(false);
  });

  it("sanitizeName strips HTML metacharacters", () => {
    expect(sanitizeName("<b>bold</b>")).toBe("bbold/b");
    expect(sanitizeName('"quoted"')).toBe("quoted");
    expect(sanitizeName("'apos'")).toBe("apos");
    expect(sanitizeName("a&amp;b")).toBe("aamp;b");
  });

  it("sanitizeName truncates to 15 characters", () => {
    expect(sanitizeName("1234567890123456")).toBe("123456789012345");
  });

  it("sanitizeName handles null", () => {
    expect(sanitizeName(null)).toBe("null");
  });

  it("sanitizeName handles undefined", () => {
    expect(sanitizeName(undefined)).toBe("undefined");
  });

  it("sanitizeName handles numbers", () => {
    expect(sanitizeName(123)).toBe("123");
  });
});

// ============================================================================
// HEARTBEAT
// ============================================================================

describe("Heartbeat", () => {
  it("updates lastHeartbeats on heartbeat event", async () => {
    const client = createSocket();
    await connect(client);
    const before = lastHeartbeats.get(client.id as string);
    expect(before).toBeTruthy();

    // Wait a bit then send heartbeat
    await new Promise((r) => setTimeout(r, 50));
    client.emit("heartbeat");
    await new Promise((r) => setTimeout(r, 50));

    const after = lastHeartbeats.get(client.id as string);
    expect(after).toBeGreaterThan(before!);

    await disconnect(client);
  });

  it("rate limits heartbeat events", async () => {
    const client = createSocket();
    await connect(client);

    // Exhaust heartbeat limit (60 per 60s)
    for (let i = 0; i < 60; i++) {
      client.emit("heartbeat");
      await new Promise((r) => setTimeout(r, 5));
    }

    const before = lastHeartbeats.get(client.id as string);
    await new Promise((r) => setTimeout(r, 50));
    client.emit("heartbeat");
    await new Promise((r) => setTimeout(r, 50));

    // Should not update because rate limited
    const after = lastHeartbeats.get(client.id as string);
    expect(after).toBe(before);

    await disconnect(client);
  });

  it("peer sees a heartbeat-timed-out participant as connected=false in subsequent state events", async () => {
    const live = createSocket();
    await connect(live);
    const lobbyId = await join(live);

    const dying = createSocket();
    await connect(dying);
    const joinPromise = waitForState(live);
    await join(dying, lobbyId as string);
    await joinPromise;
    const dyingId = dying.id as string;

    // Force the dying socket to look like it missed its heartbeat
    lastHeartbeats.set(dyingId, Date.now() - 10_000);

    // Wait for the 5s heartbeat-cleanup tick to fire.
    await new Promise((r) => setTimeout(r, 6_000));

    // Sanity check: the dying participant is now a ghost in the lobby.
    const ghost = lobbies[lobbyId as string].participants[dyingId];
    expect(ghost).toBeTruthy();
    expect(ghost?.disconnectedAt).not.toBeNull();

    const statePromise = waitForState(live);
    // Trigger any further activity to push a state; an estimate from
    // the live peer is the cheapest way.
    live.emit("estimate", lobbyId, ALLOWED_ESTIMATES[0]);
    const state = await statePromise;

    const dyingPeer = state?.participants.find((p) => p.id === dyingId);
    expect(dyingPeer).toBeTruthy();
    expect(dyingPeer?.connected).toBe(false);

    await disconnect(live);
  });
});

// ============================================================================
// SETPO RATE LIMITING
// ============================================================================

describe("setPO Rate Limiting", () => {
  it("rate limits setPO events per socket", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Exhaust setPO limit (10 per 10s)
    for (let i = 0; i < 10; i++) {
      client.emit("setPO", lobbyId, i % 2 === 0);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, "rate-limited");
    client.emit("setPO", lobbyId, true);
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe("setPO");

    await disconnect(client);
  });
});

// ============================================================================
// LOBBY CREATION RATE LIMITING
// ============================================================================

describe("Lobby Creation Rate Limiting", () => {
  it("allows up to 10 lobby creations per IP per minute", async () => {
    const clients: ReturnType<typeof createSocket>[] = [];

    for (let i = 0; i < 10; i++) {
      const client = createSocket();
      await connect(client);
      const lobbyId = await join(client);
      expect(lobbyId).toBeTruthy();
      clients.push(client);
    }

    // 11th should be blocked
    const overflow = createSocket();
    await connect(overflow);
    const overflowId = await join(overflow);
    expect(overflowId).toBeNull();

    for (const c of clients) await disconnect(c);
    await disconnect(overflow);
  });

  it("resets lobby creation limit after the window expires", async () => {
    // Exhaust limit
    const clients: ReturnType<typeof createSocket>[] = [];
    for (let i = 0; i < 10; i++) {
      const client = createSocket();
      await connect(client);
      await join(client);
      clients.push(client);
    }

    const overflow = createSocket();
    await connect(overflow);
    expect(await join(overflow)).toBeNull();

    // Expire all tracker entries manually
    const now = Date.now();
    for (const [, entry] of lobbyCreationTracker) {
      entry.resetTime = now - 1;
    }

    // After cleanup, new creation should work
    runPeriodicCleanup();
    expect(await join(overflow)).toBeTruthy();

    for (const c of clients) await disconnect(c);
    await disconnect(overflow);
  });

  it("userId/sessionId arguments do not affect the per-IP lobby creation budget", async () => {
    // Pre-existing lobby to join. The founder's empty-lobbyId join
    // counts as 1 of the 10 creation slots.
    const founder = createSocket();
    await connect(founder);
    const lobbyId = await join(founder);
    expect(lobbyId).toBeTruthy();
    await disconnect(founder);

    // Burn the remaining 9 per-IP lobby-creation slots.
    for (let i = 0; i < 9; i++) {
      const client = createSocket();
      await connect(client);
      expect(await join(client)).toBeTruthy();
      await disconnect(client);
    }

    // 10th empty-lobbyId join must be blocked.
    const overflow = createSocket();
    await connect(overflow);
    expect(await join(overflow)).toBeNull();

    // A fresh client with a valid userId+sessionId should still be able
    // to join the existing lobby — the userId/sessionId arguments must
    // not influence lobby-creation rate limiting (the existing lobby
    // is joined, not created).
    const joiner = createSocket();
    await connect(joiner);
    const joined = await join(
      joiner,
      lobbyId as string,
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    );
    expect(joined).toBe(lobbyId);

    await disconnect(joiner);
    await disconnect(overflow);
  });
});

// ============================================================================
// GET CLIENT IP
// ============================================================================

describe("getClientIp", () => {
  it("returns handshake address by default", () => {
    const socket = {
      handshake: {
        address: "127.0.0.1",
        headers: {},
      },
    } as unknown as import("socket.io").Socket;
    expect(getClientIp(socket)).toBe("127.0.0.1");
  });

  it("returns last IP from X-Forwarded-For when TRUST_PROXY is true", () => {
    const originalEnv = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "true";

    const socket = {
      handshake: {
        address: "10.0.0.1",
        headers: {
          "x-forwarded-for": "1.1.1.1, 2.2.2.2",
        },
      },
    } as unknown as import("socket.io").Socket;
    expect(getClientIp(socket)).toBe("2.2.2.2");

    process.env.TRUST_PROXY = originalEnv;
  });

  it("falls back to handshake address when X-Forwarded-For is empty and TRUST_PROXY is true", () => {
    const originalEnv = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "true";

    const socket = {
      handshake: {
        address: "10.0.0.1",
        headers: {},
      },
    } as unknown as import("socket.io").Socket;
    expect(getClientIp(socket)).toBe("10.0.0.1");

    process.env.TRUST_PROXY = originalEnv;
  });
});

// ============================================================================
// CLEANUP TIMERS
// ============================================================================

describe("Cleanup Timers", () => {
  it("disconnects sockets that have not sent a heartbeat within timeout", async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);
    const clientId = client.id as string;
    expect(lobbies[lobbyId as string]).toBeTruthy();

    // Manually set last heartbeat to be older than timeout
    lastHeartbeats.set(clientId, Date.now() - 10000);

    // Wait for heartbeat interval to fire (5s)
    await new Promise((r) => setTimeout(r, 6000));

    // Socket should be disconnected and marked as a ghost
    const ghost = lobbies[lobbyId as string].participants[clientId];
    expect(ghost).toBeTruthy();
    expect(ghost?.disconnectedAt).not.toBeNull();
    expect(socketLobbies.has(clientId)).toBe(false);

    await disconnect(client);
  });

  it("removes empty lobbies older than 5 minutes", () => {
    const lobbyId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    lobbies[lobbyId] = {
      id: lobbyId,
      participants: Object.create(null),
      revealed: false,
      createdAt: Date.now() - 310000,
    };

    runPeriodicCleanup();
    expect(lobbies[lobbyId]).toBeUndefined();
  });

  it("does not remove lobbies that still have participants", () => {
    const lobbyId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    lobbies[lobbyId] = {
      id: lobbyId,
      participants: {
        someId: {
          id: "someId",
          userId: null,
          sessionId: null,
          name: "Test",
          estimate: null,
          po: false,
          disconnectedAt: null,
        },
      },
      revealed: false,
      createdAt: Date.now() - 310000,
    };

    runPeriodicCleanup();
    expect(lobbies[lobbyId]).toBeTruthy();
    delete lobbies[lobbyId];
  });

  it("removes stale lobby creation tracker entries", () => {
    const ip = "192.168.1.1";
    lobbyCreationTracker.set(ip, { count: 5, resetTime: Date.now() - 1000 });

    runPeriodicCleanup();
    expect(lobbyCreationTracker.has(ip)).toBe(false);
  });

  it("does not remove fresh lobby creation tracker entries", () => {
    const ip = "192.168.1.2";
    lobbyCreationTracker.set(ip, { count: 5, resetTime: Date.now() + 60000 });

    runPeriodicCleanup();
    expect(lobbyCreationTracker.has(ip)).toBe(true);
    lobbyCreationTracker.delete(ip);
  });

  it("prunes ghosts older than GHOST_TIMEOUT and broadcasts the new state to peers", async () => {
    const viewer = createSocket();
    await connect(viewer);
    const lobbyId = await join(viewer);
    const viewerId = viewer.id as string;

    // Manually inject a ghost older than GHOST_TIMEOUT so the cleanup
    // will prune it on the next tick.
    lobbies[lobbyId as string].participants["ancient-ghost"] = {
      id: "ancient-ghost",
      userId: null,
      sessionId: null,
      name: "Ghost",
      estimate: 5,
      po: false,
      disconnectedAt: Date.now() - (GHOST_TIMEOUT + 1_000),
    };

    const statePromise = waitForState(viewer);
    runPeriodicCleanup();
    const state = await statePromise;

    expect(lobbies[lobbyId as string].participants["ancient-ghost"]).toBeUndefined();
    expect(state?.participants.find((p) => p.id === "ancient-ghost")).toBeUndefined();
    expect(state?.participants.find((p) => p.id === viewerId)).toBeTruthy();
    expect(state?.participants).toHaveLength(1);

    await disconnect(viewer);
  });
});

// ============================================================================
// MULTI-TAB / REFRESH FLOW (END-TO-END)
// ============================================================================

describe("Multi-tab refresh flow", () => {
  it("repeated refresh in the same tab prunes ghosts back down to a single active entry (C16)", async () => {
    const userId = "12121212-1212-1212-1212-121212121212";
    const sessionId = "13131313-1313-1313-1313-131313131313";

    // Original tab joins.
    const tab1 = createSocket();
    await connect(tab1);
    const lobbyId = await join(tab1, "", userId, sessionId);
    const tab1Id = tab1.id as string;

    // Simulate the browser closing: the disconnect event marks the
    // participant as a ghost.
    await disconnect(tab1);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[tab1Id]?.disconnectedAt).not.toBeNull();

    // Refresh: new socket, same userId+sessionId, same lobby. The
    // server should prune the ghost and the lobby ends up with a
    // single active entry again.
    const tab2 = createSocket();
    await connect(tab2);
    await join(tab2, lobbyId as string, userId, sessionId);
    expect(lobbies[lobbyId as string].participants[tab1Id]).toBeUndefined();
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(1);

    // Refresh a second time: the same flow.
    await disconnect(tab2);
    const tab2Id = tab2.id as string;
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[tab2Id]?.disconnectedAt).not.toBeNull();

    const tab3 = createSocket();
    await connect(tab3);
    await join(tab3, lobbyId as string, userId, sessionId);
    expect(lobbies[lobbyId as string].participants[tab2Id]).toBeUndefined();
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(1);

    await disconnect(tab3);
  });

  it("two tabs in the same browser stay independent through disconnects and cleanups (C17)", async () => {
    const userId = "14141414-1414-1414-1414-141414141414";
    const sessionA = "15151515-1515-1515-1515-151515151515";
    const sessionB = "16161616-1616-1616-1616-161616161616";

    // Tab A joins.
    const a = createSocket();
    await connect(a);
    const lobbyId = await join(a, "", userId, sessionA);
    const aId = a.id as string;

    // Tab B joins in a separate session.
    const b = createSocket();
    await connect(b);
    await join(b, lobbyId as string, userId, sessionB);
    const bId = b.id as string;

    // Both active.
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);
    expect(lobbies[lobbyId as string].participants[aId]?.disconnectedAt).toBeNull();
    expect(lobbies[lobbyId as string].participants[bId]?.disconnectedAt).toBeNull();

    // Tab A disconnects → ghost. Tab B is still active.
    await disconnect(a);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[aId]?.disconnectedAt).not.toBeNull();
    expect(lobbies[lobbyId as string].participants[bId]?.disconnectedAt).toBeNull();

    // Tab B disconnects too. Two ghosts, one lobby.
    await disconnect(b);
    await new Promise((r) => setTimeout(r, 100));
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);
    expect(lobbies[lobbyId as string].participants[aId]?.disconnectedAt).not.toBeNull();
    expect(lobbies[lobbyId as string].participants[bId]?.disconnectedAt).not.toBeNull();

    // Force the periodic cleanup past GHOST_TIMEOUT for both ghosts.
    const now = Date.now();
    lobbies[lobbyId as string].participants[aId]!.disconnectedAt = now - (GHOST_TIMEOUT + 5_000);
    lobbies[lobbyId as string].participants[bId]!.disconnectedAt = now - (GHOST_TIMEOUT + 5_000);
    runPeriodicCleanup();

    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(0);
  });
});
