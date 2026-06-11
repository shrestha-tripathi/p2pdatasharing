/**
 * Native share-sheet support for received files.
 *
 * Wraps `navigator.share()` with feature detection and graceful
 * fallbacks. Lets a receiver forward a freshly-received file into the
 * OS share sheet — on iOS this is the only practical way to get the
 * file into Photos / Messages / Mail without a 5-tap Files-app detour.
 *
 * Browser support landscape (Jun 2026):
 *
 * | Browser              | navigator.share() | files in share?     |
 * |----------------------|-------------------|---------------------|
 * | iOS Safari 15+       | ✅                | ✅                  |
 * | iPadOS Safari 15+    | ✅                | ✅                  |
 * | Chrome Android 75+   | ✅                | ✅                  |
 * | Chrome desktop 89+   | ✅ (text/url)     | ✅ (PWA-installed)  |
 * | Edge desktop 93+     | ✅                | ✅                  |
 * | Safari macOS 12.1+   | ✅                | ⚠️ inconsistent    |
 * | Firefox (all)        | ❌                | ❌                  |
 *
 * Strategy: ALWAYS feature-detect with `navigator.canShare({files})`
 * BEFORE showing the button (some browsers expose `navigator.share`
 * but reject file payloads — `canShare` is the only correctness signal).
 *
 * Why this exists separate from `saveFileToDisk`:
 *  - Different intent (forward vs persist locally)
 *  - Different surface area (share never touches OPFS or disk)
 *  - Different failure modes (cancellation is normal, not an error)
 */

/**
 * True iff the current browser can share THIS specific file via the
 * native share sheet. Must be called per-file because some browsers
 * gate file sharing on MIME type (e.g. Safari rejects sharing files
 * with empty .type, which is exactly what we receive over WebRTC
 * since the Blob constructor doesn't auto-detect MIME).
 *
 * Returns false on:
 *  - Browsers without navigator.share (Firefox, old Safari)
 *  - Browsers without canShare (older Chromium)
 *  - File types the OS won't accept (rare; macOS Safari is the only
 *    one I've seen reject otherwise-valid file payloads)
 *  - SSR contexts (no `navigator`)
 */
export function canShareFile(file: File): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.share !== "function") return false;
  // canShare is a separate feature-check from share — older Chromium
  // shipped share() without canShare(). If canShare is absent, we
  // optimistically assume share works and let it throw if it doesn't.
  if (typeof navigator.canShare !== "function") return true;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Outcome of a share attempt. Distinguishes "user cancelled" (normal,
 * silent) from "actually broke" (surface to user) so callers can
 * react correctly.
 */
export type ShareResult =
  | { status: "shared" }
  | { status: "cancelled" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

/**
 * Open the OS share sheet for the given file. Caller is responsible
 * for having previously checked `canShareFile(file) === true` — but
 * we double-check inside for safety (returns "unsupported" cleanly
 * instead of throwing).
 *
 * On iOS Safari this pops the native share sheet (AirDrop, Messages,
 * Mail, Photos, every installed app). On Chrome Android it pops the
 * Android share sheet. On supported desktop browsers it pops the OS
 * share sheet (Windows 10+, macOS 12.1+).
 *
 * The user-cancellation case (tap outside the sheet, hit Cancel) is
 * returned as `status: "cancelled"` — NOT as an error. Browsers throw
 * an `AbortError` for cancellation; we catch and translate.
 */
export async function shareFile(file: File, suggestedName?: string): Promise<ShareResult> {
  if (!canShareFile(file)) {
    return { status: "unsupported" };
  }

  // Some browsers (macOS Safari) silently strip the filename from a
  // shared File if it differs from `file.name`. If the caller passed
  // a `suggestedName` that differs (e.g. preserving the folder-path
  // basename through our wire protocol), reconstruct a fresh File
  // with the right name so the receiving app shows it correctly.
  let toShare = file;
  if (suggestedName && suggestedName !== file.name) {
    try {
      toShare = new File([file], suggestedName, {
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified,
      });
      // Re-verify the renamed File is still shareable — some platforms
      // gate on type+name combos we can't predict.
      if (!canShareFile(toShare)) {
        toShare = file; // fall back to original
      }
    } catch {
      toShare = file;
    }
  }

  try {
    await navigator.share({
      files: [toShare],
      // `title` is hint metadata for the share sheet — most apps ignore
      // it for file payloads but it doesn't hurt to provide. We keep
      // the body fields empty so apps don't pre-fill share text with
      // our brand string (which would look like spam on Messages/Mail).
      title: toShare.name,
    });
    return { status: "shared" };
  } catch (err) {
    // AbortError = user dismissed the share sheet. This is the normal
    // path when someone opens it then changes their mind. NOT an error.
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "cancelled" };
    }
    // NotAllowedError = called outside a user gesture (caller bug)
    // or permissions policy denied it. Surface as actual error.
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
