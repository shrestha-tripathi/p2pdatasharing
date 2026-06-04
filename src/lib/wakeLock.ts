/**
 * Wake Lock manager — keeps the screen on during active file transfers
 * so the OS doesn't suspend the tab / drop WebRTC due to display sleep.
 *
 * Layered behavior:
 *  - acquire() on first active transfer (refcounted; safe to call from
 *    multiple concurrent sendStart/receiveStart events).
 *  - release() decrements the count; only releases the actual lock at zero.
 *  - The browser auto-releases on tab background by design — we re-acquire
 *    on visibilitychange === "visible" whenever count > 0.
 *
 * Graceful no-op on:
 *  - Older browsers without navigator.wakeLock
 *  - Permission denied / user gesture missing (we swallow the error)
 *
 * Browser support: Chrome 84+, Edge 84+, Safari 16.4+, Firefox 126+.
 */

let lock: WakeLockSentinel | null = null;
let activeCount = 0;
let listenerInstalled = false;

interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

const supported = (): boolean =>
  typeof navigator !== "undefined" && "wakeLock" in navigator;

const requestLock = async (): Promise<void> => {
  if (!supported() || lock) return;
  try {
    const sentinel = (await (
      navigator as Navigator & {
        wakeLock: { request(type: "screen"): Promise<WakeLockSentinel> };
      }
    ).wakeLock.request("screen")) as WakeLockSentinel;
    lock = sentinel;
    sentinel.addEventListener("release", () => {
      // The browser released it (e.g. tab hidden). Clear our ref so the
      // next visibility regain can re-acquire if we still need it.
      lock = null;
    });
  } catch {
    // Permission denied / no user gesture / etc. — silent, transfer still proceeds.
    lock = null;
  }
};

const installVisibilityListener = () => {
  if (listenerInstalled || typeof document === "undefined") return;
  listenerInstalled = true;
  document.addEventListener("visibilitychange", async () => {
    if (
      document.visibilityState === "visible" &&
      activeCount > 0 &&
      !lock
    ) {
      await requestLock();
    }
  });
};

/** Begin keeping the screen awake. Refcounted — call once per concurrent transfer. */
export async function acquireWakeLock(): Promise<void> {
  activeCount++;
  installVisibilityListener();
  await requestLock();
}

/** Stop keeping the screen awake when refcount hits zero. */
export async function releaseWakeLock(): Promise<void> {
  activeCount = Math.max(0, activeCount - 1);
  if (activeCount === 0 && lock) {
    try {
      await lock.release();
    } catch {
      /* already released */
    }
    lock = null;
  }
}

/** True if the screen is currently being kept awake by us. */
export function isWakeLockActive(): boolean {
  return activeCount > 0 && lock !== null;
}

/** Diagnostic — current refcount (exposed for debugging). */
export function wakeLockRefCount(): number {
  return activeCount;
}
