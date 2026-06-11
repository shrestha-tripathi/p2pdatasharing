/**
 * One-step onboarding pointer for the Document Picture-in-Picture
 * feature on /transfer.
 *
 * Minimal version of the `zero-dep-onboarding-tour` pattern — no
 * Next/Back/step counter, just a spotlight + popover with a single
 * dismiss button. Fires once per user (localStorage-gated) on first
 * visit to /transfer on a desktop Chromium browser.
 *
 * Why this is a separate module from any future multi-step tour:
 *  - Single-purpose: only the PiP feature
 *  - Tiny: ~120 LOC vs ~250 for the full tour
 *  - Independently revertable: delete this file + remove init wiring
 *    and the PiP feature still works fine (just less discoverable)
 *
 * The whole module no-ops on:
 *  - SSR (no `window`)
 *  - Browsers without Document PiP support (so the tour never points
 *    at a button that's hidden)
 *  - Returning users (localStorage sticky bit)
 *  - Pages where the anchor element doesn't exist
 */

const SEEN_KEY = "ftn:pip-tour-seen-v1";
const ANCHOR_SELECTOR = "#pip-toggle";
/**
 * Delay before the pointer fires. Gives the existing first-paint UI
 * (role-picker, paired-devices banner, PiP-button feature detection)
 * time to settle so the tour doesn't compete with anything else.
 */
const FIRST_RUN_DELAY_MS = 2500;

function hasBeenSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode / strict iframe → treat as "seen" so we never
    // pester users whose storage we can't persist to anyway.
    return true;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode — accept the small annoyance of re-firing next session */
  }
}

/**
 * Build the spotlight + popover DOM and append to <body>. Returns refs
 * so the orchestrator can position + later remove them.
 */
function buildTourUi() {
  const backdrop = document.createElement("div");
  backdrop.className = "ftn-pip-tour-backdrop";

  const spotlight = document.createElement("div");
  spotlight.className = "ftn-pip-tour-spotlight";

  const popover = document.createElement("div");
  popover.className = "ftn-pip-tour-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-modal", "true");
  popover.setAttribute("aria-labelledby", "ftn-pip-tour-title");
  popover.innerHTML = `
    <button class="ftn-pip-tour-close" aria-label="Dismiss tour" type="button">×</button>
    <h3 id="ftn-pip-tour-title" class="ftn-pip-tour-title">Floating window mode</h3>
    <p class="ftn-pip-tour-body">Pop out into a small always-on-top window — keep your transfer visible while you work in another app or call.</p>
    <div class="ftn-pip-tour-actions">
      <button class="ftn-pip-tour-got-it" type="button">Got it</button>
    </div>
  `;

  document.body.append(backdrop, spotlight, popover);
  return { backdrop, spotlight, popover };
}

/**
 * Position the spotlight box around the anchor and the popover below
 * (or above, if there's no room below). Clamped to viewport so we
 * never paint off-screen.
 */
function positionUi(
  ui: { spotlight: HTMLElement; popover: HTMLElement },
  anchor: HTMLElement,
): void {
  const rect = anchor.getBoundingClientRect();
  const pad = 8;
  Object.assign(ui.spotlight.style, {
    top: `${rect.top - pad}px`,
    left: `${rect.left - pad}px`,
    width: `${rect.width + pad * 2}px`,
    height: `${rect.height + pad * 2}px`,
  });

  const popoverWidth = 300;
  const viewportPad = 12;
  // Center horizontally on anchor, then clamp inside viewport.
  let left = rect.left + rect.width / 2 - popoverWidth / 2;
  left = Math.max(viewportPad, Math.min(window.innerWidth - popoverWidth - viewportPad, left));

  // Place below if there's room (≥180px), else above.
  const conservativeHeight = 180;
  const spaceBelow = window.innerHeight - rect.bottom;
  const top =
    spaceBelow >= conservativeHeight + 20
      ? rect.bottom + 16
      : Math.max(viewportPad, rect.top - conservativeHeight - 16);

  Object.assign(ui.popover.style, {
    top: `${top}px`,
    left: `${left}px`,
    width: `${popoverWidth}px`,
  });
}

/**
 * Show the tour. Safe to call when not first-run (returns false).
 * Forceable for "replay" buttons in help dialogs.
 */
export function startPipTour(opts?: { force?: boolean }): boolean {
  if (typeof window === "undefined") return false;
  if (!opts?.force && hasBeenSeen()) return false;
  // Don't double-mount.
  if (document.querySelector(".ftn-pip-tour-popover")) return false;

  const anchor = document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
  if (!anchor) return false;
  // Don't point at a hidden anchor — happens if feature-detection
  // didn't unhide the button (unsupported browser).
  if (anchor.classList.contains("hidden")) return false;

  const ui = buildTourUi();

  let dismissed = false;
  const finish = () => {
    if (dismissed) return;
    dismissed = true;
    markSeen();
    ui.backdrop.classList.add("ftn-pip-tour-leaving");
    ui.popover.classList.add("ftn-pip-tour-leaving");
    setTimeout(() => {
      ui.backdrop.remove();
      ui.popover.remove();
      ui.spotlight.remove();
    }, 200);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition);
    window.removeEventListener("keydown", onKey);
  };

  const reposition = () => positionUi(ui, anchor);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      finish();
    }
  };

  ui.popover.querySelector<HTMLButtonElement>(".ftn-pip-tour-got-it")?.addEventListener(
    "click",
    finish,
  );
  ui.popover.querySelector<HTMLButtonElement>(".ftn-pip-tour-close")?.addEventListener(
    "click",
    finish,
  );
  // Click anywhere on the dimmed backdrop also dismisses — matches the
  // muscle memory of every modal everywhere.
  ui.backdrop.addEventListener("click", finish);

  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("keydown", onKey);

  positionUi(ui, anchor);
  // Second pass after layout settles — popover height is unknown until
  // it paints, so the first positionUi() uses a conservative estimate.
  requestAnimationFrame(() => positionUi(ui, anchor));

  return true;
}

/**
 * Entry point — call once from /transfer's init script. Bails silently
 * if anything would make the tour pointless (SSR, returning user,
 * unsupported browser, missing anchor).
 */
export function initPipTour(): void {
  if (typeof window === "undefined") return;
  if (hasBeenSeen()) return;

  setTimeout(() => {
    // Re-check inside the timer — the user might have done something
    // in the meantime that obviates the tour (e.g. opened DevTools and
    // manually triggered the PiP).
    const anchor = document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
    if (!anchor || anchor.classList.contains("hidden")) return;
    startPipTour();
  }, FIRST_RUN_DELAY_MS);

  // Debug helper for support — "type this in DevTools and refresh."
  (window as unknown as { __resetPipTour: () => void }).__resetPipTour = () => {
    try {
      localStorage.removeItem(SEEN_KEY);
    } catch {
      /* private mode */
    }
    console.info("[pip-tour] Reset — refresh to see it again.");
  };
}
