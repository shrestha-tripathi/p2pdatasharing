# SPEC — Connection-progress indicator (filling bar during ICE handshake)

**Status:** Draft (awaiting user sign-off)
**Date:** 2026-06-11
**Author:** JARVIS @ Shrestha's request
**Scope estimate:** 1 commit, ~80 LOC total, zero new deps, zero behavior change

---

## Problem

After the ICE-candidate exchange completes (~milliseconds), there's a
**5-15 second silent wait** while the browser actually negotiates the
data-channel through STUN/TURN. During that window the UX shows:

```
🟡  Connecting…
    Establishing peer connection — this usually takes a few seconds.
```

That's it. No spinner, no progress, no countdown. Users see a static
yellow dot for what feels like forever and assume the app is stuck
or broken — especially the first ~3-4 seconds when nothing visibly
moves.

In the worst case (symmetric NAT / hostile network), the silent wait
can stretch to 8-12 seconds before our adaptive relay-only retry
kicks in (per commit `e8dae14`). Through that whole window there's
zero forward-motion signal.

## Goals

- **Visible progress signal** during `state === "connecting"`
- **Deterministic** — bar reflects actual time remaining against the
  known `CONNECT_TIMEOUT_MS = 15_000` ceiling so users have a real
  sense of "we're 40% through the budget"
- **Honest** — when the bar hits 100% we either declare success or
  hand off to the adaptive relay retry (NOT just reset to 0 and
  pretend we have more time)
- **Reset cleanly on retry** — when adaptive relay-only retry rebuilds
  the peer (`retryAsRelayOnly`), the bar restarts at 0 with the
  fresh 15s budget
- **Zero impact on existing flows** — purely additive UI; remove the
  new code = exact today's behavior

## Non-goals (explicit)

- **Not a spinner.** Spinners signal "indeterminate, no progress info."
  We HAVE timing info, so a determinate bar is correct.
- **Not a countdown timer** ("12 seconds remaining"). False precision
  — most users connect at 1-3s and the timer text would feel like
  pressure or worry. The bar's fill ratio communicates the same info
  visually without making each second feel slow.
- **Not changing the timeout value.** 15s stays; this is purely UX.
- **Not adding sub-states inside "connecting".** The existing
  `setStatus("connecting", "…")` detail text already tells users
  what's happening; we just augment with the bar.
- **Not animating the dot.** Already considered — a pulse on the
  yellow dot conflicts with the more informative bar. Pick one.
- **Not showing on other states.** Bar is `connecting`-only. `signaling`
  is normal "waiting for peer" (no time pressure), `connected` is done,
  `failed` is over.

## UX design

### Visual

Thin (3px) horizontal bar **below the status detail text**, inside
the existing status card. Animates fill from 0% → 100% over the
15-second timeout window. Uses brand accent color so it reads as
"good progress" not "warning."

```
┌─────────────────────────────────────────────────────────┐
│ 🟡  Connecting…                            SENDER       │
│     Establishing peer connection — this usually takes   │
│     a few seconds.                                      │
│     ████████████░░░░░░░░░░░░░░░░░░░░░░░░               │  ← new
│                                                         │
│     [Disconnect]                                        │
└─────────────────────────────────────────────────────────┘
```

### Behavior

| Phase | Bar state |
|---|---|
| Enter `connecting` state | Bar appears, fill animates 0% → 100% over 15s with `linear` easing |
| Reach `connected` before 15s | Bar finishes at current % then fades out 300ms after card flips to "connected" |
| Hit 15s timeout, retry triggers | Bar resets to 0%, restarts animation for the new 15s window |
| Exit to `failed` | Bar fades out immediately |
| Exit to `signaling` (renegotiate / network switch) | Bar fades out (renegotiation has its own status copy and no fixed budget) |
| Exit to `disconnected` | Bar fades out |

### Adaptive retry interaction

The trickiest case. Sequence on hostile network:

```
T+0    user clicks Send → state=signaling → bar HIDDEN
T+0.5  ICE candidates exchanged → state=connecting → bar APPEARS @ 0%
T+8    bar @ 53% — ICE proactively fires "failed"
T+8    retryAsRelayOnly() kicks in → state=signaling briefly → bar resets/hides
T+8.1  rebuilt peer → state=connecting → bar APPEARS @ 0% again
T+9    bar @ 6% — TURN handshake completes → state=connected → bar finishes + fades
```

The bar restarts whenever we re-enter `connecting` from a different
state. Each entry gets a fresh 15s budget. No tricky resumption math.

### Honesty when bar hits 100%

If the bar fills completely without connection, we have two clean
outcomes (both already exist today, no new logic needed):

1. **Adaptive retry fires** → state flips to `signaling` (per the
   retry path), bar disappears, user sees "Reconnecting via relay…"
   status — they understand it's still trying
2. **No relay candidate to retry with** → state flips to `failed`,
   bar fades out, user sees the existing failure UI with actionable
   message

The bar reaching 100% is information ("first attempt didn't connect
in the typical window"), and the next state transition explains what
happens next. Bar doesn't "lie" or pretend to keep filling.

## Implementation plan — 1 commit

**Files touched:**

1. **`src/pages/transfer.astro`** — 3 small changes:
   - Add `<div id="status-progress" class="hidden …">` inside the
     status card, right after `#status-detail`
   - Update the `setStatus()` helper (line 1509) to call a new helper
     `updateProgressBar(state)` that handles show/hide/reset/animate
   - The helper uses CSS-driven animation via class toggle (no JS
     setInterval) — animation duration matches `CONNECT_TIMEOUT_MS`

2. **`src/styles/global.css`** — append ~25 lines:
   - `.status-progress-bar` track + `.status-progress-fill` inner bar
   - `@keyframes status-progress-fill` 0%→100% over 15s linear
   - `.status-progress-fill.is-filling` triggers the animation
   - `prefers-reduced-motion` falls back to a single-step fill (or
     just a static 50% bar — communicates "in progress" without motion)

**Why CSS animation, not JS setInterval:**
- Zero JS overhead during connect — animation runs on the compositor
  thread
- No drift / no risk of setInterval surviving past the connect window
- Animation duration is exact (Chrome / Safari / FF all keep CSS
  animations within ±50ms of declared duration)
- Resets cleanly via `animation-name: none → animation-name: status-progress-fill`
  trigger pattern (or just removing/re-adding the class)

**Why a 3px bar, not 6-8px:**
- Visually present but not loud — this is supporting info, not the
  primary affordance
- Matches the existing minimalist status-card vibe (no other "heavy"
  UI elements there)
- 3px is exactly enough to be visible without pulling focus from
  the dot+label which remains the primary status indicator

## What's the failure mode?

| Scenario | Behavior |
|---|---|
| `CONNECT_TIMEOUT_MS` changes in future | CSS animation duration is hardcoded to 15s. **Pitfall:** if someone bumps the constant to 20s, the bar finishes "early" at 75% of the new budget. Mitigation: use a CSS custom property `--connect-timeout: 15s` defined in the JS layer via `setProperty()` at mount, so the bar duration is always in sync with the actual timeout constant |
| User backgrounds tab during connect | Browser throttles JS but CSS animations continue on the compositor — bar keeps animating, which is correct (the actual ICE handshake also continues during background; only setTimeout slows down) |
| `prefers-reduced-motion` | Bar shows static 50% fill with brand color, no animation. Communicates "in progress" without vestibular stress |
| Connection succeeds at 1s (typical) | Bar reaches ~7%, then fades out as card flips green |
| User on flaky network with multiple retries | Each retry resets bar to 0 — predictable and honest |
| `setStatus` called with same state twice | New helper is idempotent — checks if already in `connecting` and doesn't re-trigger the animation reset |

## Affected files summary

```
src/pages/transfer.astro     (+ ~25 LOC: new <div>, updated setStatus, helper)
src/styles/global.css        (+ ~25 LOC: bar styles + keyframes + reduced-motion)
docs/specs/connect-progress-bar.md  (this file)
```

Total: ~50 LOC across 2 source files. Zero new npm deps. Zero changes
to `teleportSession.ts`, `fileTransfer.ts`, `chat.ts`, the Worker, or
any wire protocol. Zero risk to existing flows — bar is purely
additive UI gated on `state === "connecting"`.

## Open questions

1. **Color of the bar** — my plan: `--color-accent` (cyan/brand) since
   "connecting in progress" is neutral-positive, not warning. The dot
   stays yellow because that's the established status convention. ✓
   or use `--color-warning` (yellow, matches the dot)?

2. **Should the bar also appear during initial `signaling`?** My
   default: no — `signaling` has unbounded duration ("waiting for peer
   to join" could be seconds or minutes depending on when the other
   peer opens the link). A 15s bar would lie there. Bar is
   `connecting`-only.

3. **Subtle progress label?** E.g. "~10s typical" next to the bar.
   My default: no — adds visual clutter and the bar itself communicates
   timing. Add only if you want it.

4. **Tooltip on the bar?** Hover → "Establishing peer connection (up
   to 15s)". My default: yes, for accessibility (`<div role="progressbar"
   aria-valuemin="0" aria-valuemax="15" aria-valuenow="..."` set
   periodically). Slightly more code but doable.

## Sign-off

Answer the 4 open questions (or "ship as proposed") and I commit:

```
feat(ux): show progress bar during ICE handshake — eliminate "is it stuck?" anxiety
```

Single commit, fully revertable. After ship: `live in ~90s`.
