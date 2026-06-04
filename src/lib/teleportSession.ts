/**
 * WebRTC + signaling client for Local Teleport.
 *
 * Two modes:
 *   - 'auto'   — uses the configured WebSocket signaling server
 *   - 'manual' — caller exchanges SDP/ICE strings by other channels (paranoid mode)
 *
 * The transport layer (data channel framing, OPFS writes, progress) lives in
 * fileTransfer.ts. This file is concerned ONLY with peer connection lifecycle.
 */
import { createEmitter } from "./emitter";

export type PeerRole = "sender" | "receiver";
export type PeerConnState =
  | "idle"
  | "signaling"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

export interface SessionEvents {
  state: PeerConnState;
  log: string;
  channelOpen: RTCDataChannel;
  channelMessage: { data: ArrayBuffer | string };
  /** Emitted in manual mode whenever there's a new SDP/ICE blob to share. */
  manualBlob: string;
  error: Error;
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const CONNECT_TIMEOUT_MS = 15_000;

export interface CreateSessionOptions {
  signalingUrl: string;
  iceServers?: RTCIceServer[];
}

export class TeleportSession {
  readonly emitter = createEmitter<SessionEvents>();
  readonly peer: RTCPeerConnection;
  private ws: WebSocket | null = null;
  private role: PeerRole = "sender";
  private roomId: string | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private opts: CreateSessionOptions) {
    this.peer = new RTCPeerConnection({
      iceServers: opts.iceServers ?? DEFAULT_ICE,
    });
    this.wireUpPeer();
  }

  private wireUpPeer() {
    this.peer.onconnectionstatechange = () => {
      const s = this.peer.connectionState;
      this.emitter.emit("log", `peer state: ${s}`);
      if (s === "connected") {
        this.clearConnectTimer();
        this.emitter.emit("state", "connected");
        // Signaling no longer needed.
        this.closeSignaling();
      } else if (s === "disconnected") {
        this.emitter.emit("state", "disconnected");
      } else if (s === "failed") {
        this.emitter.emit("state", "failed");
      }
    };

    this.peer.ondatachannel = (e) => {
      this.attachChannel(e.channel);
    };

    this.peer.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal({ type: "candidate", payload: e.candidate.toJSON() });
      }
    };
  }

  private attachChannel(ch: RTCDataChannel) {
    this.dataChannel = ch;
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = 1 << 20; // 1 MB
    ch.onopen = () => this.emitter.emit("channelOpen", ch);
    ch.onmessage = (e) => this.emitter.emit("channelMessage", { data: e.data });
    ch.onerror = (e) =>
      this.emitter.emit("error", new Error(`data channel error: ${String(e)}`));
  }

  /** Sender path: create room + offer, connect via signaling. */
  async hostAuto(roomId: string) {
    this.role = "sender";
    this.roomId = roomId;
    this.emitter.emit("state", "signaling");
    await this.openSignaling(roomId);

    const ch = this.peer.createDataChannel("file-payload");
    this.attachChannel(ch);

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    this.sendSignal({ type: "offer", payload: offer });
    this.startConnectTimer();
  }

  /** Receiver path: join room, await offer. */
  async joinAuto(roomId: string) {
    this.role = "receiver";
    this.roomId = roomId;
    this.emitter.emit("state", "signaling");
    await this.openSignaling(roomId);
    this.startConnectTimer();
  }

  // ---------- MANUAL (paranoid) MODE ----------

  /**
   * Sender path, manual: returns a base64 offer blob.
   * Wait for the peer's answer blob, then call acceptManualAnswer().
   */
  async hostManual(): Promise<string> {
    this.role = "sender";
    this.emitter.emit("state", "signaling");

    const ch = this.peer.createDataChannel("file-payload");
    this.attachChannel(ch);

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);

    // Bundle the offer + ICE candidates after gathering finishes.
    await this.waitForIceGathering();
    return encodeBlob({ type: "offer", sdp: this.peer.localDescription! });
  }

  async acceptManualAnswer(blob: string) {
    const decoded = decodeBlob(blob);
    if (decoded.type !== "answer") throw new Error("Expected 'answer' blob");
    await this.peer.setRemoteDescription(decoded.sdp);
    this.startConnectTimer();
  }

  /**
   * Receiver path, manual: paste the offer blob, get back an answer blob.
   */
  async joinManual(offerBlob: string): Promise<string> {
    this.role = "receiver";
    this.emitter.emit("state", "signaling");

    const decoded = decodeBlob(offerBlob);
    if (decoded.type !== "offer") throw new Error("Expected 'offer' blob");
    await this.peer.setRemoteDescription(decoded.sdp);

    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    await this.waitForIceGathering();
    this.startConnectTimer();
    return encodeBlob({ type: "answer", sdp: this.peer.localDescription! });
  }

  private waitForIceGathering(): Promise<void> {
    if (this.peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.peer.iceGatheringState === "complete") {
          this.peer.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      this.peer.addEventListener("icegatheringstatechange", check);
      // Hard timeout — most networks gather in <2s.
      setTimeout(() => {
        this.peer.removeEventListener("icegatheringstatechange", check);
        resolve();
      }, 3000);
    });
  }

  // ---------- SIGNALING TRANSPORT ----------

  private async openSignaling(roomId: string) {
    // Append ?room=<id> so Cloudflare Worker can route to the right
    // Durable Object before upgrading the WebSocket. The Node + ws
    // reference server ignores query strings, so this works for both.
    const url = new URL(this.opts.signalingUrl);
    url.searchParams.set("room", roomId);
    this.ws = new WebSocket(url.toString());
    this.ws.onmessage = async (e) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : await (e.data as Blob).text());
      } catch {
        return;
      }
      if (msg.type === "offer") {
        await this.peer.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        const answer = await this.peer.createAnswer();
        await this.peer.setLocalDescription(answer);
        this.sendSignal({ type: "answer", payload: answer });
      } else if (msg.type === "answer") {
        await this.peer.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
      } else if (msg.type === "candidate") {
        try {
          await this.peer.addIceCandidate(msg.payload as RTCIceCandidateInit);
        } catch (err) {
          this.emitter.emit("log", `addIceCandidate failed: ${String(err)}`);
        }
      } else if (msg.type === "error") {
        this.emitter.emit("error", new Error((msg.payload as { message: string }).message));
      }
    };
    this.ws.onerror = () =>
      this.emitter.emit("error", new Error("Signaling WebSocket error"));

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => {
        this.sendSignal({ type: "join", payload: {} });
        resolve();
      };
      setTimeout(() => reject(new Error("Signaling connect timeout")), 8000);
    });
  }

  private sendSignal(partial: { type: string; payload: unknown }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.roomId) return;
    this.ws.send(JSON.stringify({ room: this.roomId, ...partial }));
  }

  private closeSignaling() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
  }

  private startConnectTimer() {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (this.peer.connectionState !== "connected") {
        this.emitter.emit("state", "failed");
        this.emitter.emit(
          "error",
          new Error(
            "Could not establish a direct connection within 15s. Likely symmetric NAT. Try a different network or use paranoid mode.",
          ),
        );
      }
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  send(data: ArrayBuffer | string) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("Data channel not open");
    }
    this.dataChannel.send(data as never);
  }

  get channel(): RTCDataChannel | null {
    return this.dataChannel;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearConnectTimer();
    this.closeSignaling();
    try { this.dataChannel?.close(); } catch { /* noop */ }
    try { this.peer.close(); } catch { /* noop */ }
  }
}

interface SignalMessage {
  type: "offer" | "answer" | "candidate" | "join" | "error";
  payload: unknown;
}

// -------- manual-mode blob encoding --------

interface ManualBlob {
  type: "offer" | "answer";
  sdp: RTCSessionDescription | RTCSessionDescriptionInit;
}

function encodeBlob(blob: ManualBlob): string {
  const json = JSON.stringify({
    type: blob.type,
    sdp: { type: blob.sdp.type, sdp: blob.sdp.sdp },
  });
  return btoa(unescape(encodeURIComponent(json)));
}

function decodeBlob(b64: string): ManualBlob {
  const json = decodeURIComponent(escape(atob(b64.trim())));
  return JSON.parse(json);
}
