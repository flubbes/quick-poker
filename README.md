# Quick Poker

A dead-simple planning poker app for remote teams. No sign-ups, no bloat, no nonsense.

Most planning poker tools try to do more than they need to. I just wanted something that lets a team hop in, estimate, and move on. So I built the perfect one (for me).

## How to use it

1. Open the app — a new session is created automatically.
2. Share the link with your team.
3. Everyone picks a card (`0, 1, 2, 3, 5, 8, 13, 20, 40`).
4. Reveal when everyone has estimated.
5. Reset and estimate again.

By default the app runs on `http://localhost:3000`.

## Self-hosting (Docker)

```bash
docker build -t quick-poker .
docker run -p 3000:3000 quick-poker
```

If you run the container behind a trusted reverse proxy (e.g. Nginx, Caddy, Traefik), pass `TRUST_PROXY=true` so rate-limiting keys off the correct client IP:

```bash
docker run -e TRUST_PROXY=true -p 3000:3000 quick-poker
```

## Development

### Tech Stack

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** Vue 3 (global build)
- **Styling:** Vanilla CSS, dark mode only
- **Container:** Single Docker container

### Running Locally

```bash
npm install
npm start
```

The app runs on `http://localhost:3000`. A new lobby is created on every visit.

### Developing

The server does **not** hot-reload. Restart with `npm start` after code changes to pick them up.

Before opening a PR, run:

```bash
npm run format:check
npm test
```

### Troubleshooting

- **Server starts but `curl localhost:3000` fails** — make sure `AUTO_START` is not set to `false`. That env var is reserved for tests.
- **Port 3000 is taken** — set `PORT=3001 npm start`.
- **Rate limits feel wrong behind a proxy** — set `TRUST_PROXY=true` so the client IP comes from `X-Forwarded-For`.
