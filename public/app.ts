type SocketInstance = import("socket.io-client").Socket;

/** How often the client tells the server it is still alive. */
const HEARTBEAT_INTERVAL_MS = 5000;
/**
 * How long the client waits for the heartbeat acknowledgement. A missing ack
 * means the transport is half-open (the socket still says "connected" but
 * nothing comes back) — the classic failure mode on flaky mobile networks.
 */
const HEARTBEAT_ACK_TIMEOUT_MS = 8000;
/** How long a disconnect has to persist before the offline banner appears. */
const OFFLINE_GRACE_MS = 5000;
/** First reconnect delay; doubles on every failed attempt. */
const RECONNECT_BASE_DELAY_MS = 1000;
/** Upper bound for the reconnect backoff. */
const RECONNECT_MAX_DELAY_MS = 15000;
/** Relative jitter applied to the backoff so clients do not retry in lockstep. */
const RECONNECT_JITTER = 0.2;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

type Presence = "active" | "away" | "offline";

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function getUserId(): string {
  if (typeof localStorage === "undefined") return generateId();
  const existing = localStorage.getItem("qp-user-id");
  if (existing && UUID_PATTERN.test(existing)) return existing;
  const generated = generateId();
  localStorage.setItem("qp-user-id", generated);
  return generated;
}

function getSessionId(): string {
  if (typeof sessionStorage === "undefined") return generateId();
  const existing = sessionStorage.getItem("qp-session-id");
  if (existing && UUID_PATTERN.test(existing)) return existing;
  const generated = generateId();
  sessionStorage.setItem("qp-session-id", generated);
  return generated;
}

function isTabVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

interface Participant {
  id: string;
  name: string;
  estimate: number | string | null;
  po: boolean;
  connected: boolean;
  presence?: Presence;
}

interface LobbyState {
  lobbyId: string;
  id: string;
  revealed: boolean;
  participants: Participant[];
  canReveal: boolean;
}

interface AppData {
  state: LobbyState | null;
  myId: string | null;
  currentLobbyId: string;
  name: string;
  po: boolean;
  showSettings: boolean;
  rateLimitMsg: string | null;
  rateLimitTimer: ReturnType<typeof setTimeout> | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  socket: SocketInstance | null;
  disconnected: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectCountdown: number;
  reconnectInterval: ReturnType<typeof setInterval> | null;
  offlineHandler: (() => void) | null;
  onlineHandler: (() => void) | null;
  visibilityHandler: (() => void) | null;
  /** Set on unmount so late socket callbacks do not restart the retry loop. */
  destroyed: boolean;
}

export const appOptions = {
  data(): AppData {
    return {
      state: null,
      myId: null,
      currentLobbyId: "",
      name: (typeof localStorage !== "undefined" && localStorage.getItem("qp-name")) || "Anonymous",
      po: typeof localStorage !== "undefined" && localStorage.getItem("qp-user-po") === "1",
      showSettings: false,
      rateLimitMsg: null,
      rateLimitTimer: null,
      heartbeatInterval: null,
      socket: null,
      disconnected: false,
      disconnectTimer: null,
      reconnectCountdown: 0,
      reconnectInterval: null,
      offlineHandler: null,
      onlineHandler: null,
      visibilityHandler: null,
      destroyed: false,
    };
  },
  computed: {
    myEstimate(this: AppData): number | string | null {
      const me = this.state?.participants.find((p: Participant) => p.id === this.myId);
      return me?.estimate ?? null;
    },
    isPO(this: AppData): boolean {
      const me = this.state?.participants.find((p: Participant) => p.id === this.myId);
      return me?.po ?? false;
    },
  },
  mounted(this: AppData) {
    const socket = io({
      // The reconnect loop below owns the retry schedule, so socket.io must not
      // run a second one in parallel.
      reconnection: false,
      // A connection attempt must not hang forever on a dead network.
      timeout: 10000,
      // Websocket first (fewer round trips, better on flaky links), with an
      // automatic fallback to long polling for restrictive proxies.
      transports: ["websocket", "polling"],
    });
    this.socket = socket;
    const lobbyId = location.hash.slice(1);
    const userId = getUserId();
    const sessionId = getSessionId();

    let reconnectAttempt = 0;

    const nextReconnectDelay = (): number => {
      const base = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttempt += 1;
      const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
      return Math.max(500, Math.round(base * jitter));
    };

    const stopReconnectCountdown = () => {
      if (this.reconnectInterval !== null) {
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = null;
      }
      this.reconnectCountdown = 0;
    };

    /**
     * Single retry loop with exponential backoff. It keeps running until the
     * socket connects again; the banner is controlled separately.
     */
    const startReconnectCountdown = () => {
      if (this.destroyed) return;
      if (this.reconnectInterval !== null) return;
      const delay = nextReconnectDelay();
      const deadline = Date.now() + delay;
      this.reconnectCountdown = Math.max(1, Math.ceil(delay / 1000));
      this.reconnectInterval = setInterval(() => {
        if (this.destroyed) {
          stopReconnectCountdown();
          return;
        }
        const remaining = deadline - Date.now();
        this.reconnectCountdown = Math.max(1, Math.ceil(remaining / 1000));
        if (remaining > 0) return;
        stopReconnectCountdown();
        socket.connect();
        // The attempt is in flight — arm the next one in case it fails.
        startReconnectCountdown();
      }, 1000);
    };

    /** Show the offline banner, but only after the disconnect has persisted. */
    const armBannerTimer = () => {
      if (this.disconnectTimer !== null) return;
      this.disconnectTimer = setTimeout(() => {
        this.disconnected = true;
        this.disconnectTimer = null;
      }, OFFLINE_GRACE_MS);
    };

    const showBannerNow = () => {
      if (this.disconnectTimer !== null) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      this.disconnected = true;
    };

    const sendVisibility = () => {
      if (!socket.connected || !this.currentLobbyId) return;
      socket.emit("visibility", this.currentLobbyId, isTabVisible());
    };

    /**
     * Heartbeat with acknowledgement. A missing ack proves the link is dead,
     * even when the transport still claims to be connected.
     */
    const sendHeartbeat = () => {
      if (!socket.connected) return;
      socket.timeout(HEARTBEAT_ACK_TIMEOUT_MS).emit("heartbeat", (err: Error | null) => {
        if (!err || this.destroyed) return;
        socket.disconnect();
        startReconnectCountdown();
        showBannerNow();
      });
    };

    const joinLobby = (id: string) => {
      socket.emit("join", id, userId, sessionId, (joinedId: string | null) => {
        if (!joinedId) {
          alert("Failed to create or join lobby. Please try again later.");
          startReconnectCountdown();
          showBannerNow();
          return;
        }
        location.hash = joinedId;
        this.currentLobbyId = joinedId;
        this.myId = socket.id ?? null;
        socket.emit("setName", joinedId, this.name);
        if (this.po) socket.emit("setPO", joinedId, true);
        // Tell the server whether our tab is in the foreground.
        sendVisibility();
      });
    };

    joinLobby(lobbyId);

    socket.on("connect", () => {
      const hadPendingDisconnect = this.disconnectTimer !== null;
      if (this.disconnectTimer !== null) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      const wasDisconnected = this.disconnected;
      stopReconnectCountdown();
      this.disconnected = false;
      reconnectAttempt = 0;
      if ((wasDisconnected || hadPendingDisconnect) && this.currentLobbyId) {
        joinLobby(this.currentLobbyId);
      }
    });

    socket.on("disconnect", () => {
      if (this.destroyed) return;
      startReconnectCountdown();
      if (this.disconnected) return;
      armBannerTimer();
    });

    // A failed connection attempt never emits "disconnect" — without this the
    // client would sit there silently after a failed initial connect.
    socket.on("connect_error", () => {
      if (this.destroyed) return;
      startReconnectCountdown();
      armBannerTimer();
    });

    const onOffline = () => {
      socket.disconnect();
      startReconnectCountdown();
      showBannerNow();
    };
    const onOnline = () => {
      socket.connect();
      startReconnectCountdown();
    };
    this.offlineHandler = onOffline;
    this.onlineHandler = onOnline;
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    const onVisibilityChange = () => {
      if (isTabVisible()) {
        // The server may have dropped us while the tab was throttled, so probe
        // the link right away instead of waiting for the next heartbeat.
        sendVisibility();
        if (socket.connected) {
          sendHeartbeat();
        } else {
          socket.connect();
          startReconnectCountdown();
        }
      } else {
        sendVisibility();
      }
    };
    this.visibilityHandler = onVisibilityChange;
    document.addEventListener("visibilitychange", onVisibilityChange);

    socket.on("state", (state: LobbyState) => {
      if (state.lobbyId !== this.currentLobbyId) return;
      this.state = state;
      const me = state.participants.find((p: Participant) => p.id === this.myId);
      if (me) {
        this.po = me.po;
        if (typeof localStorage !== "undefined") {
          if (me.po) localStorage.setItem("qp-user-po", "1");
          else localStorage.removeItem("qp-user-po");
        }
      }
    });

    socket.on("rate-limited", ({ event, retryAfter }: { event: string; retryAfter: number }) => {
      clearTimeout(this.rateLimitTimer ?? undefined);
      this.rateLimitMsg = `Too many ${event} requests. Retry after ${retryAfter}s.`;
      this.rateLimitTimer = setTimeout(() => {
        this.rateLimitMsg = null;
      }, retryAfter * 1000);
    });

    this.heartbeatInterval = setInterval(() => {
      sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  },
  beforeUnmount(this: AppData) {
    this.destroyed = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.rateLimitTimer) {
      clearTimeout(this.rateLimitTimer);
    }
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
    }
    if (this.reconnectInterval !== null) {
      clearInterval(this.reconnectInterval);
    }
    if (this.offlineHandler) {
      window.removeEventListener("offline", this.offlineHandler);
      this.offlineHandler = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener("online", this.onlineHandler);
      this.onlineHandler = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.socket) {
      this.socket.disconnect();
    }
  },
  methods: {
    /** Suffix shown next to a participant's name. */
    presenceSuffix(this: AppData, p: Participant): string {
      if (p.presence === "away") return " (tab in background)";
      if (!p.connected) return " (offline)";
      return "";
    },
    updateName(this: AppData): void {
      localStorage.setItem("qp-name", this.name);
      if (this.currentLobbyId && this.socket) {
        this.socket.emit("setName", this.currentLobbyId, this.name);
      }
    },
    updatePO(this: AppData): void {
      if (this.currentLobbyId && this.socket) {
        this.socket.emit("setPO", this.currentLobbyId, this.po);
      }
    },
    estimate(this: AppData, val: number): void {
      if (this.currentLobbyId && this.socket) {
        this.socket.emit("estimate", this.currentLobbyId, val);
      }
    },
    reveal(this: AppData): void {
      if (this.currentLobbyId && this.socket) {
        this.socket.emit("reveal", this.currentLobbyId);
      }
    },
    reset(this: AppData): void {
      if (this.currentLobbyId && this.socket) {
        this.socket.emit("reset", this.currentLobbyId);
      }
    },
  },
};

if (typeof window !== "undefined" && document.getElementById("app")) {
  const { createApp } = Vue;
  createApp(appOptions).mount("#app");
}
