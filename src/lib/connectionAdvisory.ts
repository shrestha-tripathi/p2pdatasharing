/**
 * Connection advisory modal — shown on mobile when a transfer session
 * first reaches "connected" state. Tells the user to stay on the tab
 * to avoid OS-level tab suspension interrupting their transfer.
 *
 * Why this exists:
 *  - iOS Safari aggressively suspends background tabs (~30s)
 *  - In-app browsers (Instagram/WhatsApp/Facebook) are even worse (~10s)
 *  - Even Chrome Android throttles JS to 1s timers when hidden
 *  - Our WebRTC heartbeat (15s) + resume-from-offset (Layer 3+4) can
 *    RECOVER from a suspension, but reconnection is slower than
 *    "just don't suspend in the first place"
 *
 * Why post-connection (not on role-pick / invite-link):
 *  - Fires only when a transfer is ACTUALLY about to happen → zero
 *    false alarms (role-pick could happen and then the peer never joins)
 *  - Both sender + receiver reach `state === "connected"` within
 *    ~100ms of each other, so a single emitter hook fires on both
 *
 * Gating logic (3 layers, defense-in-depth):
 *  1. isMobileDevice() — desktop never sees this
 *  2. !shownThisSession (module flag) — reconnects don't re-fire
 *  3. !sessionStorage["ftn:bg-advisory-dismissed"] — same-session dismiss
 *  4. !localStorage["ftn:bg-advisory-forever"] — opt-out checkbox
 *
 * Storage semantics intentionally split:
 *  - sessionStorage = "I get it for this tab session" (clears on refresh
 *    so the user re-sees the advisory next time, in case they forgot)
 *  - localStorage = "I never want to see this" (only set when checkbox
 *    is ticked, sticky until storage cleared)
 */

const SESSION_KEY = "ftn:bg-advisory-dismissed";
const FOREVER_KEY = "ftn:bg-advisory-forever";

/**
 * Module-level flag: once we show the modal in a given page lifetime,
 * never show again even on reconnect/disconnect/reconnect cycles.
 * sessionStorage covers tab-level dismissal; this covers in-page state.
 */
let shownThisLifetime = false;

/**
 * Mobile detection. Combines UA sniff (covers iOS/iPadOS/Android) +
 * coarse pointer for unusual devices. Conservative: only true when a
 * strong mobile signal is present. Same logic as the LiveCaptionIt
 * isMobileDevice() helper but inlined to keep this module zero-dep.
 */
function isMobileDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  const uaIsMobile =
    /android|iphone|ipad|ipod|opera mini|iemobile|mobile safari/.test(ua) ||
    // iPadOS 13+ identifies as Mac — disambiguate via touch points
    (/macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  const coarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const narrowViewport = (window.innerWidth || 0) < 768;
  // UA hit OR (coarse + narrow) — defends against desktop touchscreens
  // (e.g. Surface laptops report coarse pointer but viewport is large).
  return uaIsMobile || (coarsePointer && narrowViewport);
}

function isSessionDismissed(): boolean {
  try { return sessionStorage.getItem(SESSION_KEY) === "1"; } catch { return false; }
}

function isForeverDismissed(): boolean {
  try { return localStorage.getItem(FOREVER_KEY) === "1"; } catch { return false; }
}

function markSessionDismissed(): void {
  try { sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* private mode */ }
}

function markForeverDismissed(): void {
  try { localStorage.setItem(FOREVER_KEY, "1"); } catch { /* private mode */ }
}

/**
 * Build the modal DOM and append to <body>. Returns refs so the caller
 * can manage lifecycle (positioning + removal).
 */
function buildModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "ftn-bg-advisory-backdrop";

  const modal = document.createElement("div");
  modal.className = "ftn-bg-advisory-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "ftn-bg-advisory-title");
  modal.innerHTML = `
    <h3 id="ftn-bg-advisory-title" class="ftn-bg-advisory-title">📱 Stay on this tab during transfer</h3>
    <p class="ftn-bg-advisory-body">iOS Safari and in-app browsers can pause this tab after ~30 seconds in the background, which interrupts your transfer.</p>
    <p class="ftn-bg-advisory-body ftn-bg-advisory-body-strong">Keep this tab visible and your screen unlocked until the transfer is done.</p>
    <label class="ftn-bg-advisory-checkbox">
      <input type="checkbox" class="ftn-bg-advisory-checkbox-input" />
      <span>Don't show this again</span>
    </label>
    <div class="ftn-bg-advisory-actions">
      <button type="button" class="ftn-bg-advisory-ok">Got it</button>
    </div>
  `;

  document.body.append(backdrop, modal);
  return { backdrop, modal };
}

/**
 * Show the advisory modal. No-op if any gate is already closed.
 * Returns true if shown, false if skipped (gating).
 */
export function maybeShowConnectionAdvisory(): boolean {
  if (typeof window === "undefined") return false;
  if (shownThisLifetime) return false;
  if (!isMobileDevice()) return false;
  if (isSessionDismissed()) return false;
  if (isForeverDismissed()) return false;
  // Don't double-mount (paranoia — gates above should prevent this).
  if (document.querySelector(".ftn-bg-advisory-modal")) return false;

  shownThisLifetime = true;
  const ui = buildModal();

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    const checkbox = ui.modal.querySelector<HTMLInputElement>(".ftn-bg-advisory-checkbox-input");
    if (checkbox?.checked) {
      markForeverDismissed();
    }
    markSessionDismissed();
    ui.backdrop.classList.add("ftn-bg-advisory-leaving");
    ui.modal.classList.add("ftn-bg-advisory-leaving");
    setTimeout(() => {
      ui.backdrop.remove();
      ui.modal.remove();
    }, 200);
    window.removeEventListener("keydown", onKey);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      dismiss();
    }
  };

  ui.modal.querySelector<HTMLButtonElement>(".ftn-bg-advisory-ok")?.addEventListener(
    "click",
    dismiss,
  );
  // Backdrop click = dismiss (matches every modal everywhere). Doesn't
  // tick the checkbox — user needs to click that explicitly.
  ui.backdrop.addEventListener("click", dismiss);
  window.addEventListener("keydown", onKey);

  // Focus the OK button so Enter immediately dismisses + screen readers
  // announce the modal title.
  ui.modal.querySelector<HTMLButtonElement>(".ftn-bg-advisory-ok")?.focus();

  return true;
}

/**
 * Debug helper for support — "type this in DevTools and refresh" to
 * see the advisory again.
 */
if (typeof window !== "undefined") {
  (window as unknown as { __resetConnectionAdvisory: () => void }).__resetConnectionAdvisory = () => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* */ }
    try { localStorage.removeItem(FOREVER_KEY); } catch { /* */ }
    shownThisLifetime = false;
    console.info("[advisory] Reset — next connection will re-show.");
  };
}
