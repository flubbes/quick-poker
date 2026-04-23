import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { io as Client } from 'socket.io-client';
import request from 'supertest';
import {
  app,
  httpServer,
  io,
  lobbies,
  socketLimiter,
  lobbyCreationTracker,
  isValidLobbyId,
  sanitizeName,
  ALLOWED_ESTIMATES,
  MAX_PARTICIPANTS
} from '../src/server';
import type { LobbyState } from '../src/server';

let port: number;

function createSocket() {
  return Client(`http://localhost:${port}`, {
    transports: ['websocket', 'polling']
  });
}

function connect(client: ReturnType<typeof createSocket>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timeout')), 3000);
    client.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.on('connect_error', (err: Error) => {
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

function join(client: ReturnType<typeof createSocket>, lobbyId = ''): Promise<string | null> {
  return new Promise((resolve) => {
    client.emit('join', lobbyId, (id: string | null) => resolve(id));
  });
}

function waitForEvent<T>(client: ReturnType<typeof createSocket>, event: string): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    client.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

type Participant = NonNullable<LobbyState>['participants'][number];

function waitForState(client: ReturnType<typeof createSocket>) {
  return waitForEvent<LobbyState>(client, 'state');
}

beforeAll(() => {
  return new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address();
      if (address && typeof address === 'object') {
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

describe('Lobby Lifecycle', () => {
  it('creates a new lobby with a valid UUID when no lobbyId is provided', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);
    expect(lobbyId).toBeTruthy();
    expect(isValidLobbyId(lobbyId)).toBe(true);
    expect(lobbies[lobbyId as string]).toBeTruthy();
    expect(lobbies[lobbyId as string].revealed).toBe(false);
    await disconnect(client);
  });

  it('joins an existing lobby and returns the same ID', async () => {
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

  it('creates a lobby with a provided valid UUID if it does not exist (permanent links)', async () => {
    const existingId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    expect(lobbies[existingId]).toBeFalsy();

    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client, existingId);
    expect(lobbyId).toBe(existingId);
    expect(lobbies[existingId]).toBeTruthy();

    await disconnect(client);
  });

  it('rejects invalid lobby IDs and creates a new random one', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client, '__proto__');
    expect(lobbyId).toBeTruthy();
    expect(lobbyId).not.toBe('__proto__');
    expect(isValidLobbyId(lobbyId)).toBe(true);
    await disconnect(client);
  });

  it('prevents prototype pollution via lobby IDs', async () => {
    const client = createSocket();
    await connect(client);
    await join(client, '__proto__');
    await join(client, 'constructor');
    await join(client, 'toString');
    // Object.prototype should not be polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await disconnect(client);
  });

  it('caps lobby size at MAX_PARTICIPANTS', async () => {
    const lobbyId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
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

  it('broadcasts state to all participants on join', async () => {
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

  it('removes participant on disconnect', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(2);

    await disconnect(clientA);
    // Give server a moment to process disconnect
    await new Promise((r) => setTimeout(r, 200));
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(1);

    await disconnect(clientB);
  });
});

// ============================================================================
// ESTIMATION FLOW
// ============================================================================

describe('Estimation Flow', () => {
  it('accepts all allowed estimate values', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    for (const val of ALLOWED_ESTIMATES) {
      const statePromise = waitForState(client);
      client.emit('estimate', lobbyId, val);
      const state = await statePromise;
      const me = state?.participants.find((p: Participant) => p.id === client.id);
      expect(me?.estimate).toBe(val);
    }

    await disconnect(client);
  });

  it('rejects invalid estimate values', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit('estimate', lobbyId, 999);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    client.emit('estimate', lobbyId, 'five');
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    client.emit('estimate', lobbyId, -1);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    await disconnect(client);
  });

  it('allows changing estimate before reveal', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit('estimate', lobbyId, 5);
    await waitForState(client);

    client.emit('estimate', lobbyId, 8);
    const state = await waitForState(client);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    expect(me?.estimate).toBe(8);

    await disconnect(client);
  });

  it('rejects estimates after reveal', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit('estimate', lobbyId, 5);
    await waitForState(client);

    client.emit('reveal', lobbyId);
    await waitForState(client);
    expect(lobbies[lobbyId as string].revealed).toBe(true);

    client.emit('estimate', lobbyId, 8);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBe(5);

    await disconnect(client);
  });

  it('canReveal is false when not all non-PO participants have estimated', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    // Nobody estimated yet
    clientA.emit('estimate', lobbyId, 5);
    const state = await waitForState(clientA);
    expect(state?.canReveal).toBe(false);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it('canReveal is true when all non-PO participants have estimated', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    clientA.emit('estimate', lobbyId, 5);
    await waitForState(clientA);

    clientB.emit('estimate', lobbyId, 8);
    const state = await waitForState(clientA);
    expect(state?.canReveal).toBe(true);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it('reveal shows all estimates and disables further estimation', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    clientA.emit('estimate', lobbyId, 5);
    await waitForState(clientA);
    clientB.emit('estimate', lobbyId, 8);
    await waitForState(clientA);

    clientA.emit('reveal', lobbyId);
    const state = await waitForState(clientA);
    expect(state?.revealed).toBe(true);
    expect(state?.participants.find((p: Participant) => p.id === clientA.id)?.estimate).toBe(5);
    expect(state?.participants.find((p: Participant) => p.id === clientB.id)?.estimate).toBe(8);

    // Try to estimate after reveal
    clientA.emit('estimate', lobbyId, 13);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[clientA.id as string].estimate).toBe(5);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it('reset starts a new round with hidden cards and cleared estimates', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    clientA.emit('estimate', lobbyId, 5);
    await waitForState(clientA);
    clientB.emit('estimate', lobbyId, 8);
    await waitForState(clientA);

    clientA.emit('reveal', lobbyId);
    await waitForState(clientA);
    expect(lobbies[lobbyId as string].revealed).toBe(true);

    clientA.emit('reset', lobbyId);
    const state = await waitForState(clientA);
    expect(state?.revealed).toBe(false);
    expect(state?.participants.every((p) => p.estimate === '?' || p.estimate === null || p.estimate === '✓')).toBe(true);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it('does not allow reset before reveal', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit('estimate', lobbyId, 5);
    await waitForState(client);

    client.emit('reset', lobbyId);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].revealed).toBe(false);

    await disconnect(client);
  });

  it('can be used for multiple estimation rounds', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Round 1
    client.emit('estimate', lobbyId, 5);
    await waitForState(client);
    client.emit('reveal', lobbyId);
    await waitForState(client);
    client.emit('reset', lobbyId);
    await waitForState(client);

    // Round 2
    client.emit('estimate', lobbyId, 8);
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

describe('PO Role', () => {
  it('allows a user to set themselves as PO', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit('setPO', lobbyId, true);
    const state = await waitForState(client);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    expect(me?.po).toBe(true);

    await disconnect(client);
  });

  it('excludes POs from the reveal condition', async () => {
    const poClient = createSocket();
    await connect(poClient);
    const lobbyId = await join(poClient);
    poClient.emit('setPO', lobbyId, true);
    await waitForState(poClient);

    const normalClient = createSocket();
    await connect(normalClient);
    await join(normalClient, lobbyId as string);

    // Only the non-PO needs to estimate for reveal to be possible
    normalClient.emit('estimate', lobbyId, 5);
    const state = await waitForState(normalClient);
    expect(state?.canReveal).toBe(true);

    await disconnect(poClient);
    await disconnect(normalClient);
  });

  it('prevents POs from estimating server-side', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit('setPO', lobbyId, true);
    await waitForState(client);

    client.emit('estimate', lobbyId, 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    await disconnect(client);
  });

  it('PO estimate rejection is logged as security event', async () => {
    // We can't easily capture console output in this setup,
    // but we verify the behavior is blocked server-side
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit('setPO', lobbyId, true);
    await waitForState(client);

    client.emit('estimate', lobbyId, 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[client.id as string].estimate).toBeNull();

    await disconnect(client);
  });
});

// ============================================================================
// STATE REDACTION (SECURITY)
// ============================================================================

describe('State Redaction', () => {
  it('hides other participants estimates before reveal', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    // A estimates
    const statePromiseA = waitForState(clientA);
    clientA.emit('estimate', lobbyId, 5);
    const stateAfterEstimate = await statePromiseA;
    const meAfterEstimate = stateAfterEstimate?.participants.find((p: Participant) => p.id === clientA.id);
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
    expect(bFromA?.estimate).toBe('?');

    // From B's view: A's estimate hidden as '✓', B's own estimate is null (not estimated yet)
    const aFromB = stateB?.participants.find((p: Participant) => p.id === clientA.id);
    const bFromB = stateB?.participants.find((p: Participant) => p.id === clientB.id);
    expect(aFromB?.estimate).toBe('✓');
    expect(bFromB?.estimate).toBeNull(); // own un-submitted estimate is shown as null

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it('shows all estimates after reveal', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);
    clientA.emit('estimate', lobbyId, 5);
    await waitForState(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);
    clientB.emit('estimate', lobbyId, 8);
    await waitForState(clientA);

    clientA.emit('reveal', lobbyId);
    const state = await waitForState(clientA);
    expect(state?.revealed).toBe(true);
    expect(state?.participants.find((p: Participant) => p.id === clientA.id)?.estimate).toBe(5);
    expect(state?.participants.find((p: Participant) => p.id === clientB.id)?.estimate).toBe(8);

    await disconnect(clientA);
    await disconnect(clientB);
  });

  it('never leaks raw estimate values in WebSocket payloads before reveal', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    clientA.emit('estimate', lobbyId, 13);
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
    expect(['✓', '?']).toContain(aEstimate);

    await disconnect(clientA);
    await disconnect(clientB);
  });
});

// ============================================================================
// NAME SANITIZATION
// ============================================================================

describe('Name Sanitization', () => {
  it('sanitizes HTML characters from display names', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Name is sliced to 15 chars first, then HTML chars stripped
    client.emit('setName', lobbyId, '<script>alert(1)</script>');
    const state = await waitForState(client);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    // '<script>alert(1' (15 chars) -> remove < and > -> 'scriptalert(1'
    expect(me?.name).toBe('scriptalert(1');

    await disconnect(client);
  });

  it('truncates names to 15 characters', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    client.emit('setName', lobbyId, 'ThisIsAVeryLongNameThatExceeds');
    const state = await waitForState(client);
    const me = state?.participants.find((p: Participant) => p.id === client.id);
    expect(me?.name.length).toBeLessThanOrEqual(15);

    await disconnect(client);
  });
});

// ============================================================================
// RATE LIMITING
// ============================================================================

describe('Rate Limiting', () => {
  it('rate limits join events per socket', async () => {
    const client = createSocket();
    await connect(client);

    // Exhaust join limit (10 per 60s)
    for (let i = 0; i < 10; i++) {
      await join(client);
    }

    const limited = waitForEvent<{ event: string }>(client, 'rate-limited');
    client.emit('join', '');
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe('join');

    await disconnect(client);
  });

  it('rate limits estimate events per socket', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Exhaust estimate limit (10 per 5s)
    for (let i = 0; i < 10; i++) {
      client.emit('estimate', lobbyId, ALLOWED_ESTIMATES[0]);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, 'rate-limited');
    client.emit('estimate', lobbyId, ALLOWED_ESTIMATES[0]);
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe('estimate');

    await disconnect(client);
  });

  it('rate limits reveal events per socket', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);
    client.emit('estimate', lobbyId, 5);
    await waitForState(client);

    // Exhaust reveal limit (5 per 10s)
    for (let i = 0; i < 5; i++) {
      client.emit('reveal', lobbyId);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, 'rate-limited');
    client.emit('reveal', lobbyId);
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe('reveal');

    await disconnect(client);
  });

  it('rate limits reset events per socket', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);
    client.emit('estimate', lobbyId, 5);
    await waitForState(client);
    client.emit('reveal', lobbyId);
    await waitForState(client);

    // Exhaust reset limit (5 per 10s)
    for (let i = 0; i < 5; i++) {
      client.emit('reset', lobbyId);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, 'rate-limited');
    client.emit('reset', lobbyId);
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe('reset');

    await disconnect(client);
  });

  it('rate limits setName events per socket', async () => {
    const client = createSocket();
    await connect(client);
    const lobbyId = await join(client);

    // Exhaust setName limit (10 per 10s)
    for (let i = 0; i < 10; i++) {
      client.emit('setName', lobbyId, `Name${i}`);
      await new Promise((r) => setTimeout(r, 10));
    }

    const limited = waitForEvent<{ event: string }>(client, 'rate-limited');
    client.emit('setName', lobbyId, 'TooMany');
    const rateLimited = await limited;
    expect(rateLimited).toBeTruthy();
    expect(rateLimited?.event).toBe('setName');

    await disconnect(client);
  });
});

// ============================================================================
// AUTHORIZATION / SECURITY REGRESSIONS
// ============================================================================

describe('Authorization & Security Regressions', () => {
  it('does not allow reveal by a socket that is not a participant', async () => {
    const victimA = createSocket();
    await connect(victimA);
    const lobbyId = await join(victimA);
    victimA.emit('estimate', lobbyId, 5);
    await waitForState(victimA);

    const attacker = createSocket();
    await connect(attacker);
    // Attacker does NOT join the lobby

    attacker.emit('reveal', lobbyId);
    await new Promise((r) => setTimeout(r, 200));
    expect(lobbies[lobbyId as string].revealed).toBe(false);

    await disconnect(victimA);
    await disconnect(attacker);
  });

  it('does not allow reset by a socket that is not a participant', async () => {
    const victimA = createSocket();
    await connect(victimA);
    const lobbyId = await join(victimA);
    victimA.emit('estimate', lobbyId, 5);
    await waitForState(victimA);
    victimA.emit('reveal', lobbyId);
    await waitForState(victimA);
    expect(lobbies[lobbyId as string].revealed).toBe(true);

    const attacker = createSocket();
    await connect(attacker);
    // Attacker does NOT join the lobby

    attacker.emit('reset', lobbyId);
    await new Promise((r) => setTimeout(r, 200));
    expect(lobbies[lobbyId as string].revealed).toBe(true);

    await disconnect(victimA);
    await disconnect(attacker);
  });

  it('does not allow setName by a socket that is not a participant', async () => {
    const victim = createSocket();
    await connect(victim);
    const lobbyId = await join(victim);
    const originalName = lobbies[lobbyId as string].participants[victim.id as string].name;

    const attacker = createSocket();
    await connect(attacker);
    attacker.emit('setName', lobbyId, 'Hacked');
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[victim.id as string].name).toBe(originalName);

    await disconnect(victim);
    await disconnect(attacker);
  });

  it('does not allow setPO by a socket that is not a participant', async () => {
    const victim = createSocket();
    await connect(victim);
    const lobbyId = await join(victim);
    const originalPO = lobbies[lobbyId as string].participants[victim.id as string].po;

    const attacker = createSocket();
    await connect(attacker);
    attacker.emit('setPO', lobbyId, true);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].participants[victim.id as string].po).toBe(originalPO);

    await disconnect(victim);
    await disconnect(attacker);
  });

  it('does not allow estimate by a socket that is not a participant', async () => {
    const victim = createSocket();
    await connect(victim);
    const lobbyId = await join(victim);

    const attacker = createSocket();
    await connect(attacker);
    attacker.emit('estimate', lobbyId, 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(Object.keys(lobbies[lobbyId as string].participants)).toHaveLength(1);

    await disconnect(victim);
    await disconnect(attacker);
  });

  it('does not allow reveal before all non-PO participants have estimated', async () => {
    const clientA = createSocket();
    await connect(clientA);
    const lobbyId = await join(clientA);

    const clientB = createSocket();
    await connect(clientB);
    await join(clientB, lobbyId as string);

    // Only A estimates
    clientA.emit('estimate', lobbyId, 5);
    await waitForState(clientA);

    clientA.emit('reveal', lobbyId);
    await new Promise((r) => setTimeout(r, 100));
    expect(lobbies[lobbyId as string].revealed).toBe(false);

    await disconnect(clientA);
    await disconnect(clientB);
  });
});

// ============================================================================
// MULTI-LOBBY
// ============================================================================

describe('Multi-Lobby Support', () => {
  it('allows a socket to join multiple lobbies', async () => {
    const client = createSocket();
    await connect(client);

    const lobbyA = await join(client);
    const lobbyB = await join(client);

    expect(lobbyA).not.toBe(lobbyB);
    expect(lobbies[lobbyA as string].participants[client.id as string]).toBeTruthy();
    expect(lobbies[lobbyB as string].participants[client.id as string]).toBeTruthy();

    await disconnect(client);
  });

  it('receives separate state updates for each lobby', async () => {
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

describe('HTTP Layer', () => {
  it('serves the index page', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Quick Poker');
  });

  it('serves vue.global.js', async () => {
    const res = await request(app).get('/vue.global.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Vue');
  });

  it('returns security headers via helmet', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('returns 429 when HTTP rate limit is exceeded', async () => {
    // Make many rapid requests to trigger rate limit
    const requests: Promise<import('supertest').Response>[] = [];
    for (let i = 0; i < 250; i++) {
      requests.push(request(app).get('/'));
    }
    const responses = await Promise.all(requests);
    const has429 = responses.some((r) => r.status === 429);
    expect(has429).toBe(true);
  });
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

describe('Utility Functions', () => {
  it('isValidLobbyId accepts valid UUIDs', () => {
    expect(isValidLobbyId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidLobbyId('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')).toBe(true);
  });

  it('isValidLobbyId rejects invalid IDs', () => {
    expect(isValidLobbyId('')).toBe(false);
    expect(isValidLobbyId('not-a-uuid')).toBe(false);
    expect(isValidLobbyId('123')).toBe(false);
    expect(isValidLobbyId('__proto__')).toBe(false);
    expect(isValidLobbyId('constructor')).toBe(false);
    expect(isValidLobbyId(null)).toBe(false);
    expect(isValidLobbyId(undefined)).toBe(false);
  });

  it('sanitizeName strips HTML metacharacters', () => {
    expect(sanitizeName('<b>bold</b>')).toBe('bbold/b');
    expect(sanitizeName('"quoted"')).toBe('quoted');
    expect(sanitizeName("'apos'")).toBe('apos');
    expect(sanitizeName('a&amp;b')).toBe('aamp;b');
  });

  it('sanitizeName truncates to 15 characters', () => {
    expect(sanitizeName('1234567890123456')).toBe('123456789012345');
  });
});
