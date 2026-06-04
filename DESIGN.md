# DESIGN.md — Visual & Interaction System

Inspired by Vercel's design language. This document is the authoritative
reference for any code-generating agent (human or AI) building UI in this
project. **Read this before touching styling.**

---

## 1. Philosophy

- **Content first.** UI recedes; the tool is the hero.
- **Sharp & minimal.** No skeuomorphism, no gradients-for-the-sake-of-it.
- **Monochromatic foundation, accent sparingly.** One ink color does 90% of the work.
- **Motion is communication.** Animation only when it conveys state, never decoration.
- **Dark mode is first-class** — design both modes together, never one then the other.

## 2. Color Tokens

Use CSS variables in `src/styles/global.css`. Never hardcode hex in components.

| Token              | Light            | Dark             | Use                              |
|--------------------|------------------|------------------|----------------------------------|
| `--bg`             | `#ffffff`        | `#0a0a0a`        | Page background                  |
| `--bg-subtle`      | `#fafafa`        | `#111111`        | Cards, code blocks               |
| `--bg-muted`       | `#f4f4f5`        | `#1a1a1a`        | Hover, inputs                    |
| `--border`         | `#e5e5e5`        | `#262626`        | All borders                      |
| `--border-strong`  | `#d4d4d4`        | `#404040`        | Focus rings, dividers            |
| `--fg`             | `#0a0a0a`        | `#fafafa`        | Primary text                     |
| `--fg-muted`       | `#525252`        | `#a3a3a3`        | Secondary text                   |
| `--fg-subtle`      | `#737373`        | `#737373`        | Tertiary, captions               |
| `--accent`         | `#0070f3`        | `#3291ff`        | Links, primary CTAs              |
| `--success`        | `#0070f3`        | `#3291ff`        | Confirmations                    |
| `--warning`        | `#f5a623`        | `#f7b955`        | Warnings                         |
| `--danger`         | `#ee0000`        | `#ff4444`        | Errors, destructive              |

## 3. Typography

- **Font stack:** `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- **Mono:** `"JetBrains Mono", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace`
- **Scale (rem):** 0.75 / 0.875 / 1 / 1.125 / 1.25 / 1.5 / 1.875 / 2.25 / 3 / 3.75 / 4.5
- **Weights:** 400 (body), 500 (UI labels), 600 (headings), 700 (hero)
- **Tracking:** Headings `-0.02em`, body `0`, small caps labels `0.06em`.
- **Leading:** Body `1.6`, headings `1.15`.

Hero headings allowed up to `5rem` on `>=1024px`. Always pair tight tracking with bold weight.

## 4. Spacing

4-pt base grid: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128`.
Use Tailwind spacing utilities — do not invent custom margins.

## 5. Layout

- **Container:** max-width `1200px`, horizontal padding `24px` mobile / `48px` desktop.
- **Section vertical rhythm:** `py-20 md:py-32` for hero, `py-16 md:py-24` for content.
- **Grid:** prefer CSS grid with named tracks. Avoid nested flex chains.

## 6. Borders & Radius

- Default border: `1px solid var(--border)`.
- Radius scale: `4 / 6 / 8 / 12 / 16 / 24 / 9999` (pill).
- Cards: `radius-12`, surfaces: `radius-8`, buttons: `radius-8`, inputs: `radius-6`.
- **No drop shadows by default.** Use borders. Shadow only for floating overlays:
  `0 8px 24px rgb(0 0 0 / 0.08)` light, `0 8px 32px rgb(0 0 0 / 0.5)` dark.

## 7. Buttons

| Variant     | BG                  | FG          | Border           | Hover                  |
|-------------|---------------------|-------------|------------------|------------------------|
| Primary     | `--fg`              | `--bg`      | none             | bg `--fg-muted`        |
| Secondary   | transparent         | `--fg`      | `--border`       | bg `--bg-muted`        |
| Ghost       | transparent         | `--fg`      | none             | bg `--bg-muted`        |
| Destructive | `--danger`          | `#fff`      | none             | brightness `1.05`      |

Height `40px` default, `32px` small, `48px` large. Horizontal padding `16/12/20px`.
Focus ring: `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`.

## 8. Inputs

- Height `40px`, padding `0 12px`, radius `6`, border `1px var(--border)`.
- Background `var(--bg)`. Placeholder color `var(--fg-subtle)`.
- Focus: border `var(--accent)`, ring as buttons.

## 9. Motion

- **Durations:** `120ms` (state), `200ms` (transition), `400ms` (entry).
- **Easing:** `cubic-bezier(0.16, 1, 0.3, 1)` (out-expo) for entries; `ease-out` for state.
- Hover transitions: opacity, background, border only. **Never** width/height.
- Respect `prefers-reduced-motion` — disable all non-essential motion.

## 10. Iconography

- Use **Lucide** icons. Stroke `1.75px`, size `16/20/24`.
- Color inherits from text. No filled icons unless conveying state.

## 11. Imagery

- No stock photos. Use abstract geometric or product screenshots.
- All images lazy-loaded (`loading="lazy"`) except above-the-fold.
- Always provide `width` + `height` to prevent CLS.

## 12. SEO & Semantic Defaults

- One `<h1>` per page. Sections use `<h2>`/`<h3>`.
- All interactive elements need accessible names (aria-label, button text).
- Page title pattern: `{Page} — {site.shortName}` (home: `{site.name} — {tagline}`).
- All canonical URLs derived from `site.url` in `src/site.config.ts`.

## 13. Files & Conventions

- Brand strings (name, domain, tagline) **never** hardcoded — import from `src/site.config.ts`.
- Tailwind v4 only. Use `@theme` in `global.css` for tokens, no `tailwind.config.js`.
- Components: PascalCase `.astro`. Page slugs: kebab-case.
- All copy in US English.

## 14. Anti-patterns (do not do)

- ❌ Drop shadows on cards/sections.
- ❌ Gradient text without explicit design intent.
- ❌ Emoji as UI affordance (decorative use OK in marketing copy only).
- ❌ Custom font weights beyond 400/500/600/700.
- ❌ More than one accent color per page.
- ❌ Hardcoded color hex inside components.
- ❌ Layout shift on hover.
