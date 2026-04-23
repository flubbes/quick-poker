const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
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

function isValidLobbyId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
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
  return String(name).slice(0, 15).replace(/[<>"'&]/g, '');
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
}

const socketLimiter = new SocketRateLimiter();

// Periodic cleanup of empty lobbies and stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  Object.keys(lobbies).forEach(id => {
    if (Object.keys(lobbies[id].participants).length === 0 && (now - lobbies[id].createdAt > 300_000)) {
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
  return { id: lobby.id, revealed: lobby.revealed, participants, canReveal };
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
  let currentLobby = null;

  socket.on('join', (lobbyId, cb) => {
    const check = socketLimiter.isAllowed(socket.id, 'join', 10, 60_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'join', retryAfter: check.retryAfter });
      return cb(null);
    }

    if (!lobbyId || !isValidLobbyId(lobbyId)) {
      const clientIp = getClientIp(socket);
      if (!canCreateLobby(clientIp)) {
        return cb(null);
      }
      lobbyId = randomUUID();
      lobbies[lobbyId] = { id: lobbyId, participants: Object.create(null), revealed: false, createdAt: Date.now() };
    } else if (!lobbies[lobbyId]) {
      const clientIp = getClientIp(socket);
      if (!canCreateLobby(clientIp)) {
        return cb(null);
      }
      lobbies[lobbyId] = { id: lobbyId, participants: Object.create(null), revealed: false, createdAt: Date.now() };
    }

    if (Object.keys(lobbies[lobbyId].participants).length >= MAX_PARTICIPANTS) {
      return cb(null);
    }

    currentLobby = lobbyId;
    socket.join(lobbyId);
    lobbies[lobbyId].participants[socket.id] = {
      id: socket.id,
      name: 'Anonymous',
      estimate: null,
      po: false
    };
    broadcast(lobbyId);
    cb(lobbyId);
  });

  socket.on('setName', (name) => {
    const check = socketLimiter.isAllowed(socket.id, 'setName', 10, 10_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'setName', retryAfter: check.retryAfter });
      return;
    }
    if (!currentLobby || !lobbies[currentLobby]) return;
    lobbies[currentLobby].participants[socket.id].name = sanitizeName(name);
    broadcast(currentLobby);
  });

  socket.on('setPO', (po) => {
    const check = socketLimiter.isAllowed(socket.id, 'setPO', 10, 10_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'setPO', retryAfter: check.retryAfter });
      return;
    }
    if (!currentLobby || !lobbies[currentLobby]) return;
    lobbies[currentLobby].participants[socket.id].po = !!po;
    broadcast(currentLobby);
  });

  socket.on('estimate', (value) => {
    const check = socketLimiter.isAllowed(socket.id, 'estimate', 10, 5_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'estimate', retryAfter: check.retryAfter });
      return;
    }
    if (!currentLobby || !lobbies[currentLobby]) return;
    if (lobbies[currentLobby].revealed) return;
    if (!ALLOWED_ESTIMATES.includes(value)) return;
    lobbies[currentLobby].participants[socket.id].estimate = value;
    broadcast(currentLobby);
  });

  socket.on('reveal', () => {
    const check = socketLimiter.isAllowed(socket.id, 'reveal', 5, 10_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'reveal', retryAfter: check.retryAfter });
      return;
    }
    if (!currentLobby || !lobbies[currentLobby]) return;
    const lobby = lobbies[currentLobby];
    if (lobby.revealed) return;
    const nonPO = Object.values(lobby.participants).filter(p => !p.po);
    if (nonPO.length === 0 || !nonPO.every(p => p.estimate !== null)) return;
    lobby.revealed = true;
    broadcast(currentLobby);
  });

  socket.on('reset', () => {
    const check = socketLimiter.isAllowed(socket.id, 'reset', 5, 10_000);
    if (!check.allowed) {
      socket.emit('rate-limited', { event: 'reset', retryAfter: check.retryAfter });
      return;
    }
    if (!currentLobby || !lobbies[currentLobby]) return;
    const lobby = lobbies[currentLobby];
    if (!lobby.revealed) return;
    lobby.revealed = false;
    Object.values(lobby.participants).forEach(p => { p.estimate = null; });
    broadcast(currentLobby);
  });

  socket.on('disconnect', () => {
    socketLimiter.removeSocket(socket.id);
    if (!currentLobby || !lobbies[currentLobby]) return;
    delete lobbies[currentLobby].participants[socket.id];
    broadcast(currentLobby);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Quick Poker running on port ${PORT}`));
