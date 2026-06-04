---
name: tailwind-4-docs
description: >
  Tailwind CSS v4 reference for this project. Load this before any Tailwind
  work — v4 differs significantly from v3 (no config file, @theme directive,
  CSS-first config, new @utility/@variant APIs). LLMs trained pre-2025 will
  default to v3 patterns; this skill corrects that.
---

# Tailwind v4 — Quick Reference

This project uses **Tailwind CSS v4** via `@tailwindcss/vite`. The old v3
mental model (config file, `theme.extend`, `@layer`) **does not apply**.

## Setup recap (already done)

- `astro.config.mjs` includes `tailwindcss()` Vite plugin.
- `src/styles/global.css` starts with `@import "tailwindcss";`.
- Layout imports the stylesheet once.

## Theme tokens — `@theme`

All design tokens live inside `@theme { ... }` in `global.css`. Tailwind
turns each `--color-*`, `--font-*`, `--spacing-*` etc. into utilities
**automatically**. No `tailwind.config.js`.

```css
@theme {
  --color-accent: #0070f3;          /* enables: bg-accent, text-accent, ... */
  --font-sans: "Inter", sans-serif; /* enables: font-sans                   */
  --spacing-18: 4.5rem;             /* enables: p-18, m-18, w-18, ...       */
}
```

Override per `@media (prefers-color-scheme: dark)` by re-declaring `@theme`
inside the media query (this is what we do for dark mode).

## Arbitrary values with CSS vars

To reference a CSS variable inline:

```html
<div class="bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]">
```

If a token is registered via `@theme` as `--color-bg-muted`, Tailwind also
generates `bg-bg-muted` automatically — either form is fine, but the
`var(--...)` form is explicit and survives token renames better in v4.

## New directives

| Directive       | Purpose                                                 |
|-----------------|---------------------------------------------------------|
| `@theme`        | Declare design tokens (replaces `theme.extend`).        |
| `@utility name` | Define a custom utility (replaces `@layer utilities`).  |
| `@variant name` | Define a custom variant (replaces v3 plugins).          |
| `@custom-variant`| Compose existing variants.                             |

Example custom utility:
```css
@utility content-grid {
  display: grid;
  grid-template-columns: [full-start] minmax(1rem, 1fr)
                         [content-start] min(100% - 2rem, 1200px) [content-end]
                         minmax(1rem, 1fr) [full-end];
}
```

## Dark mode

v4 ships **no built-in `dark:` strategy by default**. We rely on
`prefers-color-scheme` via the `@media` override of `@theme`. If we ever
want a manual toggle, add:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

…then toggle a `.dark` class on `<html>`.

## v3 → v4 cheat-sheet

| v3                               | v4                                          |
|----------------------------------|---------------------------------------------|
| `tailwind.config.js`             | `@theme {}` in CSS                          |
| `@tailwind base/components/utilities` | `@import "tailwindcss";`               |
| `theme.extend.colors.x = ...`    | `--color-x: ...;` inside `@theme`           |
| `@layer utilities { .foo {...} }`| `@utility foo { ... }`                      |
| plugin: `addVariant('peer-focus')` | `@variant peer-focus (...)`               |
| `darkMode: 'class'`              | `@custom-variant dark (&:where(.dark, .dark *))` |
| `content: ['./src/**/*']`        | autodetected; no config needed              |

## Common pitfalls

- **Don't create `tailwind.config.js`** — v4 will ignore it and you'll
  think changes aren't applying.
- **Don't use `@layer base { :root { --x: ... } }`** for tokens; use `@theme`.
- **Don't import `@tailwind base;`** — that's v3 syntax. Single `@import "tailwindcss";`.
- **Container queries** are first-class: `@container` + `@sm:`/`@md:` variants
  (different from viewport variants).

## Verify

```bash
npm run dev   # check utilities apply, no console warnings
npm run build # ensure production CSS includes your tokens
```
