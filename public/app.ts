type SocketInstance = import("socket.io-client").Socket;
const RECONNECT_INTERVAL_SECONDS = 5;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

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

interface Participant {
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
}

export const appOptions = {
  data(): AppData {
    return {
      state: null,
      myId: null,
      currentLobbyId: "",
      name: (typeof localStorage !== "undefined" && localStorage.getItem("qp-name")) || "Anonymous",
      po: false,
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
    const socket = io();
    this.socket = socket;
    const lobbyId = location.hash.slice(1);
    const userId = getUserId();
    const sessionId = getSessionId();

    const stopReconnectCountdown = () => {
      if (this.reconnectInterval !== null) {
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = null;
      }
      this.reconnectCountdown = 0;
    };

    const startReconnectCountdown = () => {
      this.disconnected = true;
      if (this.reconnectInterval !== null) return;
      this.reconnectCountdown = RECONNECT_INTERVAL_SECONDS;
      this.reconnectInterval = setInterval(() => {
        if (this.reconnectCountdown > 1) {
          this.reconnectCountdown--;
          return;
        }
        this.reconnectCountdown = RECONNECT_INTERVAL_SECONDS;
        socket.connect();
      }, 1000);
    };

    const reconnectNow = () => {
      socket.connect();
      if (this.disconnected) {
        stopReconnectCountdown();
        startReconnectCountdown();
      }
    };

    const joinLobby = (id: string) => {
      socket.emit("join", id, userId, sessionId, (joinedId: string | null) => {
        if (!joinedId) {
          alert("Failed to create or join lobby. Please try again later.");
          startReconnectCountdown();
          return;
        }
        location.hash = joinedId;
        this.currentLobbyId = joinedId;
        this.myId = socket.id ?? null;
        socket.emit("setName", joinedId, this.name);
        if (this.po) socket.emit("setPO", joinedId, true);
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
      if ((wasDisconnected || hadPendingDisconnect) && this.currentLobbyId) {
        joinLobby(this.currentLobbyId);
      }
    });

    socket.on("disconnect", () => {
      if (this.disconnected) return;
      if (this.disconnectTimer !== null) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = setTimeout(() => {
        startReconnectCountdown();
        this.disconnectTimer = null;
      }, 5000);
    });

    const onOffline = () => {
      if (this.disconnectTimer !== null) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      socket.disconnect();
      startReconnectCountdown();
    };
    const onOnline = () => {
      reconnectNow();
    };
    this.offlineHandler = onOffline;
    this.onlineHandler = onOnline;
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    socket.on("state", (state: LobbyState) => {
      if (state.lobbyId !== this.currentLobbyId) return;
      this.state = state;
      const me = state.participants.find((p: Participant) => p.id === this.myId);
      if (me) this.po = me.po;
    });

    socket.on("rate-limited", ({ event, retryAfter }: { event: string; retryAfter: number }) => {
      clearTimeout(this.rateLimitTimer ?? undefined);
      this.rateLimitMsg = `Too many ${event} requests. Retry after ${retryAfter}s.`;
      this.rateLimitTimer = setTimeout(() => {
        this.rateLimitMsg = null;
      }, retryAfter * 1000);
    });

    this.heartbeatInterval = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit("heartbeat");
      }
    }, 5000);
  },
  beforeUnmount(this: AppData) {
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
  },
  methods: {
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
