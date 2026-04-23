const { createApp } = Vue;

createApp({
  data() {
    return {
      state: null,
      myId: null,
      name: localStorage.getItem('qp-name') || 'Anonymous',
      po: false,
      showSettings: false,
      rateLimitMsg: null,
      rateLimitTimer: null
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
      this.myId = this.socket.id;
      this.socket.emit('setName', this.name);
      if (this.po) this.socket.emit('setPO', true);
    });

    this.socket.on('state', (state) => {
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
  },
  methods: {
    updateName() {
      localStorage.setItem('qp-name', this.name);
      this.socket.emit('setName', this.name);
    },
    updatePO() {
      this.socket.emit('setPO', this.po);
    },
    estimate(val) {
      this.socket.emit('estimate', val);
    },
    reveal() {
      this.socket.emit('reveal');
    },
    reset() {
      this.socket.emit('reset');
    }
  }
}).mount('#app');
