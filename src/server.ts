import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { randomUUID } from "crypto";
import path from "path";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

const app = express();

if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer);

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
);

// HTTP rate limiting (returns 429 with Retry-After)
const httpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response, _next: NextFunction, options: { windowMs: number }) => {
    res.setHeader("Retry-After", Math.ceil(options.windowMs / 1000));
    res.status(429).json({ error: "Too many requests, please try again later." });
  },
});
app.use(httpLimiter);

app.use(express.static("public"));
app.get("/vue.global.js", (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), "node_modules", "vue", "dist", "vue.global.js"));
});

// Types
interface Participant {
  id: string;
  userId: string | null;
  sessionId: string | null;
  name: string;
  estimate: number | null;
  po: boolean;
  disconnectedAt: number | null;
}

interface Lobby {
  id: string;
  participants: Record<string, Participant>;
  revealed: boolean;
  createdAt: number;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface SecurityLogMeta {
  [key: string]: unknown;
}

interface LobbyCreationEntry {
  count: number;
  resetTime: number;
}

interface SocketRateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

interface ClientParticipant {
  id: string;
  name: string;
  estimate: number | string | null;
  po: boolean;
  connected: boolean;
}

interface LobbyState {
  lobbyId: string;
  id: string;
  revealed: boolean;
  participants: ClientParticipant[];
  canReveal: boolean;
}

const lobbies: Record<string, Lobby> = Object.create(null);
const ALLOWED_ESTIMATES: readonly number[] = [0, 1, 2, 3, 5, 8, 13, 20, 40];
const MAX_PARTICIPANTS = 50;
const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_TIMEOUT = 7_000;
const GHOST_TIMEOUT = 60_000;

function isValidLobbyId(id: unknown): boolean {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  );
}

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUserId(id: unknown): boolean {
  return typeof id === "string" && id.length <= 64 && USER_ID_PATTERN.test(id);
}

function getClientIp(socket: Socket): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = socket.handshake.headers["x-forwarded-for"];
    if (forwarded) {
      const ips = String(forwarded)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return ips[ips.length - 1] || socket.handshake.address;
    }
  }
  return socket.handshake.address;
}

// Lobby creation rate limiting
const lobbyCreationTracker = new Map<string, LobbyCreationEntry>();

function canCreateLobby(ip: string): boolean {
  const now = Date.now();
  const entry = lobbyCreationTracker.get(ip);
  if (!entry || now > entry.resetTime) {
    lobbyCreationTracker.set(ip, { count: 1, resetTime: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

function sanitizeName(name: unknown): string {
  return String(name)
    .slice(0, 15)
    .replace(/[<>'"&]/g, "");
}

// Security logging
function logSecurity(level: string, message: string, meta: SecurityLogMeta = {}): void {
  const timestamp = new Date().toISOString();
  const logLine = JSON.stringify({ timestamp, level, message, ...meta });
  console.log(logLine);
}

// Socket event rate limiting
class SocketRateLimiter {
  private limits = new Map<string, Map<string, RateLimitEntry>>();

  isAllowed(socketId: string, event: string, limit = 10, windowMs = 10_000): SocketRateLimitResult {
    let events = this.limits.get(socketId);
    if (!events) {
      events = new Map<string, RateLimitEntry>();
      this.limits.set(socketId, events);
    }
    const now = Date.now();
    const entry = events.get(event);
    if (!entry || now > entry.resetTime) {
      events.set(event, { count: 1, resetTime: now + windowMs });
      return { allowed: true };
    }
    if (entry.count >= limit) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
    }
    entry.count++;
    return { allowed: true };
  }

  removeSocket(socketId: string): void {
    this.limits.delete(socketId);
  }

  clear(): void {
    this.limits.clear();
  }
}

const socketLimiter = new SocketRateLimiter();

// Track which lobbies each socket belongs to
const socketLobbies = new Map<string, Set<string>>();
const lastHeartbeats = new Map<string, number>();

function getSocketLobbies(socketId: string): Set<string> {
  return socketLobbies.get(socketId) || new Set<string>();
}

function markParticipantGhosts(socket: Socket): string[] {
  const socketId = socket.id;
  const lobbiesToUpdate: string[] = [];
  const lobbiesToClean = Array.from(getSocketLobbies(socketId));
  socketLobbies.delete(socketId);
  for (const lobbyId of lobbiesToClean) {
    const lobby = lobbies[lobbyId];
    if (!lobby) continue;
    const participant = lobby.participants[socketId];
    if (participant && participant.disconnectedAt === null) {
      participant.disconnectedAt = Date.now();
      lobbiesToUpdate.push(lobbyId);
    }
    socket.leave(lobbyId);
  }
  return lobbiesToUpdate;
}

function cleanupSocket(socket: Socket): void {
  const socketId = socket.id;
  socketLimiter.removeSocket(socketId);
  lastHeartbeats.delete(socketId);

  const lobbiesToUpdate = markParticipantGhosts(socket);

  for (const lobbyId of lobbiesToUpdate) {
    broadcast(lobbyId);
  }
}

// Heartbeat monitoring: prune dead connections every 5 seconds
function runHeartbeatCleanup(now = Date.now()): void {
  for (const [socketId, lastBeat] of lastHeartbeats) {
    if (now - lastBeat > HEARTBEAT_TIMEOUT) {
      const socket = io.sockets.sockets.get(socketId);
      logSecurity("warn", "Heartbeat timeout", { socketId, lastBeat, elapsed: now - lastBeat });
      if (socket) {
        cleanupSocket(socket);
        socket.disconnect(true);
      } else {
        socketLimiter.removeSocket(socketId);
        lastHeartbeats.delete(socketId);
        for (const lobbyId of Object.keys(lobbies)) {
          const lobby = lobbies[lobbyId];
          const participant = lobby?.participants[socketId];
          if (participant && participant.disconnectedAt === null) {
            participant.disconnectedAt = now;
            broadcast(lobbyId);
          }
        }
      }
    }
  }
}

setInterval(runHeartbeatCleanup, HEARTBEAT_INTERVAL);

// Periodic cleanup of empty lobbies, ghost participants, and stale rate-limit entries
function runPeriodicCleanup(now = Date.now()): void {
  Object.keys(lobbies).forEach((id) => {
    const lobby = lobbies[id];
    let changed = false;
    for (const socketId of Object.keys(lobby.participants)) {
      const participant = lobby.participants[socketId];
      if (participant.disconnectedAt !== null && now - participant.disconnectedAt > GHOST_TIMEOUT) {
        delete lobby.participants[socketId];
        changed = true;
      }
    }
    if (changed) broadcast(id);
    if (Object.keys(lobby.participants).length === 0 && now - lobby.createdAt > 300_000) {
      logSecurity("info", "Empty lobby cleaned up", { lobbyId: id });
      delete lobbies[id];
    }
  });
  for (const [ip, entry] of lobbyCreationTracker) {
    if (now > entry.resetTime) {
      lobbyCreationTracker.delete(ip);
    }
  }
}

setInterval(runPeriodicCleanup, 60_000);

function getLobbyState(lobbyId: string, viewerSocketId: string | null = null): LobbyState | null {
  const lobby = lobbies[lobbyId];
  if (!lobby) return null;
  const rawParticipants = Object.values(lobby.participants);
  const nonPO = rawParticipants.filter((p) => !p.po);
  const activeNonPO = nonPO.filter((p) => p.disconnectedAt === null);
  const canReveal =
    !lobby.revealed && activeNonPO.length > 0 && activeNonPO.every((p) => p.estimate !== null);
  const participants: ClientParticipant[] = rawParticipants.map((p) => ({
    id: p.id,
    name: p.name,
    po: p.po,
    connected: p.disconnectedAt === null,
    estimate:
      lobby.revealed || p.id === viewerSocketId ? p.estimate : p.estimate !== null ? "✓" : "?",
  }));
  return { lobbyId: lobby.id, id: lobby.id, revealed: lobby.revealed, participants, canReveal };
}

function broadcast(lobbyId: string): void {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const room = io.sockets.adapter.rooms.get(lobbyId);
  if (!room) return;
  for (const socketId of room) {
    const state = getLobbyState(lobbyId, socketId);
    const socket = io.sockets.sockets.get(socketId);
    if (socket && state) socket.emit("state", state);
  }
}

io.on("connection", (socket: Socket) => {
  lastHeartbeats.set(socket.id, Date.now());

  socket.on("join", (lobbyId: unknown, userId: unknown, sessionId: unknown, cb: unknown) => {
    const replyArg =
      typeof cb === "function"
        ? cb
        : typeof sessionId === "function"
          ? sessionId
          : typeof userId === "function"
            ? userId
            : null;
    const reply =
      typeof replyArg === "function" ? (replyArg as (id: string | null) => void) : (): void => {};

    const check = socketLimiter.isAllowed(socket.id, "join", 10, 60_000);
    if (!check.allowed) {
      socket.emit("rate-limited", { event: "join", retryAfter: check.retryAfter });
      logSecurity("warn", "Rate limit exceeded", {
        socketId: socket.id,
        event: "join",
        retryAfter: check.retryAfter,
      });
      return reply(null);
    }

    const resolvedUserId = isValidUserId(userId) ? (userId as string) : null;
    const resolvedSessionId = isValidUserId(sessionId) ? (sessionId as string) : null;

    let resolvedLobbyId = lobbyId as string;

    if (!resolvedLobbyId || !isValidLobbyId(resolvedLobbyId)) {
      const clientIp = getClientIp(socket);
      if (!canCreateLobby(clientIp)) {
        logSecurity("warn", "Lobby creation rate limit exceeded", {
          socketId: socket.id,
          ip: clientIp,
        });
        return reply(null);
      }
      resolvedLobbyId = randomUUID();
      lobbies[resolvedLobbyId] = {
        id: resolvedLobbyId,
        participants: Object.create(null),
        revealed: false,
        createdAt: Date.now(),
      };
      logSecurity("info", "Lobby created", {
        lobbyId: resolvedLobbyId,
        creatorSocketId: socket.id,
        ip: clientIp,
      });
    } else if (!lobbies[resolvedLobbyId]) {
      const clientIp = getClientIp(socket);
      if (!canCreateLobby(clientIp)) {
        logSecurity("warn", "Lobby creation rate limit exceeded", {
          socketId: socket.id,
          ip: clientIp,
          lobbyId: resolvedLobbyId,
        });
        return reply(null);
      }
      lobbies[resolvedLobbyId] = {
        id: resolvedLobbyId,
        participants: Object.create(null),
        revealed: false,
        createdAt: Date.now(),
      };
      logSecurity("info", "Lobby created from link", {
        lobbyId: resolvedLobbyId,
        creatorSocketId: socket.id,
        ip: clientIp,
      });
    }

    if (Object.keys(lobbies[resolvedLobbyId].participants).length >= MAX_PARTICIPANTS) {
      logSecurity("warn", "Lobby full", { lobbyId: resolvedLobbyId, socketId: socket.id });
      return reply(null);
    }

    socket.join(resolvedLobbyId);
    let set = socketLobbies.get(socket.id);
    if (!set) {
      set = new Set<string>();
      socketLobbies.set(socket.id, set);
    }
    set.add(resolvedLobbyId);

    if (resolvedUserId) {
      for (const participantSocketId of Object.keys(lobbies[resolvedLobbyId].participants)) {
        const existing = lobbies[resolvedLobbyId].participants[participantSocketId];
        const sameRejoiningSession =
          resolvedSessionId !== null &&
          existing.userId === resolvedUserId &&
          existing.sessionId === resolvedSessionId;
        const sameUserGhost =
          existing.userId === resolvedUserId && existing.disconnectedAt !== null;
        if (sameRejoiningSession || sameUserGhost) {
          delete lobbies[resolvedLobbyId].participants[participantSocketId];
        }
      }
    }

    lobbies[resolvedLobbyId].participants[socket.id] = {
      id: socket.id,
      userId: resolvedUserId,
      sessionId: resolvedSessionId,
      name: "Anonymous",
      estimate: null,
      po: false,
      disconnectedAt: null,
    };
    broadcast(resolvedLobbyId);
    reply(resolvedLobbyId);
  });

  socket.on("heartbeat", () => {
    const check = socketLimiter.isAllowed(socket.id, "heartbeat", 60, 60_000);
    if (!check.allowed) return;
    lastHeartbeats.set(socket.id, Date.now());
  });

  socket.on("setName", (lobbyId: unknown, name: unknown) => {
    const check = socketLimiter.isAllowed(socket.id, "setName", 10, 10_000);
    if (!check.allowed) {
      socket.emit("rate-limited", { event: "setName", retryAfter: check.retryAfter });
      return;
    }
    const id = lobbyId as string;
    if (!id || !lobbies[id] || !lobbies[id].participants[socket.id]) return;
    lobbies[id].participants[socket.id].name = sanitizeName(name);
    broadcast(id);
  });

  socket.on("setPO", (lobbyId: unknown, po: unknown) => {
    const check = socketLimiter.isAllowed(socket.id, "setPO", 10, 10_000);
    if (!check.allowed) {
      socket.emit("rate-limited", { event: "setPO", retryAfter: check.retryAfter });
      return;
    }
    const id = lobbyId as string;
    if (!id || !lobbies[id] || !lobbies[id].participants[socket.id]) return;
    lobbies[id].participants[socket.id].po = !!po;
    broadcast(id);
  });

  socket.on("estimate", (lobbyId: unknown, value: unknown) => {
    const check = socketLimiter.isAllowed(socket.id, "estimate", 10, 5_000);
    if (!check.allowed) {
      socket.emit("rate-limited", { event: "estimate", retryAfter: check.retryAfter });
      return;
    }
    const id = lobbyId as string;
    if (!id || !lobbies[id]) return;
    if (lobbies[id].revealed) return;
    if (typeof value !== "number" || !ALLOWED_ESTIMATES.includes(value)) {
      logSecurity("warn", "Invalid estimate rejected", { socketId: socket.id, lobbyId: id, value });
      return;
    }
    const participant = lobbies[id].participants[socket.id];
    if (!participant) return;
    if (participant.po) {
      logSecurity("warn", "PO estimate rejected", { socketId: socket.id, lobbyId: id });
      return;
    }
    participant.estimate = value;
    broadcast(id);
  });

  socket.on("reveal", (lobbyId: unknown) => {
    const check = socketLimiter.isAllowed(socket.id, "reveal", 5, 10_000);
    if (!check.allowed) {
      socket.emit("rate-limited", { event: "reveal", retryAfter: check.retryAfter });
      return;
    }
    const id = lobbyId as string;
    if (!id || !lobbies[id] || !lobbies[id].participants[socket.id]) return;
    const lobby = lobbies[id];
    if (lobby.revealed) return;
    const activeNonPO = Object.values(lobby.participants).filter(
      (p) => !p.po && p.disconnectedAt === null,
    );
    if (activeNonPO.length === 0 || !activeNonPO.every((p) => p.estimate !== null)) return;
    lobby.revealed = true;
    logSecurity("info", "Lobby revealed", { lobbyId: id, socketId: socket.id });
    broadcast(id);
  });

  socket.on("reset", (lobbyId: unknown) => {
    const check = socketLimiter.isAllowed(socket.id, "reset", 5, 10_000);
    if (!check.allowed) {
      socket.emit("rate-limited", { event: "reset", retryAfter: check.retryAfter });
      return;
    }
    const id = lobbyId as string;
    if (!id || !lobbies[id] || !lobbies[id].participants[socket.id]) return;
    const lobby = lobbies[id];
    if (!lobby.revealed) return;
    lobby.revealed = false;
    Object.values(lobby.participants).forEach((p) => {
      p.estimate = null;
    });
    logSecurity("info", "Lobby reset", { lobbyId: id, socketId: socket.id });
    broadcast(id);
  });

  socket.on("disconnect", () => {
    logSecurity("info", "Socket disconnected", { socketId: socket.id });
    cleanupSocket(socket);
  });
});

const PORT = process.env.PORT || 3000;

export {
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
  canCreateLobby,
  runHeartbeatCleanup,
  runPeriodicCleanup,
  getLobbyState,
  lastHeartbeats,
  socketLobbies,
  ALLOWED_ESTIMATES,
  MAX_PARTICIPANTS,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT,
  GHOST_TIMEOUT,
  type LobbyState,
};

if (process.env.AUTO_START !== "false") {
  httpServer.listen(PORT, () => console.log(`Quick Poker running on port ${PORT}`));
}
