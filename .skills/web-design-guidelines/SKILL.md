---
name: web-design-guidelines
description: >
  UI/UX quality bar and layout patterns for the p2pdatesharing project.
  Load this before any frontend work — covers component anatomy, spacing,
  responsive rules, accessibility minimums, and anti-patterns. Mirrors the
  Vercel-style aesthetic captured in DESIGN.md.
---

# Web Design Guidelines (project-local)

These rules apply to **this repo only**. The authoritative visual contract
lives in `DESIGN.md` at the repo root. This skill is the procedural
companion — the "how" to DESIGN.md's "what."

## Always do, before writing UI

1. **Read `DESIGN.md`** end-to-end.
2. **Import brand strings from `src/site.config.ts`** — never hardcode.
3. **Reach for Tailwind v4 utilities first.** Custom CSS only when utilities
   genuinely don't express the intent.
4. **Use CSS variables for colors** (e.g. `bg-[var(--color-bg-muted)]`).
   Never inline hex.
5. **Test both color modes** — the OS-driven `prefers-color-scheme` toggle
   must look correct in light AND dark without per-component overrides.

## Layout primitives

- **Container:** `max-w-[1200px] mx-auto px-6 md:px-12`.
- **Section rhythm:** hero `py-20 md:py-32`, content `py-16 md:py-24`,
  inline blocks `py-8 md:py-12`.
- **Grid over flex** when items have intrinsic positions. Flex for inline rows.
- **Stack mobile-first:** default single column, expand at `md:` (`768px`).

## Component anatomy

A typical landing section:

```astro
<section class="border-t border-[var(--color-border)]">
  <div class="mx-auto max-w-[1200px] px-6 md:px-12 py-16 md:py-24">
    <p class="text-sm uppercase tracking-[0.06em] text-[var(--color-fg-subtle)]">
      Eyebrow
    </p>
    <h2 class="mt-3 text-3xl md:text-5xl font-semibold">Headline</h2>
    <p class="mt-4 max-w-2xl text-[var(--color-fg-muted)]">Supporting copy.</p>
    {/* Grid of cards, etc. */}
  </div>
</section>
```

## Buttons (canonical classes)

```html
<!-- Primary -->
<a class="inline-flex h-10 items-center rounded-lg bg-[var(--color-fg)]
          px-4 text-sm font-medium text-[var(--color-bg)]
          transition-opacity hover:opacity-90 no-underline">
  Action
</a>

<!-- Secondary -->
<a class="inline-flex h-10 items-center rounded-lg border
          border-[var(--color-border)] px-4 text-sm font-medium
          text-[var(--color-fg)] transition-colors
          hover:bg-[var(--color-bg-muted)] no-underline">
  Action
</a>
```

## Accessibility minimums

- All interactive elements: visible `:focus-visible` ring.
- Text contrast >= AA (DESIGN.md tokens already pass).
- Form inputs: associated `<label>` (or `aria-label` if visually hidden).
- Skip-to-content link on pages with nav.
- No animation > 400ms on essential UI flows.

## Anti-patterns (instant reject)

- ❌ Hex colors in `.astro` files
- ❌ Inline `style="..."` for layout
- ❌ Drop shadows on default cards
- ❌ `<div onclick>` instead of `<button>`
- ❌ Hardcoded brand strings
- ❌ Tailwind v3 patterns (`tailwind.config.js`, `@layer base` for tokens)
- ❌ Hover transitions on width/height (cause layout shift)

## Verify

After UI changes:
```bash
npm run build && npx astro check
```
Visually inspect at viewport widths: 375, 768, 1024, 1440.
