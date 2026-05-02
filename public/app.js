"use strict";
(() => {
  const appOptions = {
    data() {
      return {
        state: null,
        myId: null,
        currentLobbyId: "",
        name: typeof localStorage !== "undefined" && localStorage.getItem("qp-name") || "Anonymous",
        po: false,
        showSettings: false,
        rateLimitMsg: null,
        rateLimitTimer: null,
        heartbeatInterval: null,
        socket: null
      };
    },
    computed: {
      myEstimate() {
        const me = this.state?.participants.find((p) => p.id === this.myId);
        return me?.estimate ?? null;
      },
      isPO() {
        const me = this.state?.participants.find((p) => p.id === this.myId);
        return me?.po ?? false;
      }
    },
    mounted() {
      const socket = io();
      this.socket = socket;
      const lobbyId = location.hash.slice(1);
      socket.emit("join", lobbyId, (id) => {
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
      socket.on("state", (state) => {
        if (state.lobbyId !== this.currentLobbyId) return;
        this.state = state;
        const me = state.participants.find((p) => p.id === this.myId);
        if (me) this.po = me.po;
      });
      socket.on("rate-limited", ({ event, retryAfter }) => {
        clearTimeout(this.rateLimitTimer ?? void 0);
        this.rateLimitMsg = `Too many ${event} requests. Retry after ${retryAfter}s.`;
        this.rateLimitTimer = setTimeout(() => {
          this.rateLimitMsg = null;
        }, retryAfter * 1e3);
      });
      this.heartbeatInterval = setInterval(() => {
        if (socket && socket.connected) {
          socket.emit("heartbeat");
        }
      }, 5e3);
    },
    beforeUnmount() {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }
    },
    methods: {
      updateName() {
        localStorage.setItem("qp-name", this.name);
        if (this.currentLobbyId && this.socket) {
          this.socket.emit("setName", this.currentLobbyId, this.name);
        }
      },
      updatePO() {
        if (this.currentLobbyId && this.socket) {
          this.socket.emit("setPO", this.currentLobbyId, this.po);
        }
      },
      estimate(val) {
        if (this.currentLobbyId && this.socket) {
          this.socket.emit("estimate", this.currentLobbyId, val);
        }
      },
      reveal() {
        if (this.currentLobbyId && this.socket) {
          this.socket.emit("reveal", this.currentLobbyId);
        }
      },
      reset() {
        if (this.currentLobbyId && this.socket) {
          this.socket.emit("reset", this.currentLobbyId);
        }
      }
    }
  };
  if (typeof window !== "undefined" && document.getElementById("app")) {
    const { createApp } = Vue;
    createApp(appOptions).mount("#app");
  }
})();
