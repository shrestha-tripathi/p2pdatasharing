# SPEC — Document Picture-in-Picture for FTN

**Status:** Draft (awaiting user sign-off)
**Date:** 2026-06-11
**Author:** JARVIS @ Shrestha's request
**Scope estimate:** 3 commits, ~400 LOC total, zero new deps

---

## Problem

FTN today is a **full desktop browser tab** experience. Users who want to
share files while doing other work either:

1. Keep the tab focused (everything else hidden behind it)
2. Alt-tab away (transfer continues but they can't watch progress / drop
   more files without context-switching back)
3. Snap the window to one side (steals significant screen real estate
   for a UI that only needs ~400px wide while a transfer is in flight)

A floating-window-on-top would let the user keep the transfer panel
visible above whatever they're actually working on (a video call,
their code editor, a document) — exactly the use case Document
Picture-in-Picture was designed for.

## Goals

- **Float the entire transfer UX in a small always-on-top window**
  triggered by an explicit user action on `/transfer`
- Reuse the existing transfer UI verbatim — **no parallel React
  component**; same DOM, same JS, same WebRTC session
- **Zero impact on existing flows** — the feature is a strict
  additive layer. Removing the new code returns the app to today's
  exact behavior
- **Discoverable but unobtrusive** — first-time desktop visitors learn
  about it via a brief one-step tour pointer; returning users see a
  small icon button in the header

## Non-goals (explicitly out of scope for v1)

- **Mobile support** — Document PiP doesn't exist on iOS/Android.
  Detect `documentPictureInPicture` presence and hide the button on
  unsupported browsers (no fallback UI, no "your browser doesn't
  support this" message — silent)
- **Different / dedicated PiP UI** — we are NOT building a separate
  mobile-styled component tree. Same DOM moves into the PiP window.
  Mobile-feel comes for free because the existing UI already
  responsively collapses below 480px (header stacks, drop zone
  takes full width, etc.)
- **Re-rendering inside PiP** — the existing JS keeps running because
  it's still in the original document realm; we MOVE the DOM nodes
  into the PiP window using `appendChild`, not clone them
- **Persistence across tab close** — closing the PiP window or the
  origin tab tears everything down (same as today's tab-close behavior)
- **Custom PiP window chrome** — we get whatever the browser provides
  (title bar with close button, no menu bar). Don't try to fake one
- **Multi-window support** — only one PiP window can exist per tab
  per spec; we don't try to work around this
- **Auto-popout on connection** — never auto-open the PiP. Always
  user-initiated via the button or tour pointer (Document PiP API
  REQUIRES a user gesture anyway; auto-open would throw)
- **Auto-snap geometry** — start with the browser default size (the
  browser remembers the last user-resized size across sessions
  automatically; no need for us to manage this)

## UX flow

```
USER ON /transfer (desktop Chrome/Edge 116+)
   │
   ├── First visit
   │     │
   │     └── 2.5s after page settles, tour pointer appears next to
   │         PiP button: "Pop out into a floating window — keeps
   │         your transfer on top while you work. [Got it]"
   │         (one step, dismissible, never repeats)
   │
   └── Sees the new icon button in the header (top-right area)
         │
         └── Click button (user gesture)
              │
              ├── If documentPictureInPicture unavailable: no-op (button hidden)
              │
              └── Request PiP window:
                    width = 400px (matches our mobile-collapse threshold)
                    height = 640px (fits transfer + chat + queue
                    without scroll for typical sessions)
                    │
                    ├── Move the existing <main> contents into PiP
                    │   doc body — JS bindings preserved
                    │
                    ├── Copy our stylesheets (link + inline) into
                    │   PiP doc <head> so Tailwind v4 utilities work
                    │
                    ├── Swap the button icon to "exit PiP"
                    │
                    ├── Show a 2-line placeholder in the origin tab
                    │   ("📺 Floating in PiP window — click to bring back")
                    │
                    └── On PiP window close (X, Esc, OS-level close):
                          ├── Move <main> children BACK into origin doc
                          ├── Remove placeholder
                          └── Restore button icon to "pop out"
```

## Why this is safe (the "minimal changes" argument)

| Risk | Mitigation |
|---|---|
| Breaking existing JS (event listeners, WebRTC handles, file refs) | We MOVE DOM nodes, not clone — `pipWindow.document.body.append(...mainEl.childNodes)`. All bound listeners, file objects, MediaStream refs survive because the underlying JS objects haven't changed |
| Tailwind utilities not applying in PiP | Copy the `<link rel="stylesheet">` and any `<style>` tags from origin `document.head` into `pipWindow.document.head` on open (one-time per PiP open) |
| User on Firefox / Safari / mobile sees a broken button | Feature-detect `"documentPictureInPicture" in window`; if absent, the button is `hidden` from initial render — never reaches the DOM in the visible tree |
| Tour annoys returning users | One-step tour gated on `localStorage.getItem("ftn:pip-tour-seen-v1")`; sticky after dismiss |
| PiP window crashes / OS kills it / user closes tab while PiP is open | Browser fires `pagehide` on PiP doc → our handler restores DOM via move-back; defensive: also run a `MutationObserver` on origin's placeholder slot — if PiP is gone and our nodes never came back, force-restore on next tab focus |
| Re-entry: clicking PiP button while already in PiP | Button toggles — second click calls `window.documentPictureInPicture.window.close()` |
| User somehow ends up with floating window AND tab both showing the UI (DOM duplication bug) | Move operation is one-shot per open; node identity guarantees nodes can only exist in one parent. Adding to PiP automatically removes from origin |
| Subsequent reload while PiP open | PiP window closes when origin doc unloads (browser-enforced); on reload, tab boots fresh as today |
| Tour anchor (button) renders but is `hidden` because feature unsupported | `initPipTour()` checks support FIRST; bails before scheduling the popup |

## Implementation plan — 3 commits

### Commit 1: PiP toggle button + DOM move/restore (the core)

**Files touched:**

- `src/pages/transfer.astro` — add the icon button in the header (just
  after the existing "Reload" button), with a `hidden` class default.
  Add a `<div id="pip-placeholder" class="hidden">…</div>` after `<main>`
  for the "floating in PiP" message.
- `src/lib/pipWindow.ts` — NEW. Three exports:
  - `isPipSupported(): boolean`
  - `openPip(mainEl: HTMLElement, opts: {width, height, onClose}): Promise<Window | null>`
  - `closePip(): void`

**Behavior:**

- On boot, `isPipSupported()` checks `"documentPictureInPicture" in window`;
  if true, button is unhidden
- Button click → `openPip(document.querySelector("main")!, {width: 400, height: 640, onClose: ...})`
- `openPip` does:
  1. `const pipWindow = await window.documentPictureInPicture.requestWindow({width, height})`
  2. Copy `<link rel="stylesheet">` and `<style>` tags from origin's
     `document.head` into `pipWindow.document.head` (clone them — don't move,
     origin still needs them for the placeholder)
  3. Set `pipWindow.document.title = "FTN — floating"`
  4. `pipWindow.document.body.append(...Array.from(mainEl.childNodes))`
     (one-shot move)
  5. Show the placeholder in origin doc
  6. Wire `pipWindow.addEventListener("pagehide", restore)` where
     `restore` moves the children back: `mainEl.append(...Array.from(pipWindow.document.body.childNodes))`
  7. Return the `pipWindow` ref so the caller can later `.close()` it
- `closePip()` just calls `documentPictureInPicture.window?.close()` —
  the `pagehide` handler then runs the restore

**Defensive corners:**

- Wrap everything in try/catch — if `requestWindow` throws (popup blocker,
  no user gesture, already-in-PiP), surface a one-line toast via the
  existing `addWarning()` helper and leave the UI unchanged
- The `pagehide` handler must be idempotent — `MutationObserver` on the
  origin's `<main>` plus a tab-focus listener both call `restore()` if the
  PiP window's children are gone but origin still shows placeholder
- Style the PiP-mode body with a single `pip-mode` class on
  `pipWindow.document.documentElement` — gives us a CSS hook for tiny
  tweaks like hiding our normal `<header>` brand/Reload buttons inside
  PiP (they're redundant — PiP has its own close button in the title bar)

### Commit 2: CSS adjustments for narrow PiP window

**Files touched:**

- `src/styles/global.css` — append a `:where(.pip-mode) { … }` block
  with:
  - `body { padding: 0.5rem; max-width: 100%; }`
  - `main { padding: 0 !important; max-width: 100% !important; }`
  - Hide elements that don't make sense in a 400×640 floating window:
    page footer, header brand text (keep close-pip button + status pill),
    blog/CTA/marketing sections
  - Force `flex-col` on rows that are `sm:flex-row` (already responsive
    below 640px, but PiP starts at 400 so this is just belt-and-
    suspenders)

**No JS changes here** — pure CSS, all gated by the `.pip-mode` class
which only exists on the PiP document root. Origin tab is unaffected.

### Commit 3: One-step onboarding pointer + persistent localStorage

**Files touched:**

- `src/lib/pipTour.ts` — NEW. Minimal version of the
  `zero-dep-onboarding-tour` pattern with only ONE step (no Next/Back/
  step counter — just a popover with title, body, and an "X / Got it"
  dismiss).
- Wire `initPipTour()` into `transfer.astro`'s init script. Bails
  immediately if:
  1. `!isPipSupported()` (mobile / Firefox / Safari)
  2. `localStorage.getItem("ftn:pip-tour-seen-v1") === "1"`
  3. The button element isn't found (defensive)

**Tour copy:**

> **Floating window mode**
> Pop out into a small always-on-top window — keep your transfer
> visible while you work in another app or call.
>
> [Got it]

**Behavior:**

- Fires 2.5s after `DOMContentLoaded` (gives the existing role-picker
  / paranoid-toggle / paired-banner UI time to settle so the pointer
  doesn't compete with first-paint UI for attention)
- Spotlight + popover anchored to the new PiP button using the same
  `box-shadow: 0 0 0 9999px rgba(0,0,0,0.55)` trick from the skill
- Esc / click-outside / "Got it" all dismiss + set the seen bit
- Replay debug helper: `window.__resetPipTour()` for support

## Wire-protocol changes

**None.** This is purely a window-management change on top of the
existing transfer UI. Sender/receiver/signaling/file-transfer protocols
all unchanged. No new WS messages, no DO state, no Worker deploy needed.

## Affected files summary

```
src/pages/transfer.astro         (+ ~25 LOC: button HTML, init wiring, placeholder div)
src/lib/pipWindow.ts             (+ ~150 LOC: NEW — open/close + style copy + restore logic)
src/lib/pipTour.ts               (+ ~120 LOC: NEW — one-step pointer)
src/styles/global.css            (+ ~50 LOC: NEW :where(.pip-mode) block)
docs/specs/document-pip.md       (this file)
```

Total: ~345 LOC across 4 source files + 1 spec doc. Zero new npm deps.
Zero changes to `teleportSession.ts`, `fileTransfer.ts`, `chat.ts`,
the Worker, or any wire protocol. **The riskiest line of code in this
PR is the `pipWindow.document.body.append(...Array.from(mainEl.childNodes))`
in commit 1.** Everything else is icing.

## Browser support matrix

| Browser | Document PiP | Button shown? | Tour shown? |
|---|---|---|---|
| Chrome desktop 116+ | ✅ | ✅ | ✅ |
| Edge desktop 116+ | ✅ | ✅ | ✅ |
| Firefox desktop | ❌ | ❌ (hidden) | ❌ (skipped) |
| Safari desktop | ❌ (only `<video>` PiP) | ❌ (hidden) | ❌ (skipped) |
| Chrome Android | ❌ | ❌ (hidden) | ❌ (skipped) |
| iOS Safari | ❌ | ❌ (hidden) | ❌ (skipped) |

~70% of FTN's expected desktop audience gets the feature (per
caniuse.com Document PiP support). Mobile users (already a minority on
file-sharing apps; they prefer AirDrop / Nearby Share) get no change.

## Failure modes table

| Mode | User sees | Recovery |
|---|---|---|
| `requestWindow()` rejects (popup blocked) | One-line toast: "Your browser blocked the floating window. Allow pop-ups for this site." | Click button again after allowing |
| PiP window closes unexpectedly mid-transfer | UI snaps back into origin tab, transfer continues (DOM nodes restored, JS state unchanged) | None needed — transparent recovery |
| User closes origin tab while PiP open | Browser closes PiP automatically; WebRTC session torn down (same as today's tab-close) | Re-pair |
| User refreshes origin tab while PiP open | Browser closes PiP automatically | Fresh load, PiP button visible again |
| Stylesheet copy missed a `<style>` tag (Astro inlines some) | UI in PiP renders unstyled / partial | Detect via `MutationObserver` on origin head; new `<style>` tags get cloned into PiP on the fly. Belt-and-suspenders: log a warning so we can detect in QA |
| Tour fires on a page where button isn't rendered yet (timing race) | Pointer floats over wrong area | `initPipTour()` re-queries the anchor on each render attempt; bails silently if missing after 3 attempts |

## Open questions (please answer before I ship)

1. **PiP button icon** — I'm planning to use Lucide `picture-in-picture-2`
   (the rectangle-with-mini-rectangle glyph) inlined as SVG. ✓ or
   prefer something else?

2. **PiP window size** — 400 × 640 is my default (matches our
   responsive collapse breakpoint; fits transfer + chat without
   scroll). Want me to start smaller (e.g. 360 × 540 for less
   screen-real-estate intrusion)?

3. **Tour wording** — propose:
   > "Pop out into a small always-on-top window — keep your transfer
   > visible while you work in another app or call."
   Counter-propose if you want different copy.

4. **Should the PiP button be visible from page load, or only after
   the user picks a role?** My instinct: from page load (lets the
   user pre-pop-out before pairing) but I can gate it on the
   transfer-panel being visible if you prefer.

5. **Header layout in PiP mode** — when collapsed into 400px, the
   existing header (brand + Reload button + theme toggle + new PiP
   button) is cramped. In `.pip-mode` should I hide the brand text
   and theme toggle? My default plan: hide brand text + theme toggle
   + Reload, show only "exit PiP" close button + connection-status
   pill. The PiP window's own title bar provides the close affordance.

## Sign-off

Please answer the 5 open questions (or just say "ship as proposed").
Then I commit in this order:

1. `feat(pip): Document Picture-in-Picture support — float transfer UI in always-on-top window`
2. `style(pip): narrow-window CSS adjustments for 400px PiP layout`
3. `feat(pip): one-step onboarding pointer for first-time desktop visitors`

Each commit independently revertable. After all three: `live in ~90s`.
