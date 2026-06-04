/**
 * File transfer protocol on top of an open RTCDataChannel.
 *
 * Wire format (over one channel):
 *   1. JSON string  → file metadata: { kind: "meta", name, size, mime }
 *   2. N × ArrayBuffer → file payload, in order
 *   (sender may then start another file by sending another meta header)
 *
 * Receiver writes each chunk into the Origin Private File System (OPFS),
 * so RAM stays flat even for 100 GB transfers.
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
  name: string;
  size: number;
  mime: string;
}

export interface TransferProgress {
  bytes: number;
  total: number;
  ratePerSec: number;
  etaSec: number;
}

export interface TransferEvents {
  sendStart: FileMeta;
  sendProgress: TransferProgress;
  sendComplete: FileMeta;
  receiveStart: FileMeta;
  receiveProgress: TransferProgress;
  receiveComplete: { meta: FileMeta; file: File };
  error: Error;
}

const CHUNK_SIZE = 16 * 1024; // 16 KB — friendly RTCDataChannel default

export class FileTransfer {
  readonly emitter = createEmitter<TransferEvents>();

  // Receiver state
  private rxMeta: FileMeta | null = null;
  private rxHandle: FileSystemWritableFileStream | null = null;
  private rxFileHandle: FileSystemFileHandle | null = null;
  private rxBytes = 0;
  private rxStartTime = 0;
  private rxLastEmit = 0;

  /**
   * Tail of the message-processing chain. Serializes ALL incoming
   * messages so meta init can't be raced by the first chunks.
   */
  private rxQueue: Promise<void> = Promise.resolve();

  constructor(private session: TeleportSession) {
    session.emitter.on("channelMessage", (m) => {
      this.rxQueue = this.rxQueue
        .then(() => this.handleMessage(m.data))
        .catch((err) => {
          this.emitter.emit("error", err as Error);
        });
    });
  }

  // ---------- SENDER ----------

  /** Send a single file. */
  async send(file: File) {
    const meta: FileMeta = {
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    };
    this.emitter.emit("sendStart", meta);

    // 1. metadata header
    this.session.send(JSON.stringify({ kind: "meta", ...meta }));

    // 2. stream chunks
    const reader = file.stream().getReader();
    let offset = 0;
    const start = performance.now();
    let lastEmit = 0;

    const ch = this.session.channel!;

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
        ch.send(buf);

        pos = end;
        offset += buf.byteLength;

        const now = performance.now();
        if (now - lastEmit > 100) {
          const elapsed = (now - start) / 1000;
          const rate = elapsed > 0 ? offset / elapsed : 0;
          const remaining = (meta.size - offset) / Math.max(rate, 1);
          this.emitter.emit("sendProgress", {
            bytes: offset,
            total: meta.size,
            ratePerSec: rate,
            etaSec: remaining,
          });
          lastEmit = now;
        }
      }
    }

    this.emitter.emit("sendProgress", {
      bytes: meta.size,
      total: meta.size,
      ratePerSec:
        meta.size / Math.max((performance.now() - start) / 1000, 0.001),
      etaSec: 0,
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
    // Unique OPFS name so multiple files in one session don't collide.
    const baseName = meta.name.replace(/[\\/]/g, "_");
    const opfsName = `${Date.now().toString(36)}_${baseName}`;
    this.rxFileHandle = await root.getFileHandle(opfsName, { create: true });
    this.rxHandle = await this.rxFileHandle.createWritable();
    this.rxMeta = meta;
    this.rxBytes = 0;
    this.rxStartTime = performance.now();
    this.rxLastEmit = 0;

    this.emitter.emit("receiveStart", meta);
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
