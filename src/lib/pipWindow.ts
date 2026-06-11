/**
 * Document Picture-in-Picture wrapper for FTN.
 *
 * Lets a desktop Chromium user pop the transfer UI out into a small
 * always-on-top floating window so they can keep an eye on transfers
 * while working in another app.
 *
 * Design constraints (per docs/specs/document-pip.md):
 *
 *  1. Zero impact on existing flows. The feature is a strict additive
 *     layer: removing the new code returns the app to today's exact
 *     behavior. We MOVE existing DOM nodes — we do NOT clone, rebuild,
 *     or fork the UI tree.
 *  2. JS bindings (WebRTC handles, file refs, MediaStream refs, event
 *     listeners, closures over module-scope state) all survive the
 *     trip into PiP because the underlying JS objects don't change
 *     identity — only their parent does.
 *  3. Feature-detected at every entry point. On Firefox / Safari /
 *     mobile we silently no-op; the button is never unhidden.
 *  4. The PiP window's own title-bar close button is the primary exit
 *     affordance. We also expose programmatic `closePip()` for the
 *     in-tab "exit PiP" toggle button.
 *
 * The single load-bearing line in this file is:
 *
 *   pipWindow.document.body.append(...Array.from(mainEl.childNodes))
 *
 * Everything else (stylesheet cloning, placeholder swap, restore
 * handler, mutation-observer safety net) is defensive scaffolding
 * around that one move.
 */

type PipHandle = {
  /** The PiP window itself; null once closed. */
  window: Window | null;
  /** Programmatic close — triggers the same restore path as user-click. */
  close: () => void;
};

type OpenPipOptions = {
  /**
   * Element to move into the PiP window. The element ITSELF is
   * reparented — not its children — so CSS selectors scoped to this
   * element (e.g. `main > header`) keep matching inside the PiP doc.
   * Caller is responsible for choosing an element whose absence from
   * the origin doc is acceptable while PiP is open (e.g. <main>).
   */
  sourceEl: HTMLElement;
  /** Element displayed in the origin tab while PiP is open. */
  placeholderEl: HTMLElement;
  /** Initial PiP window dimensions (px). Browser may clamp to screen. */
  width: number;
  height: number;
  /**
   * Called after the restore completes (children moved back, placeholder
   * hidden). Use to flip the toggle button icon, reset state, etc.
   * NOT called if the open itself failed.
   */
  onClose: () => void;
  /**
   * Optional: page title to set on the PiP document. Defaults to the
   * origin title prefixed with "📺 ".
   */
  pipTitle?: string;
};

/**
 * Module-level handle so callers can ask "is PiP active right now?"
 * without us re-querying `documentPictureInPicture.window` (which is
 * cleared asynchronously after close).
 */
let active: PipHandle | null = null;

/**
 * Feature detection. Chromium 116+ on desktop only. Returns false on
 * Firefox, Safari, Chrome Android, iOS Safari, and any SSR context.
 */
export function isPipSupported(): boolean {
  if (typeof window === "undefined") return false;
  return "documentPictureInPicture" in window;
}

/**
 * True iff a PiP window is currently open and owned by us.
 */
export function isPipOpen(): boolean {
  return !!active?.window && !active.window.closed;
}

/**
 * Open the PiP window and move `sourceEl`'s children into it. Caller
 * is responsible for unhiding the placeholder text inside `placeholderEl`
 * via CSS — we just remove the `hidden` class.
 *
 * Returns a handle with a `close()` method; null on any failure
 * (popup blocker, unsupported browser, already-in-PiP, missing user
 * gesture). Failures are logged via console.warn and surfaced via
 * the optional toast hook.
 */
export async function openPip(opts: OpenPipOptions): Promise<PipHandle | null> {
  if (!isPipSupported()) {
    console.warn("[pip] Document PiP not supported in this browser");
    return null;
  }
  if (isPipOpen()) {
    // Already open — return the existing handle so callers can toggle.
    return active;
  }

  const docPip = (window as unknown as {
    documentPictureInPicture: {
      requestWindow(opts: { width: number; height: number }): Promise<Window>;
      window: Window | null;
    };
  }).documentPictureInPicture;

  let pipWindow: Window;
  try {
    pipWindow = await docPip.requestWindow({
      width: opts.width,
      height: opts.height,
    });
  } catch (err) {
    // Common rejections: not a user gesture, popup blocked, browser
    // refused. Don't crash — just log and let caller surface a toast.
    console.warn("[pip] requestWindow rejected:", err);
    return null;
  }

  // 1) Mark the PiP document so our :where(.pip-mode) CSS rules apply.
  //    Adding to documentElement (not body) so even the html element's
  //    own background/scroll behavior is influenced.
  pipWindow.document.documentElement.classList.add("pip-mode");

  // 2) Copy origin stylesheets into PiP. Both <link rel="stylesheet">
  //    and <style> tags — Astro inlines critical CSS as <style> and
  //    bundles the rest as a single <link>. We CLONE (not move) because
  //    the origin tab still needs its stylesheets for the placeholder UI.
  copyStylesheetsTo(pipWindow.document);

  // 3) Set the title so the OS window-switcher / taskbar shows something
  //    sensible. Default: "📺 <origin title>".
  pipWindow.document.title = opts.pipTitle ?? `📺 ${document.title}`;

  // 4) THE LOAD-BEARING MOVE. `append(sourceEl)` reparents the element
  //    itself into the PiP body — does NOT clone, does NOT rebuild.
  //    All event listeners, closures, WebRTC handles, MediaStream refs
  //    survive intact because the underlying JS object doesn't change
  //    identity, only its parent does.
  //
  //    Critical: we move the ELEMENT, not its children. Earlier v1
  //    moved childNodes which left an empty <main> in the PiP doc and
  //    broke every CSS rule scoped under `:where(.pip-mode) main { ... }`.
  //    By moving <main> itself, all our narrow-window styles (padding,
  //    hidden brand text, single-column role-picker, etc.) just work.
  //
  //    Remember origin position so we can put it back EXACTLY where it
  //    was — preserving order relative to siblings like the placeholder.
  const originParent = opts.sourceEl.parentNode;
  const originNextSibling = opts.sourceEl.nextSibling;
  if (!originParent) {
    console.warn("[pip] sourceEl has no parent — aborting");
    try { pipWindow.close(); } catch { /* ignore */ }
    return null;
  }
  pipWindow.document.body.appendChild(opts.sourceEl);

  // 5) Show the placeholder in the origin tab.
  opts.placeholderEl.classList.remove("hidden");

  // 6) Set up restore. Three independent triggers — any one of them
  //    runs restore() at most once (guarded by `restoreRan`):
  //      a) PiP window emits `pagehide` (normal close — X button, Esc,
  //         OS-level close, programmatic .close())
  //      b) PiP window's `unload` event (extra defense against rare
  //         browsers that fire one but not the other)
  //      c) MutationObserver watching the origin's source element —
  //         if our nodes never came back AND the placeholder is still
  //         showing AND `active.window.closed === true`, force restore
  //         on next tab focus
  let restoreRan = false;
  const restore = () => {
    if (restoreRan) return;
    restoreRan = true;
    try {
      // Put sourceEl back into its original position in the origin doc.
      // insertBefore handles both cases — null nextSibling appends at
      // the end (the documented behavior of insertBefore when ref-node
      // is null), so we always preserve the original sibling order.
      originParent.insertBefore(opts.sourceEl, originNextSibling);
    } catch (err) {
      console.warn("[pip] restore insertBefore failed:", err);
    }
    opts.placeholderEl.classList.add("hidden");
    active = null;
    try {
      opts.onClose();
    } catch (err) {
      console.warn("[pip] onClose callback threw:", err);
    }
  };

  pipWindow.addEventListener("pagehide", restore);
  pipWindow.addEventListener("unload", restore);

  // Defense in depth: if for any reason the pagehide/unload didn't
  // fire, the next time the user focuses the origin tab we re-check.
  const safetyNet = () => {
    if (active && active.window && active.window.closed && !restoreRan) {
      console.warn("[pip] safety-net restore fired (pagehide/unload missed)");
      restore();
    }
  };
  window.addEventListener("focus", safetyNet);
  pipWindow.addEventListener("pagehide", () => {
    window.removeEventListener("focus", safetyNet);
  });

  active = {
    window: pipWindow,
    close: () => {
      try {
        pipWindow.close();
      } catch (err) {
        console.warn("[pip] close() threw:", err);
      }
      // pagehide will fire and run restore.
    },
  };

  return active;
}

/**
 * Programmatic close of the active PiP window. No-op if none open.
 * The restore path runs via the PiP window's pagehide handler — we
 * don't restore here directly to keep the close path single-sourced.
 */
export function closePip(): void {
  if (!active) return;
  active.close();
}

/**
 * Clone every <link rel="stylesheet"> and <style> tag from the origin
 * document's <head> into the PiP document's <head>. Critical because
 * Tailwind v4 utilities, our @theme tokens, and any inline Astro-injected
 * CSS all live there.
 *
 * Stylesheets are CLONED (not moved) — origin tab still needs them for
 * the placeholder UI and for when the PiP closes and children return.
 */
function copyStylesheetsTo(targetDoc: Document): void {
  const head = targetDoc.head;
  const tags = document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>(
    'link[rel="stylesheet"], style',
  );
  tags.forEach((tag) => {
    // cloneNode(true) preserves attributes and inline content. We
    // import-then-append to satisfy strict cross-document parentage
    // checks (some browsers refuse appendChild on a foreign-doc node).
    const clone = targetDoc.importNode(tag, true);
    head.appendChild(clone);
  });

  // Watch for new <style> tags appearing in origin head (e.g. injected
  // by future code at runtime) and mirror them into PiP. Belt and
  // suspenders — practical chance of this firing is low for FTN but
  // costs nothing to install.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        if (
          el.tagName === "STYLE" ||
          (el.tagName === "LINK" && el.getAttribute("rel") === "stylesheet")
        ) {
          try {
            head.appendChild(targetDoc.importNode(el, true));
          } catch (err) {
            console.warn("[pip] failed to mirror new stylesheet:", err);
          }
        }
      });
    }
  });
  observer.observe(document.head, { childList: true });
  // Stop observing when the PiP window goes away — `targetDoc.defaultView`
  // is the PiP window itself; its `pagehide` is the most reliable signal.
  targetDoc.defaultView?.addEventListener("pagehide", () => observer.disconnect());
}
