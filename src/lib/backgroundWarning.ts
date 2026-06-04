/**
 * Background-warning manager — fires a desktop Notification when the user
 * backgrounds the tab during an active transfer, then auto-dismisses when
 * they return to the foreground (or the transfer completes).
 *
 * Pairs with wakeLock.ts as Layer 2 of the background-survival strategy:
 *  - Layer 1 (wakeLock)   → keeps screen on so OS doesn't sleep
 *  - Layer 2 (this)       → tells user if/when tab gets backgrounded
 *  - Layer 3 (resume)     → recovers transfer if it actually drops
 *  - Layer 4 (heartbeat)  → detects drops fast
 *
 * Permission strategy: we request once on the first tracked transfer. If
 * the user denies / dismisses, every subsequent call silently no-ops —
 * the rest of the app keeps working.
 */

let activeTransferCount = 0;
let permissionRequested = false;
let currentNotification: Notification | null = null;
let listenerInstalled = false;

const supportsNotifications = (): boolean =>
  typeof window !== "undefined" && "Notification" in window;

const fireBackgroundNotification = () => {
  if (!supportsNotifications() || Notification.permission !== "granted") return;
  // Dismiss any prior one — the `tag` would replace it, but explicit close
  // avoids a brief double-notification on some platforms.
  dismissNotification();
  try {
    const n = new Notification("Transfer running in background", {
      body: "Tap to return to the tab and keep your transfer fast.",
      icon: `${import.meta.env.BASE_URL || "/"}icon-192.png`,
      tag: "wfs-bg-transfer",
      // Don't latch — user can swipe away if they don't care.
      requireInteraction: false,
      silent: true,
    });
    n.onclick = () => {
      try {
        window.focus();
        // For PWAs installed as standalone, bring the tab forward.
        if ("clients" in self && typeof window !== "undefined") {
          window.focus();
        }
      } catch {
        /* best effort */
      }
      n.close();
      currentNotification = null;
    };
    currentNotification = n;
  } catch {
    /* notification API blocked / private mode / etc. */
    currentNotification = null;
  }
};

const dismissNotification = () => {
  if (!currentNotification) return;
  try {
    currentNotification.close();
  } catch {
    /* already closed */
  }
  currentNotification = null;
};

const installListener = () => {
  if (listenerInstalled || typeof document === "undefined") return;
  listenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    // Only react if there's an in-flight transfer the user might miss.
    if (activeTransferCount === 0) {
      dismissNotification();
      return;
    }
    if (document.visibilityState === "hidden") {
      fireBackgroundNotification();
    } else {
      // User returned — drop the notification, transfer continues normally.
      dismissNotification();
    }
  });
};

/**
 * Request notification permission once, lazily. Called inside a user-gesture
 * chain (sendStart/receiveStart originate from button taps). Safe to call
 * repeatedly — only the first invocation actually prompts.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!supportsNotifications()) return "denied";
  if (permissionRequested) return Notification.permission;
  permissionRequested = true;
  if (Notification.permission === "default") {
    try {
      return await Notification.requestPermission();
    } catch {
      return "denied";
    }
  }
  return Notification.permission;
}

/**
 * Begin tracking a transfer. Refcounted so multiple concurrent transfers
 * stack safely. Also lazily installs the visibilitychange listener and
 * requests notification permission on the first call.
 */
export function trackBackgroundTransfer(): void {
  installListener();
  activeTransferCount++;
  // Fire-and-forget — permission prompt only shows once across the session.
  void requestNotificationPermission();
}

/**
 * Stop tracking. Dismisses any pending notification when the refcount
 * reaches zero (so the user doesn't get a stale "running" toast after
 * their transfer actually finished).
 */
export function untrackBackgroundTransfer(): void {
  activeTransferCount = Math.max(0, activeTransferCount - 1);
  if (activeTransferCount === 0) {
    dismissNotification();
  }
}

/** Force-dismiss the notification (e.g. on unload / hard error). */
export const clearBackgroundNotification = dismissNotification;

/** Diagnostic — exposed for debugging in DevTools. */
export function backgroundTransferRefCount(): number {
  return activeTransferCount;
}
