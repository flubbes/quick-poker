# Quick Poker

A dead-simple planning poker app for remote teams. No sign-ups, no bloat, no nonsense.

## Why?

Most planning poker tools try to do way more than they need to. I just wanted something that lets a team hop in, estimate, and move on. So I built the perfect one (for me).

## Tech Stack

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** Vue 3 (global build)
- **Container:** Single Docker container

## Development

```bash
npm install
npm start
```

The app runs on `http://localhost:3000`.

## Docker

```bash
docker build -t quick-poker .
docker run -p 3000:3000 quick-poker
```

If you run the container behind a trusted reverse proxy (e.g. Nginx, Caddy, Traefik), pass `TRUST_PROXY=true` so rate-limiting keys off the correct client IP:

```bash
docker run -e TRUST_PROXY=true -p 3000:3000 quick-poker
```

## How it works

1. Open the app — a new session is created automatically.
2. Share the link with your team.
3. Everyone picks a card.
4. Reveal when ready.
5. Reset and estimate again.
