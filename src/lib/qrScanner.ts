/**
 * QR scanner with native-first, jsQR fallback.
 *
 * Strategy:
 *  1. Try `window.BarcodeDetector` (native, zero KB) — Chrome/Edge/Samsung
 *     Internet on Android, Safari 17+ on iOS. Covers ~85% of mobile users.
 *  2. If unavailable or returns nothing for a few frames, lazy-import jsQR
 *     (~43 KB gzipped) and use it on the same getUserMedia stream.
 *
 * Both paths read frames from a hidden <video> + offscreen <canvas>. The
 * caller passes a target <video> to render the preview into so we don't
 * have to know about the UI layout.
 *
 * Returns a controller you can stop() any time. Calls onResult(text) once
 * a valid scan happens (continuous frames are sampled at ~15fps).
 */

export interface ScannerController {
  /** Stop scanning and release the camera. Idempotent. */
  stop(): void;
}

export interface ScannerOptions {
  /** Target <video> element. Camera preview gets drawn here. */
  video: HTMLVideoElement;
  /** Called once when a QR is decoded. Scanner auto-stops after this. */
  onResult: (text: string) => void;
  /** Called with a human-readable error (camera denied, no camera, etc.) */
  onError?: (message: string) => void;
}

type AnyWindow = typeof window & {
  BarcodeDetector?: new (opts?: { formats?: string[] }) => {
    detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
  };
};

const PROBE_INTERVAL_MS = 67; // ~15fps — enough for QR, cheap on battery.

export async function startQrScanner(opts: ScannerOptions): Promise<ScannerController> {
  const { video, onResult, onError } = opts;
  let stopped = false;
  let stream: MediaStream | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  // Lazy state for the jsQR fallback path
  let jsQR: typeof import("jsqr").default | null = null;

  // Require a secure context. getUserMedia rejects on http: anyway, but the
  // error you get from the browser is opaque ("NotAllowedError"). Be explicit.
  if (!window.isSecureContext) {
    onError?.("Camera access requires HTTPS. (You're on http://, so the browser blocks it.)");
    return { stop: () => {} };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    onError?.("This browser doesn't support camera access.");
    return { stop: () => {} };
  }

  // Pick the rear camera when available (matters on phones).
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    const name = e?.name ?? "Error";
    if (name === "NotAllowedError" || name === "SecurityError") {
      onError?.("Camera permission denied. Allow camera access for this site and try again.");
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      onError?.("No camera found on this device.");
    } else if (name === "NotReadableError") {
      onError?.("Camera is in use by another app. Close it and try again.");
    } else {
      onError?.(`Couldn't start the camera: ${e?.message ?? name}`);
    }
    return { stop: () => {} };
  }

  video.srcObject = stream;
  video.setAttribute("playsinline", "true"); // iOS — keep inline, don't fullscreen
  video.muted = true;
  try {
    await video.play();
  } catch {
    /* iOS sometimes throws on autoplay; the user gesture that opened the
       scanner already counts, so this usually succeeds. Swallow the rest. */
  }

  // Lazy canvas for the jsQR path. BarcodeDetector can read straight from
  // the <video>, no canvas needed — only allocate this when we fall back.
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  const ensureCanvas = () => {
    if (canvas) return;
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  };

  // Native detector (if present)
  const w = window as AnyWindow;
  const NativeBarcode = w.BarcodeDetector;
  // BarcodeDetector exists on the prototype on some browsers but throws when
  // constructed with formats it doesn't actually support. Try/catch the ctor.
  let native: InstanceType<NonNullable<AnyWindow["BarcodeDetector"]>> | null = null;
  if (NativeBarcode) {
    try {
      native = new NativeBarcode({ formats: ["qr_code"] });
    } catch {
      native = null;
    }
  }

  const finish = (text: string) => {
    if (stopped) return;
    stop(); // close camera ASAP after a hit
    onResult(text);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
  };

  const tick = async () => {
    if (stopped) return;
    if (video.readyState < 2 /* HAVE_CURRENT_DATA */) {
      probeTimer = setTimeout(tick, PROBE_INTERVAL_MS);
      return;
    }

    // 1) Try native first
    if (native) {
      try {
        const codes = await native.detect(video);
        const first = codes?.[0]?.rawValue;
        if (first) return finish(first);
      } catch {
        // Native blew up on this frame — disable and fall back to jsQR.
        native = null;
      }
    }

    // 2) jsQR fallback
    if (!native) {
      if (!jsQR) {
        try {
          // Vite-friendly dynamic import; only fetched when needed.
          const mod = await import("jsqr");
          jsQR = mod.default;
        } catch (err) {
          onError?.("Failed to load QR decoder.");
          stop();
          return;
        }
      }
      ensureCanvas();
      if (canvas && ctx) {
        const w2 = video.videoWidth;
        const h2 = video.videoHeight;
        if (w2 > 0 && h2 > 0) {
          // Downscale to ≤640px on longest side — jsQR's perf scales linearly
          // with pixel count, and QR codes only need ~150px to decode.
          const scale = Math.min(1, 640 / Math.max(w2, h2));
          canvas.width = Math.round(w2 * scale);
          canvas.height = Math.round(h2 * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, {
            inversionAttempts: "dontInvert",
          });
          if (code?.data) return finish(code.data);
        }
      }
    }

    probeTimer = setTimeout(tick, PROBE_INTERVAL_MS);
  };

  // Kick off the loop
  probeTimer = setTimeout(tick, PROBE_INTERVAL_MS);

  return { stop };
}
