# FileTransferNow

> Send files browser-to-browser. No upload, no signup, no size limit.

Production site: **[filetransfernow.com](https://filetransfernow.com)**
Repo: **[github.com/shrestha-tripathi/p2pdatasharing](https://github.com/shrestha-tripathi/p2pdatasharing)**

A peer-to-peer file sharing micro-tool. Files transfer directly browser-to-browser
over WebRTC — bytes never touch a server, end-to-end encrypted by DTLS-SRTP, works
across any network (NAT/TURN-relayed when direct fails).

Built with **Astro 6** (SEO-first MPA), **Tailwind CSS v4**, and deployed to
**Cloudflare Pages**. Signaling runs on a tiny **Cloudflare Worker + Durable Objects**.

## Quick start

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # static output in dist/
npx astro check      # type + Astro diagnostics
```

Signaling worker (separate):

```bash
cd worker
npx wrangler dev     # local signaling on ws://localhost:8787
npx wrangler deploy  # production deploy
```

## Project layout

```
src/
  site.config.ts         # ← brand strings (env-driven, rename-safe)
  layouts/Layout.astro   # <head>, OG, canonical (uses site.config)
  pages/                 # one .astro per route (MPA)
  lib/                   # fileTransfer, teleportSession, chat, devicePairs
  styles/global.css      # Tailwind v4 + design tokens
worker/                  # Cloudflare Worker — signaling + room/code DOs
public/                  # static assets
docs/
  specs/                 # feature specs (write before coding)
  roadmap/               # forward-looking design docs (bidirectional, etc.)
DESIGN.md                # visual contract
AGENTS.md                # rules for AI coding agents
.env.example             # copy to .env for local overrides
```

## Configuration

All brand and infra strings come from environment variables (see `.env.example`).
The literal repo name is **not** baked into source — `PUBLIC_SITE_NAME`,
`PUBLIC_SITE_DOMAIN`, `PUBLIC_SITE_URL`, `PUBLIC_SIGNALING_URL` etc. flow through
`src/site.config.ts` to every page.

Production values live in Cloudflare Pages env vars; local overrides go in `.env`.

## Stack rationale

- **Astro** — pure static HTML output, perfect Core Web Vitals, MPA = SEO win.
- **Tailwind v4** — zero-config, `@theme` directive, fastest build pipeline.
- **Cloudflare Pages** — free hosting, global CDN, push-to-deploy from `main`.
- **Cloudflare Workers + Durable Objects** — signaling, short-code pairing,
  device-pair registry. Free tier covers expected traffic.
- **WebRTC data channels** — true browser-to-browser P2P; bytes never relay
  through us (TURN is fallback-only, also free-tier on Metered).

## Architecture at a glance

```
┌────────────┐  signaling (SDP + ICE)   ┌────────────┐
│   Sender   │ ◄────── WS ──────► CF Worker ◄── WS ─────► │  Receiver  │
└─────┬──────┘                                            └──────┬─────┘
      │                                                         │
      │            WebRTC DataChannel (DTLS-SRTP)               │
      └─────────────────────────────────────────────────────────┘
                       file bytes flow directly
```

Worker is signaling-only — never sees file content. After ICE completes, the
worker can sleep and the transfer continues.

## Roadmap

Forward-looking design docs live in [`docs/roadmap/`](docs/roadmap/):

- [`bidirectional-transfers.md`](docs/roadmap/bidirectional-transfers.md) —
  Collapse sender/receiver roles after pairing so either peer can send.

Per-feature specs (already in progress or shipped) live in
[`docs/specs/`](docs/specs/).

## License

TBD — currently all rights reserved while in private beta.
