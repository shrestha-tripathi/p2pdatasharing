# Cloudflare Worker — Local Teleport signaling

Stateless-ish WebSocket signaling using **Durable Objects** (one DO instance per room).
Forwards SDP/ICE between two peers, holds zero state once empty.

## One-time setup

```bash
cd worker
npm install
npx wrangler login        # auth via browser
npx wrangler deploy
```

Wrangler prints the deployed URL, e.g.
`https://local-teleport-signaling.<your-subdomain>.workers.dev`

In the frontend `.env` (or Cloudflare Pages env vars), set:
```
PUBLIC_SIGNALING_URL=wss://local-teleport-signaling.<your-subdomain>.workers.dev
```

## Cost

- **Free tier:** 100k requests/day, unlimited Durable Objects connections
  for paid plans; on free, DO usage is capped — sufficient for personal /
  small-team use. If you outgrow it, $5/month Workers Paid covers millions
  of connections.
- No egress bandwidth charges (file bytes don't flow through here).

## Why Durable Objects?

WebSocket signaling needs two peers in the same room to share state. Plain
stateless Workers spin up per-request and forget everything. Durable Objects
give you exactly one persistent instance per room ID, automatically routed.

## Local dev

```bash
npx wrangler dev
# WS endpoint: ws://localhost:8787
```
