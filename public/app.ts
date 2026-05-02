type SocketInstance = import("socket.io-client").Socket;

interface Participant {
  id: string;
  name: string;
  estimate: number | string | null;
  po: boolean;
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

    socket.emit("join", lobbyId, (id: string | null) => {
      if (!id) {
        alert("Failed to create or join lobby. Please try again later.");
        return;
      }
      location.hash = id;
      this.currentLobbyId = id;
      this.myId = socket.id ?? null;
      socket.emit("setName", id, this.name);
      if (this.po) socket.emit("setPO", id, true);
    });

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
