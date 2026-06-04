# AGENTS.md — Rules for AI agents working on this repo

This project is built **by AI agents** (Hermes / JARVIS), not by Claude Code in the
referenced tutorial video. The workflow is the same, but the executor is different.
Follow these rules on every change.

## Stack

- **Astro 6** (MPA, SEO-first static output) + **TypeScript strict**
- **Tailwind CSS v4** (zero-config, `@theme` in `src/styles/global.css`)
- **Cloudflare Pages** deploy target (static)
- **WebRTC** for peer-to-peer file transfer (client islands as needed)
- Node `>=22.12.0`, npm

## Mandatory skills (load before coding)

When editing this repo, load these skills via `skill_view`:

1. **`web-design-guidelines`** (project-local, `.skills/web-design-guidelines/`)
   — UI quality bar, layout conventions, component patterns.
2. **`tailwind-4-docs`** (project-local, `.skills/tailwind-4-docs/`)
   — Tailwind v4 syntax (NOT v3). No `tailwind.config.js`. `@theme` only.
3. **`astro-docs`** — fetch latest Astro patterns from
   <https://docs.astro.build/llms.txt> when unsure of API.

Also read **`DESIGN.md`** before any UI work. It is the visual contract.

## Brand-name discipline

- Domain isn't finalized. **Never hardcode the string "p2pdatesharing"** in
  source files — always import from `src/site.config.ts`.
- All user-facing brand strings (`name`, `shortName`, `domain`, `tagline`,
  `description`) come from `site.config.ts`, overridable via `PUBLIC_SITE_*`
  env vars in `.env`. See `.env.example`.
- When the real domain is bought, edit `.env` only. No code changes.

## SEO non-negotiables

- One `<h1>` per page.
- Every page has `<title>`, `<meta description>`, OG tags, canonical (handled by `Layout.astro`).
- Use MPA: separate `.astro` page per route. No SPA routing.
- FAQ pages must include JSON-LD `FAQPage` schema.
- Lazy-load below-the-fold images, always set `width`/`height`.

## Code conventions

- Components: PascalCase `.astro` in `src/components/`.
- Pages: kebab-case in `src/pages/` (e.g. `privacy-policy.astro`).
- Client-side TS: ES modules, no global script tags.
- No hex colors in components — use CSS variables from `global.css`.
- Tailwind utilities preferred over custom CSS.
- Strict TypeScript — fix all `tsc --noEmit` errors before commit.

## Required pages (add as the project grows)

`/`, `/about`, `/privacy-policy`, `/terms`, `/contact`, `/404`, `/500`,
plus the actual P2P share tool page(s). Also `robots.txt` and `sitemap.xml`
in `public/`.

## Verify before commit

```bash
npm run build       # must succeed
npx astro check     # type + Astro diagnostics
```

## Deploy target reminder

Cloudflare Pages, static output, `_headers` file under `public/` once the
`.com` domain is connected (to mark `*.pages.dev` `noindex`).
