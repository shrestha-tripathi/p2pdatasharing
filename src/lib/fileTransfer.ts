/**
 * File transfer protocol on top of an open RTCDataChannel.
 *
 * Wire format (over one channel):
 *   1. JSON  → file metadata: { kind: "meta", id, name, size, mime }
 *   2. JSON  → receiver reply: { kind: "resumeAnswer", id, offset }
 *      (sender waits for this before streaming bytes)
 *   3. N × ArrayBuffer → file payload, starting at `offset`, in order
 *   4. JSON  → optional: { kind: "done", id }  (advisory, future use)
 *
 * Receiver writes each chunk into the Origin Private File System (OPFS),
 * keyed by the file's UUID so partials survive disconnects within the
 * same browser session. On the next meta with the same `id`, the
 * receiver reports `offset = existingPartial.size` so the sender resumes
 * from there instead of restarting from byte 0.
 *
 * Backward compat: if a meta arrives WITHOUT an `id`, receiver behaves
 * as the old protocol (fresh file, no resume) and sender skips the
 * handshake wait.
 *
 * --- bug fix history ---
 * Earlier versions had a race condition where chunks arriving WHILE
 * beginReceive() was still awaiting async storage APIs got silently
 * dropped (rxMeta was still null). The result was a file written from
 * the wrong offset — looked complete but was corrupted. Fix:
 * `rxQueue` serializes ALL incoming messages through a tail promise,
 * guaranteeing meta init finishes before the first chunk is processed.
 */
import type { TeleportSession } from "./teleportSession";
import { createEmitter } from "./emitter";

export interface FileMeta {
  /** Stable UUID per logical file — used to resume partials. */
  id?: string;
  name: string;
  size: number;
  mime: string;
}

export interface TransferProgress {
  bytes: number;
  total: number;
  ratePerSec: number;
  etaSec: number;
  /** Bytes that were already on disk before this attempt (resume). */
  resumedFrom?: number;
}

export interface TransferEvents {
  sendStart: FileMeta & { resumedFrom?: number };
  sendProgress: TransferProgress;
  sendComplete: FileMeta;
  receiveStart: FileMeta & { resumedFrom?: number };
  receiveProgress: TransferProgress;
  receiveComplete: { meta: FileMeta; file: File };
  error: Error;
  /**
   * Fired when the receiver doesn't respond to our resume handshake within
   * the deadline (typically because the channel is unreliable mid-reconnect).
   * Sender falls back to restart-from-0; UI may want to warn.
   */
  resumeTimeout: { id: string };
}

const CHUNK_SIZE = 16 * 1024; // 16 KB — friendly RTCDataChannel default

/**
 * Resume-handshake timeout. Bumped from 5s → 12s because freshly-reconnected
 * TURN-relayed links can take 2-4s just to warm up the path. The previous
 * 5s window false-fired on exactly the slow networks where resume matters
 * most, regressing the user back to a from-byte-0 restart.
 */
const RESUME_ANSWER_TIMEOUT_MS = 12_000;

/**
 * `awaitChannelOpen` baseline timeout for retries — covers the common case
 * of a transient blip where the channel snaps back in seconds.
 */
const RECONNECT_TIMEOUT_NORMAL_MS = 30_000;

/**
 * Bumped reconnect timeout used when we recently saw a heartbeat stall
 * (layer 4) or a peer-connection failure. Those scenarios trigger a full
 * SDP renegotiation through the worker which routinely takes 45-90s on
 * mobile / TURN-relayed paths. Giving up at 30s threw away the recovery
 * window. 90s aligns with the worst-case observed reconnects in the wild.
 */
const RECONNECT_TIMEOUT_AFTER_STALL_MS = 90_000;

/** "Recently" window for considering a stall when picking the reconnect timeout. */
const STALL_RECENCY_WINDOW_MS = 60_000;

/** Crypto-quality UUID for file IDs. Falls back to Math.random for ancient browsers. */
function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class FileTransfer {
  readonly emitter = createEmitter<TransferEvents>();

  // Receiver state
  private rxMeta: FileMeta | null = null;
  private rxHandle: FileSystemWritableFileStream | null = null;
  private rxFileHandle: FileSystemFileHandle | null = null;
  private rxBytes = 0;
  private rxStartTime = 0;
  private rxLastEmit = 0;

  // Sender state: pending resumeAnswer resolvers, keyed by file id.
  private pendingResumes = new Map<string, (offset: number) => void>();

  /**
   * Tail of the message-processing chain. Serializes ALL incoming
   * messages so meta init can't be raced by the first chunks.
   */
  private rxQueue: Promise<void> = Promise.resolve();

  /**
   * Timestamp of the most recent heartbeat stall (layer 4) — used to
   * adaptively widen the reconnect timeout when we know the channel just
   * suffered a hard stall (those routinely take 45-90s to renegotiate).
   */
  private lastStallAt = 0;

  constructor(private session: TeleportSession) {
    session.emitter.on("channelMessage", (m) => {
      this.rxQueue = this.rxQueue
        .then(() => this.handleMessage(m.data))
        .catch((err) => {
          this.emitter.emit("error", err as Error);
        });
    });
    // Track heartbeat stalls so the retry loop knows to wait longer for
    // the SDP renegotiation to finish.
    session.emitter.on("stalled", () => {
      this.lastStallAt = Date.now();
    });
  }

  // ---------- SENDER ----------

  /** Send a single file. Auto-retries on transient channel close. */
  async send(file: File) {
    const meta: FileMeta = {
      id: makeId(),
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    };
    // Attempt up to N times; between attempts wait for channel to re-open.
    // Each attempt re-runs the handshake so we always resume from the
    // receiver's authoritative on-disk offset.
    const MAX_ATTEMPTS = 8;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.sendOnce(file, meta);
        return;
      } catch (e) {
        lastErr = e;
        // Gap D — explicit cleanup of the resume-handshake resolver so the
        // map doesn't bloat across retries (the timeout would catch it
        // eventually, but only after RESUME_ANSWER_TIMEOUT_MS extra ms).
        if (meta.id) this.pendingResumes.delete(meta.id);
        // If channel is definitely closed, wait for re-open (or timeout) and retry.
        const ch = this.session.channel;
        if (!ch || ch.readyState !== "open") {
          const ok = await this.awaitChannelOpen(this.computeReconnectTimeout());
          if (!ok) break; // gave up — bubble error
          continue;
        }
        // Channel still open but send threw for some other reason — abort.
        break;
      }
    }
    this.emitter.emit("error", lastErr as Error);
  }

  /**
   * Pick how long to wait for the channel to come back. If we just saw a
   * heartbeat stall (or are still inside the recency window), give the
   * full renegotiation 90s instead of the default 30s — observed mobile/TURN
   * reconnects routinely take 45-90s and we were giving up before they
   * finished. See Layer 3 spec, Gap A.
   */
  private computeReconnectTimeout(): number {
    const sinceStall = Date.now() - this.lastStallAt;
    if (this.lastStallAt > 0 && sinceStall < STALL_RECENCY_WINDOW_MS) {
      return RECONNECT_TIMEOUT_AFTER_STALL_MS;
    }
    return RECONNECT_TIMEOUT_NORMAL_MS;
  }

  /** Wait until the data channel is open again, or `timeoutMs` elapses. */
  private awaitChannelOpen(timeoutMs: number): Promise<boolean> {
    const ch = this.session.channel;
    if (ch && ch.readyState === "open") return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        resolve(ok);
      };
      const off = this.session.emitter.on("channelOpen", () => finish(true));
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /** Single attempt at sending `file`. Throws on channel failure. */
  private async sendOnce(file: File, meta: FileMeta) {
    // 1. metadata header
    this.session.send(JSON.stringify({ kind: "meta", ...meta }));

    // 2. wait for the receiver's resume-answer so we know where to start
    const resumeOffset = await this.awaitResumeAnswer(meta.id!);

    this.emitter.emit("sendStart", { ...meta, resumedFrom: resumeOffset });

    // 3. stream chunks from the resume offset
    const sliceFrom = resumeOffset > 0 && resumeOffset < file.size ? resumeOffset : 0;
    const stream = sliceFrom > 0 ? file.slice(sliceFrom).stream() : file.stream();
    const reader = stream.getReader();
    let offset = sliceFrom;
    const start = performance.now();
    let lastEmit = 0;

    const ch = this.session.channel!;

    // Handle edge case: receiver already has the complete file.
    if (sliceFrom >= file.size) {
      this.emitter.emit("sendProgress", {
        bytes: meta.size,
        total: meta.size,
        ratePerSec: 0,
        etaSec: 0,
        resumedFrom: sliceFrom,
      });
      await this.drainBuffer(ch);
      this.emitter.emit("sendComplete", meta);
      return;
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      let pos = 0;
      while (pos < value.byteLength) {
        const end = Math.min(pos + CHUNK_SIZE, value.byteLength);
        const slice = value.subarray(pos, end);
        // Copy into a fresh ArrayBuffer of exactly slice.byteLength.
        const buf = new ArrayBuffer(slice.byteLength);
        new Uint8Array(buf).set(slice);

        await this.waitForBuffer(ch);
        if (ch.readyState !== "open") {
          // Free the stream reader before throwing so it doesn't leak.
          try { reader.cancel(); } catch { /* ignore */ }
          throw new Error("data channel closed mid-transfer");
        }
        ch.send(buf);

        pos = end;
        offset += buf.byteLength;

        const now = performance.now();
        if (now - lastEmit > 100) {
          const elapsed = (now - start) / 1000;
          const sent = offset - sliceFrom;
          const rate = elapsed > 0 ? sent / elapsed : 0;
          const remaining = (meta.size - offset) / Math.max(rate, 1);
          this.emitter.emit("sendProgress", {
            bytes: offset,
            total: meta.size,
            ratePerSec: rate,
            etaSec: remaining,
            resumedFrom: sliceFrom,
          });
          lastEmit = now;
        }
      }
    }

    this.emitter.emit("sendProgress", {
      bytes: meta.size,
      total: meta.size,
      ratePerSec:
        (meta.size - sliceFrom) / Math.max((performance.now() - start) / 1000, 0.001),
      etaSec: 0,
      resumedFrom: sliceFrom,
    });

    // Wait until the outgoing buffer is fully drained so we know the
    // receiver has acked everything before we declare success.
    await this.drainBuffer(ch);
    this.emitter.emit("sendComplete", meta);
  }

  /** Send multiple files sequentially. */
  async sendMultiple(files: File[] | FileList) {
    for (const file of Array.from(files)) {
      await this.send(file);
      // Small breather so receiver's `handleMessage` queue can resolve
      // the previous completion before the next meta arrives.
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private waitForBuffer(ch: RTCDataChannel): Promise<void> {
    if (ch.bufferedAmount <= ch.bufferedAmountLowThreshold) return Promise.resolve();
    return new Promise((resolve) => {
      const handler = () => {
        ch.removeEventListener("bufferedamountlow", handler);
        resolve();
      };
      ch.addEventListener("bufferedamountlow", handler);
    });
  }

  private drainBuffer(ch: RTCDataChannel): Promise<void> {
    if (ch.bufferedAmount === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const tick = () => {
        if (ch.bufferedAmount === 0) resolve();
        else setTimeout(tick, 50);
      };
      tick();
    });
  }

  /**
   * Sender helper: wait for the receiver to tell us how many bytes it
   * already has under this file's id. Resolves with the offset; falls
   * back to 0 on timeout (legacy receiver — restart from scratch) and
   * emits a `resumeTimeout` event so the UI can warn.
   */
  private awaitResumeAnswer(id: string): Promise<number> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (offset: number, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        this.pendingResumes.delete(id);
        if (timedOut) this.emitter.emit("resumeTimeout", { id });
        resolve(offset);
      };
      this.pendingResumes.set(id, (offset) => finish(offset, false));
      setTimeout(() => finish(0, true), RESUME_ANSWER_TIMEOUT_MS);
    });
  }

  // ---------- RECEIVER ----------

  /**
   * Serialized message handler — every message (string or binary) flows
   * through here in order, never interleaved.
   */
  private async handleMessage(data: ArrayBuffer | string) {
    if (typeof data === "string") {
      try {
        const parsed = JSON.parse(data);
        if (parsed.kind === "meta") await this.beginReceive(parsed);
        else if (parsed.kind === "resumeAnswer") {
          // Sender side: a receiver told us where to resume from.
          const resolver = this.pendingResumes.get(parsed.id);
          if (resolver) resolver(Number(parsed.offset) || 0);
        }
      } catch {
        /* non-JSON string — ignore */
      }
      return;
    }
    if (!this.rxMeta || !this.rxHandle) {
      console.warn("[file-transfer] chunk before meta — dropped");
      return;
    }

    await this.rxHandle.write({
      type: "write",
      data,
      position: this.rxBytes,
    });
    this.rxBytes += data.byteLength;

    const now = performance.now();
    if (now - this.rxLastEmit > 100) {
      const elapsed = (now - this.rxStartTime) / 1000;
      const rate = elapsed > 0 ? this.rxBytes / elapsed : 0;
      const remaining = (this.rxMeta.size - this.rxBytes) / Math.max(rate, 1);
      this.emitter.emit("receiveProgress", {
        bytes: this.rxBytes,
        total: this.rxMeta.size,
        ratePerSec: rate,
        etaSec: remaining,
      });
      this.rxLastEmit = now;
    }

    if (this.rxBytes >= this.rxMeta.size) {
      await this.rxHandle.close();
      const file = await this.rxFileHandle!.getFile();
      const completedMeta = this.rxMeta;
      this.emitter.emit("receiveProgress", {
        bytes: completedMeta.size,
        total: completedMeta.size,
        ratePerSec:
          completedMeta.size /
          Math.max((performance.now() - this.rxStartTime) / 1000, 0.001),
        etaSec: 0,
      });
      this.emitter.emit("receiveComplete", { meta: completedMeta, file });

      // Reset for the next file in the stream.
      this.rxMeta = null;
      this.rxHandle = null;
      this.rxFileHandle = null;
      this.rxBytes = 0;
    }
  }

  private async beginReceive(meta: FileMeta) {
    // Quota check first.
    try {
      const est = await navigator.storage.estimate();
      const available = (est.quota ?? 0) - (est.usage ?? 0);
      if (available > 0 && meta.size > available) {
        this.emitter.emit(
          "error",
          new Error(
            `Not enough local storage for ${meta.name} (need ${meta.size} bytes, ${available} available).`,
          ),
        );
        return;
      }
    } catch {
      /* navigator.storage.estimate not available — proceed */
    }

    const root = await navigator.storage.getDirectory();
    let resumedFrom = 0;
    let opfsName: string;

    if (meta.id) {
      // Resume-capable path: name OPFS file by stable id so we can find partials.
      opfsName = meta.id;
      try {
        this.rxFileHandle = await root.getFileHandle(opfsName, { create: false });
        const existing = await this.rxFileHandle.getFile();
        if (existing.size > meta.size) {
          // Gap F — UUID collision or sender re-rolled with different content
          // for the same id. The partial cannot be trusted; wipe and restart.
          try {
            await root.removeEntry(opfsName);
          } catch {
            /* if remove fails, fall through — we'll overwrite from 0 below */
          }
          this.rxFileHandle = await root.getFileHandle(opfsName, { create: true });
        } else if (existing.size > 0 && existing.size < meta.size) {
          resumedFrom = existing.size;
        } else if (existing.size === meta.size) {
          // Already complete locally — accept and reply with full offset.
          // (Sender will skip ahead to size, then we'll emit complete from
          // the next zero-byte write cycle… actually we need to emit now.)
          this.session.send(JSON.stringify({ kind: "resumeAnswer", id: meta.id, offset: meta.size }));
          this.emitter.emit("receiveComplete", { meta, file: existing });
          // Don't open writable; nothing more to receive for this file.
          this.rxFileHandle = null;
          return;
        }
        // existing.size === 0 → fall through and start fresh write
      } catch {
        // No existing partial — create fresh
        this.rxFileHandle = await root.getFileHandle(opfsName, { create: true });
      }
    } else {
      // Legacy path (no id) — use a unique timestamp name, never resume.
      const baseName = meta.name.replace(/[\\/]/g, "_");
      opfsName = `${Date.now().toString(36)}_${baseName}`;
      this.rxFileHandle = await root.getFileHandle(opfsName, { create: true });
    }

    this.rxHandle = await this.rxFileHandle.createWritable({ keepExistingData: resumedFrom > 0 });
    this.rxMeta = meta;
    this.rxBytes = resumedFrom;
    this.rxStartTime = performance.now();
    this.rxLastEmit = 0;

    // Tell the sender where to resume from (or 0). Backward-compat note:
    // a legacy sender won't be waiting for this and will just ignore it.
    if (meta.id) {
      this.session.send(JSON.stringify({ kind: "resumeAnswer", id: meta.id, offset: resumedFrom }));
    }

    this.emitter.emit("receiveStart", { ...meta, resumedFrom });
  }
}

/**
 * Save a File to the user's actual disk. Uses the File System Access API
 * (`showSaveFilePicker`) when available so the user picks the destination
 * directly — no double-copy through Downloads. Falls back to a classic
 * anchor download when the API is missing (Firefox / Safari / iOS).
 *
 * MUST be called from a user gesture (click handler).
 */
export async function saveFileToDisk(file: File, suggestedName: string): Promise<"saved" | "downloaded" | "cancelled"> {
  const w = window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle> };
  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName });
      const writable = await handle.createWritable();
      await file.stream().pipeTo(writable);
      return "saved";
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return "cancelled";
      // any other error — fall back to download
    }
  }
  triggerDownload(file, suggestedName);
  return "downloaded";
}

/** Classic anchor-download fallback. */
export function triggerDownload(file: File, name: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
