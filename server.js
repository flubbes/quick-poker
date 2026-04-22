const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: false // same-origin only
});

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// HTTP rate limiting (returns 429 with Retry-After)
const httpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  }
});
app.use(httpLimiter);

app.use(express.static('public'));
app.get('/vue.global.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'vue', 'dist', 'vue.global.js'));
});

const lobbies = Object.create(null);
const ALLOWED_ESTIMATES = [0, 1, 2, 3, 5, 8, 13, 20, 40];
const MAX_PARTICIPANTS = 50;
const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_TIMEOUT = 30000;

function isValidLobbyId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function getClientIp(socket) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean);
      return ips[ips.length - 1] || socket.handshake.address;
    }
  }
  return socket.handshake.address;
}

// Lobby creation rate limiting
const lobbyCreationTracker = new Map();

function canCreateLobby(ip) {
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

function sanitizeName(name) {
  return String(name).slice(0, 15).replace(/[<>'"&]/g, '');
}

// Security logging
function logSecurity(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const logLine = JSON.stringify({ timestamp, level, message, ...meta });
  console.log(logLine);
}

// Socket event rate limiting
class SocketRateLimiter {
  constructor() {
    this.limits = new Map(); // socket.id -> Map(event -> { count, resetTime })
  }

  isAllowed(socketId, event, limit = 10, windowMs = 10_000) {
    let events = this.limits.get(socketId);
    if (!events) {
      events = new Map();
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

  removeSocket(socketId) {
    this.limits.delete(socketId);
  }

  clear() {
    this.limits.clear();
  }
}

const socketLimiter = new SocketRateLimiter();

// Track which lobbies each socket belongs to
const socketLobbies = new Map();  // socket.id -> Set of lobbyIds
const lastHeartbeats = new Map(); // socket.id -> timestamp

function getSocketLobbies(socketId) {
  return socketLobbies.get(socketId) || new Set();
}

function cleanupSocket(socket) {
  const socketId = socket.id;
  socketLimiter.removeSocket(socketId);
  lastHeartbeats.delete(socketId);

  const lobbiesToClean = Array.from(getSocketLobbies(socketId));
  socketLobbies.delete(socketId);

  for (const lobbyId of lobbiesToClean) {
    const lobby = lobbies[lobbyId];
    if (lobby) {
      delete lobby.participants[socketId];
    }
    socket.leave(lobbyId);
  }

  // Broadcast after leaving rooms so stale sockets don't receive updates
  for (const lobbyId of lobbiesToClean) {
    broadcast(lobbyId);
  }
}

// Heartbeat monitoring: prune dead connections every 5 seconds
setInterval(() => {
  const now = Date.now();
  for (const [socketId, lastBeat] of lastHeartbeats) {
    if (now - lastBeat > HEARTBEAT_TIMEOUT) {
      const socket = io.sockets.sockets.get(socketId);
      logSecurity('warn', 'Heartbeat timeout', { socketId, lastBeat, elapsed: now - lastBeat });
      if (socket) {
        cleanupSocket(socket);
        socket.disconnect(true);
      } else {
        // Socket already gone from adapter; clean up our maps only
        socketLimiter.removeSocket(socketId);
        lastHeartbeats.delete(socketId);
        const lobbiesToClean = Array.from(getSocketLobbies(socketId));
        socketLobbies.delete(socketId);
        for (const lobbyId of lobbiesToClean) {
          const lobby = lobbies[lobbyId];
          if (lobby) {
            delete lobby.participants[socketId];
            broadcast(lobbyId);
          }
        }
      }
    }
  }
}, HEARTBEAT_INTERVAL);

// Periodic cleanup of empty lobbies and stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  Object.keys(lobbies).forEach(id => {
    if (Object.keys(lobbies[id].participants).length === 0 && (now - lobbies[id].createdAt > 300_000)) {
      logSecurity('info', 'Empty lobby cleaned up', { lobbyId: id });
      delete lobbies[id];
    }
  });
  for (const [ip, entry] of lobbyCreationTracker) {
    if (now > entry.resetTime) {
      lobbyCreationTracker.delete(ip);
    }
  }
}, 60_000);

function getLobbyState(lobbyId, viewerSocketId = null) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return null;
  const rawParticipants = Object.values(lobby.participants);
  const nonPO = rawParticipants.filter(p => !p.po);
  const canReveal = !lobby.revealed && nonPO.length > 0 && nonPO.every(p => p.estimate !== null);
  const participants = rawParticipants.map(p => ({
    ...p,
    estimate: lobby.revealed || p.id === viewerSocketId ? p.estimate : (p.estimate !== null ? '✓' : '?')
  }));
  return { lobbyId: lobby.id, id: lobby.id, revealed: lobby.revealed, participants, canReveal };
}

function broadcast(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const room = io.sockets.adapter.rooms.get(lobbyId);
  if (!room) return;
  for (const socketId of room) {
    const state = getLobbyState(lobbyId, socketId);
    const socket = io.sockets.sockets.get(socketId);
    if (socket && state) socket.emit('state', state);
  }
}

io.on('connection', (socket) => {
  lastHeartbeats.set(socket.id, Date.now());

  socket.on('join', (lobbyId, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};

    const check = socketLimiter.isAllowed(socket.id, 'join', 10, 60_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'join', retryAfter: check.retryAfter });
      logSecurity('warn', 'Rate limit exceeded', { socketId: socket.id, event: 'join', retryAfter: check.retryAfter });
      return reply(null);
    }

    if (!lobbyId || !isValidLobbyId(lobbyId)) {
      const clientIp = getClientIp(socket);
      if (!canCreateLobby(clientIp)) {
        logSecurity('warn', 'Lobby creation rate limit exceeded', { socketId: socket.id, ip: clientIp });
        return reply(null);
      }
      lobbyId = randomUUID();
      lobbies[lobbyId] = { id: lobbyId, participants: Object.create(null), revealed: false, createdAt: Date.now() };
      logSecurity('info', 'Lobby created', { lobbyId, creatorSocketId: socket.id, ip: clientIp });
    } else if (!lobbies[lobbyId]) {
      const clientIp = getClientIp(socket);
      if (!canCreateLobby(clientIp)) {
        logSecurity('warn', 'Lobby creation rate limit exceeded', { socketId: socket.id, ip: clientIp, lobbyId });
        return reply(null);
      }
      lobbies[lobbyId] = { id: lobbyId, participants: Object.create(null), revealed: false, createdAt: Date.now() };
      logSecurity('info', 'Lobby created from link', { lobbyId, creatorSocketId: socket.id, ip: clientIp });
    }

    if (Object.keys(lobbies[lobbyId].participants).length >= MAX_PARTICIPANTS) {
      logSecurity('warn', 'Lobby full', { lobbyId, socketId: socket.id });
      return reply(null);
    }

    socket.join(lobbyId);
    let set = socketLobbies.get(socket.id);
    if (!set) {
      set = new Set();
      socketLobbies.set(socket.id, set);
    }
    set.add(lobbyId);

    lobbies[lobbyId].participants[socket.id] = {
      id: socket.id,
      name: 'Anonymous',
      estimate: null,
      po: false
    };
    broadcast(lobbyId);
    reply(lobbyId);
  });

  socket.on('heartbeat', () => {
    lastHeartbeats.set(socket.id, Date.now());
  });

  socket.on('setName', (lobbyId, name) => {
    const check = socketLimiter.isAllowed(socket.id, 'setName', 10, 10_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'setName', retryAfter: check.retryAfter });
      return;
    }
    if (!lobbyId || !lobbies[lobbyId] || !lobbies[lobbyId].participants[socket.id]) return;
    lobbies[lobbyId].participants[socket.id].name = sanitizeName(name);
    broadcast(lobbyId);
  });

  socket.on('setPO', (lobbyId, po) => {
    const check = socketLimiter.isAllowed(socket.id, 'setPO', 10, 10_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'setPO', retryAfter: check.retryAfter });
      return;
    }
    if (!lobbyId || !lobbies[lobbyId] || !lobbies[lobbyId].participants[socket.id]) return;
    lobbies[lobbyId].participants[socket.id].po = !!po;
    broadcast(lobbyId);
  });

  socket.on('estimate', (lobbyId, value) => {
    const check = socketLimiter.isAllowed(socket.id, 'estimate', 10, 5_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'estimate', retryAfter: check.retryAfter });
      return;
    }
    if (!lobbyId || !lobbies[lobbyId]) return;
    if (lobbies[lobbyId].revealed) return;
    if (!ALLOWED_ESTIMATES.includes(value)) {
      logSecurity('warn', 'Invalid estimate rejected', { socketId: socket.id, lobbyId, value });
      return;
    }
    const participant = lobbies[lobbyId].participants[socket.id];
    if (!participant) return;
    if (participant.po) {
      logSecurity('warn', 'PO estimate rejected', { socketId: socket.id, lobbyId });
      return;
    }
    participant.estimate = value;
    broadcast(lobbyId);
  });

  socket.on('reveal', (lobbyId) => {
    const check = socketLimiter.isAllowed(socket.id, 'reveal', 5, 10_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'reveal', retryAfter: check.retryAfter });
      return;
    }
    if (!lobbyId || !lobbies[lobbyId] || !lobbies[lobbyId].participants[socket.id]) return;
    const lobby = lobbies[lobbyId];
    if (lobby.revealed) return;
    const nonPO = Object.values(lobby.participants).filter(p => !p.po);
    if (nonPO.length === 0 || !nonPO.every(p => p.estimate !== null)) return;
    lobby.revealed = true;
    logSecurity('info', 'Lobby revealed', { lobbyId, socketId: socket.id });
    broadcast(lobbyId);
  });

  socket.on('reset', (lobbyId) => {
    const check = socketLimiter.isAllowed(socket.id, 'reset', 5, 10_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'reset', retryAfter: check.retryAfter });
      return;
    }
    if (!lobbyId || !lobbies[lobbyId] || !lobbies[lobbyId].participants[socket.id]) return;
    const lobby = lobbies[lobbyId];
    if (!lobby.revealed) return;
    lobby.revealed = false;
    Object.values(lobby.participants).forEach(p => { p.estimate = null; });
    logSecurity('info', 'Lobby reset', { lobbyId, socketId: socket.id });
    broadcast(lobbyId);
  });

  socket.on('disconnect', () => {
    logSecurity('info', 'Socket disconnected', { socketId: socket.id });
    cleanupSocket(socket);
  });
});

const PORT = process.env.PORT || 3000;

module.exports = {
  app,
  httpServer,
  io,
  lobbies,
  socketLimiter,
  lobbyCreationTracker,
  isValidLobbyId,
  sanitizeName,
  getClientIp,
  ALLOWED_ESTIMATES,
  MAX_PARTICIPANTS,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT
};

if (process.env.AUTO_START !== 'false') {
  httpServer.listen(PORT, () => console.log(`Quick Poker running on port ${PORT}`));
}
