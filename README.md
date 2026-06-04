# P2P Date Sharing

> ⚠️ Working name. Real `.com` domain to be chosen — see *Renaming* below.

A peer-to-peer file sharing micro-tool. Files transfer directly browser-to-browser
via WebRTC — nothing ever touches a server.

Built with **Astro 6** (SEO-first MPA), **Tailwind CSS v4**, and deployed to
**Cloudflare Pages**. Follows the [CompileFuture micro-tool playbook](https://compilefuture.com/blog/how-to-earn-using-ai/).

## Quick start

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # static output in dist/
npx astro check      # type + Astro diagnostics
```

## Project layout

```
src/
  site.config.ts         # ← brand strings (env-driven, rename-safe)
  layouts/Layout.astro   # <head>, OG, canonical (uses site.config)
  pages/                 # one .astro per route (MPA)
  styles/global.css      # Tailwind v4 + design tokens
public/                  # static assets
DESIGN.md                # visual contract (Vercel-style)
AGENTS.md                # rules for AI agents
.skills/                 # project-local skills
  web-design-guidelines/
  tailwind-4-docs/
.env.example             # copy to .env, edit when domain is finalized
```

## Renaming (when the real domain is bought)

The literal string `p2pdatesharing` is **not** baked into any source file.
To rebrand:

```bash
cp .env.example .env
# edit PUBLIC_SITE_NAME, PUBLIC_SITE_DOMAIN, PUBLIC_SITE_URL, etc.
npm run build
```

That's it. No code changes required.

## Stack rationale

- **Astro** — pure static HTML output, perfect Core Web Vitals, MPA = SEO win.
- **Tailwind v4** — zero-config, `@theme` directive, fastest build pipeline.
- **Cloudflare Pages** — free hosting, global CDN, native Astro support.
- **WebRTC** — true browser-to-browser P2P; no relay server needed for transfer.
