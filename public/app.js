const { createApp } = Vue;

createApp({
  data() {
    return {
      state: null,
      myId: null,
      currentLobbyId: '',
      name: localStorage.getItem('qp-name') || 'Anonymous',
      po: false,
      showSettings: false,
      rateLimitMsg: null,
      rateLimitTimer: null,
      heartbeatInterval: null
    };
  },
  computed: {
    myEstimate() {
      const me = this.state?.participants.find(p => p.id === this.myId);
      return me?.estimate ?? null;
    },
    isPO() {
      const me = this.state?.participants.find(p => p.id === this.myId);
      return me?.po ?? false;
    }
  },
  mounted() {
    this.socket = io();
    const lobbyId = location.hash.slice(1);

    this.socket.emit('join', lobbyId, (id) => {
      if (!id) {
        alert('Failed to create or join lobby. Please try again later.');
        return;
      }
      location.hash = id;
      this.currentLobbyId = id;
      this.myId = this.socket.id;
      this.socket.emit('setName', id, this.name);
      if (this.po) this.socket.emit('setPO', id, true);
    });

    this.socket.on('state', (state) => {
      if (state.lobbyId !== this.currentLobbyId) return;
      this.state = state;
      const me = state.participants.find(p => p.id === this.myId);
      if (me) this.po = me.po;
    });

    this.socket.on('rate-limited', ({ event, retryAfter }) => {
      clearTimeout(this.rateLimitTimer);
      this.rateLimitMsg = `Too many ${event} requests. Retry after ${retryAfter}s.`;
      this.rateLimitTimer = setTimeout(() => {
        this.rateLimitMsg = null;
      }, retryAfter * 1000);
    });

    this.heartbeatInterval = setInterval(() => {
      if (this.socket.connected) {
        this.socket.emit('heartbeat');
      }
    }, 5000);
  },
  beforeUnmount() {
    clearInterval(this.heartbeatInterval);
  },
  methods: {
    updateName() {
      localStorage.setItem('qp-name', this.name);
      if (this.currentLobbyId) this.socket.emit('setName', this.currentLobbyId, this.name);
    },
    updatePO() {
      if (this.currentLobbyId) this.socket.emit('setPO', this.currentLobbyId, this.po);
    },
    estimate(val) {
      if (this.currentLobbyId) this.socket.emit('estimate', this.currentLobbyId, val);
    },
    reveal() {
      if (this.currentLobbyId) this.socket.emit('reveal', this.currentLobbyId);
    },
    reset() {
      if (this.currentLobbyId) this.socket.emit('reset', this.currentLobbyId);
    }
  }
}).mount('#app');
