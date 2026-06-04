# Signaling server

Stateless WebSocket router for Local Teleport. Forwards SDP/ICE messages
between two peers in a room. **No file bytes ever flow through here.**

## Run

```bash
npm install
npm start          # or: PORT=9090 npm start
```

Then point the frontend at it via `PUBLIC_SIGNALING_URL` in the project root `.env`:

```
PUBLIC_SIGNALING_URL="ws://localhost:8080"
```

In production, terminate TLS (e.g. via Caddy/Cloudflare) and use `wss://`.

## Protocol

```jsonc
// client → server
{ "room": "abc123", "type": "join" }
{ "room": "abc123", "type": "offer",     "payload": <RTCSessionDescriptionInit> }
{ "room": "abc123", "type": "answer",    "payload": <RTCSessionDescriptionInit> }
{ "room": "abc123", "type": "candidate", "payload": <RTCIceCandidateInit> }

// server → client (errors only)
{ "type": "error", "payload": { "message": "Room full" } }
```

Rooms hold at most 2 peers. When the last peer leaves, the room is wiped from memory.
