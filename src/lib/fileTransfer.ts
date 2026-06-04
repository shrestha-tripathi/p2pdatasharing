/**
 * File transfer protocol on top of an open RTCDataChannel.
 *
 * Wire format (over one channel):
 *   1. JSON string  → file metadata: { name, size, mime }
 *   2. N × ArrayBuffer → file payload, in order
 *   (then sender opens a new transfer by sending another JSON header)
 *
 * Receiver writes each chunk into the Origin Private File System (OPFS),
 * so RAM stays flat even for 100 GB transfers.
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
  /** Sender: file accepted by transport, transfer beginning. */
  sendStart: FileMeta;
  /** Sender: progress update (throttled to animation frame). */
  sendProgress: TransferProgress;
  /** Sender: file fully shipped. */
  sendComplete: FileMeta;
  /** Receiver: metadata arrived. */
  receiveStart: FileMeta;
  /** Receiver: progress update. */
  receiveProgress: TransferProgress;
  /** Receiver: full file written to OPFS — file is the saved File handle. */
  receiveComplete: { meta: FileMeta; file: File };
  error: Error;
}

const CHUNK_SIZE = 16 * 1024; // 16 KB — matches WebRTC's friendly default

export class FileTransfer {
  readonly emitter = createEmitter<TransferEvents>();

  // Receiver state
  private rxMeta: FileMeta | null = null;
  private rxHandle: FileSystemWritableFileStream | null = null;
  private rxFileHandle: FileSystemFileHandle | null = null;
  private rxBytes = 0;
  private rxStartTime = 0;
  private rxLastEmit = 0;

  constructor(private session: TeleportSession) {
    session.emitter.on("channelMessage", (m) => this.onMessage(m.data));
  }

  // ---------- SENDER ----------

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

      // value may be larger than CHUNK_SIZE — slice it.
      let pos = 0;
      while (pos < value.byteLength) {
        const slice = value.subarray(pos, Math.min(pos + CHUNK_SIZE, value.byteLength));
        await this.waitForBuffer(ch);
        // sliced view — must copy to send a clean ArrayBuffer
        ch.send(slice.slice().buffer);
        pos += slice.byteLength;
        offset += slice.byteLength;

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
      ratePerSec: meta.size / Math.max((performance.now() - start) / 1000, 0.001),
      etaSec: 0,
    });
    this.emitter.emit("sendComplete", meta);
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

  // ---------- RECEIVER ----------

  private async onMessage(data: ArrayBuffer | string) {
    if (typeof data === "string") {
      try {
        const parsed = JSON.parse(data);
        if (parsed.kind === "meta") await this.beginReceive(parsed);
      } catch {
        /* ignore non-JSON strings */
      }
      return;
    }
    if (!this.rxMeta || !this.rxHandle) return;

    try {
      await this.rxHandle.write({ type: "write", data, position: this.rxBytes });
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
        this.emitter.emit("receiveProgress", {
          bytes: this.rxMeta.size,
          total: this.rxMeta.size,
          ratePerSec: this.rxMeta.size / Math.max((performance.now() - this.rxStartTime) / 1000, 0.001),
          etaSec: 0,
        });
        this.emitter.emit("receiveComplete", { meta: this.rxMeta, file });
        this.rxMeta = null;
        this.rxHandle = null;
        this.rxFileHandle = null;
        this.rxBytes = 0;
      }
    } catch (err) {
      this.emitter.emit("error", err as Error);
    }
  }

  private async beginReceive(meta: FileMeta) {
    // OPFS quota check first.
    try {
      const est = await navigator.storage.estimate();
      const available = (est.quota ?? 0) - (est.usage ?? 0);
      if (available > 0 && meta.size > available) {
        this.emitter.emit(
          "error",
          new Error(
            `Not enough local storage for ${meta.name} (need ${meta.size} bytes, have ${available} available).`,
          ),
        );
        return;
      }
    } catch {
      // Some browsers/contexts don't expose estimate(); proceed.
    }

    const root = await navigator.storage.getDirectory();
    // Sanitize file name — OPFS rejects path separators.
    const safeName = meta.name.replace(/[\\/]/g, "_");
    this.rxFileHandle = await root.getFileHandle(safeName, { create: true });
    this.rxHandle = await this.rxFileHandle.createWritable();
    this.rxMeta = meta;
    this.rxBytes = 0;
    this.rxStartTime = performance.now();
    this.rxLastEmit = 0;

    this.emitter.emit("receiveStart", meta);
  }
}

/** Trigger a browser download for a File obtained from OPFS. */
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
