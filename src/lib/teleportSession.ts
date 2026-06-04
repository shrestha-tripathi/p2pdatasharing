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
  /** Detailed diagnostic snapshot — fired on every state change. */
  diag: DiagSnapshot;
  /** Worker tells us if we're first ("host") or second ("join") in the room. */
  serverRole: "host" | "join";
  /**
   * Heartbeat (layer 4) RTT in ms — fired on every successful pong. Surface
   * in UI later if useful. RTT > 200ms suggests one side is throttled.
   */
  rtt: number;
  /**
   * Fired when the heartbeat detects no pong within the deadline, even
   * though the data channel still claims "open". Indicates a silent stall
   * — typically a backgrounded peer whose JS got throttled. The session
   * proactively closes the channel after this fires, so the normal
   * disconnect/reconnect flow can recover the transfer.
   */
  stalled: { silentForMs: number };
}

export interface DiagSnapshot {
  ws: "idle" | "connecting" | "open" | "closed";
  peerHasOffer: boolean;
  peerHasAnswer: boolean;
  iceGathering: RTCIceGatheringState;
  iceConnection: RTCIceConnectionState;
  peerConnection: RTCPeerConnectionState;
  dataChannel: RTCDataChannelState | "none";
  candidatesGathered: number;
  candidatesReceived: number;
  candidateTypes: { host: number; srflx: number; relay: number; prflx: number };
}

const DEFAULT_ICE: RTCIceServer[] = [
  // STUN — discovers public IP. Handles ~80% of home/Wi-Fi networks.
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

/**
 * Fetch short-lived TURN credentials from our Worker (which proxies to
 * Cloudflare's free TURN service). Returns null on failure so we still
 * try STUN-only — useful when the Worker's TURN binding isn't set up.
 */
async function fetchTurnCreds(signalingUrl: string): Promise<RTCIceServer[] | null> {
  try {
    const httpUrl = signalingUrl.replace(/^ws/, "http");
    const u = new URL("/turn", httpUrl);
    const res = await fetch(u.toString(), { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as { iceServers?: RTCIceServer | RTCIceServer[] };
    if (!data.iceServers) return null;
    return Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
  } catch {
    return null;
  }
}

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
  /**
   * Sender keeps a copy of the offer + all gathered ICE candidates so
   * we can re-send the handshake on signaling reconnect (mobile tab
   * background eats the WS, and the DO grace buffer might already
   * have been wiped on a fresh DO instance).
   */
  private cachedOffer: RTCSessionDescriptionInit | null = null;
  private cachedCandidates: RTCIceCandidateInit[] = [];
  private candidatesReceived = 0;
  private candidateTypes = { host: 0, srflx: 0, relay: 0, prflx: 0 };
  /**
   * Whether this session is in paranoid (manual SDP) mode. In paranoid
   * mode we never auto-time-out — humans pace the handshake by copy-pasting
   * blobs over a side channel, which can take arbitrarily long.
   */
  private isParanoid = false;

  // ── Heartbeat (layer 4) ──────────────────────────────────────────
  /** ms between outbound pings while channel open. Tuned for low overhead. */
  private static readonly HEARTBEAT_INTERVAL_MS = 5_000;
  /** No pong within this window => declare stalled and force-close channel. */
  private static readonly HEARTBEAT_DEADLINE_MS = 15_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  /** Set true after we've declared a stall so the next reconnect path runs. */
  private heartbeatStalled = false;

  private emitDiag() {
    const wsState: DiagSnapshot["ws"] = !this.ws
      ? "idle"
      : this.ws.readyState === WebSocket.CONNECTING
      ? "connecting"
      : this.ws.readyState === WebSocket.OPEN
      ? "open"
      : "closed";
    this.emitter.emit("diag", {
      ws: wsState,
      peerHasOffer: !!this.peer.localDescription || !!this.peer.remoteDescription,
      peerHasAnswer:
        (this.peer.localDescription?.type === "answer") ||
        (this.peer.remoteDescription?.type === "answer"),
      iceGathering: this.peer.iceGatheringState,
      iceConnection: this.peer.iceConnectionState,
      peerConnection: this.peer.connectionState,
      dataChannel: this.dataChannel?.readyState ?? "none",
      candidatesGathered: this.cachedCandidates.length,
      candidatesReceived: this.candidatesReceived,
      candidateTypes: { ...this.candidateTypes },
    });
  }

  constructor(private opts: CreateSessionOptions) {
    this.peer = new RTCPeerConnection({
      iceServers: opts.iceServers ?? DEFAULT_ICE,
    });
    this.wireUpPeer();

    // Asynchronously try to fetch Cloudflare TURN creds from our Worker.
    // If successful, add them to the peer connection BEFORE ICE gathering
    // matters (setLocalDescription kicks off gathering, so this race only
    // hurts if the user hits send within ~500ms of page load).
    if (!opts.iceServers) {
      fetchTurnCreds(opts.signalingUrl).then((extra) => {
        if (!extra) return;
        const current = this.peer.getConfiguration();
        const merged = [...(current.iceServers ?? []), ...extra];
        try {
          this.peer.setConfiguration({ ...current, iceServers: merged });
          this.emitter.emit("log", `TURN credentials loaded (${extra.length} servers)`);
        } catch {
          /* setConfiguration after gathering started is a no-op on some
             browsers — fine, STUN will still work for non-NAT cases. */
        }
      });
    }
  }

  private wireUpPeer() {
    const fireDiag = () => this.emitDiag();
    this.peer.onconnectionstatechange = () => {
      const s = this.peer.connectionState;
      this.emitter.emit("log", `peer state: ${s}`);
      if (s === "connecting") {
        // In paranoid mode the peer transitions to 'connecting' as soon
        // as both blobs are exchanged — but the actual TURN/STUN
        // negotiation may need to wait for the user to come back to
        // the tab, paste the other side, etc. Skip the auto timer.
        if (!this.isParanoid) this.startConnectTimer();
      } else if (s === "connected") {
        this.clearConnectTimer();
        this.emitter.emit("state", "connected");
        this.closeSignaling();
      } else if (s === "disconnected") {
        this.emitter.emit("state", "disconnected");
      } else if (s === "failed") {
        this.emitter.emit("state", "failed");
      }
      fireDiag();
    };
    this.peer.oniceconnectionstatechange = fireDiag;
    this.peer.onicegatheringstatechange = fireDiag;
    this.peer.onsignalingstatechange = fireDiag;

    this.peer.ondatachannel = (e) => {
      this.attachChannel(e.channel);
      fireDiag();
    };

    this.peer.onicecandidate = (e) => {
      if (e.candidate) {
        const cand = e.candidate.toJSON();
        if (this.role === "sender") {
          this.cachedCandidates.push(cand);
        } else {
          this.cachedCandidates.push(cand);
        }
        // Categorize for diagnostics — helps spot "STUN only" vs "TURN needed".
        const type = e.candidate.type as keyof typeof this.candidateTypes | null;
        if (type && type in this.candidateTypes) this.candidateTypes[type]++;
        this.sendSignal({ type: "candidate", payload: cand });
        fireDiag();
      }
    };
  }

  private attachChannel(ch: RTCDataChannel) {
    this.dataChannel = ch;
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = 1 << 20; // 1 MB
    ch.onopen = () => {
      this.startHeartbeat();
      this.emitter.emit("channelOpen", ch);
    };
    ch.onmessage = (e) => {
      // Intercept heartbeat control frames so they never reach the
      // application layer (fileTransfer.ts). Anything else passes through.
      if (typeof e.data === "string" && e.data.length < 96) {
        const handled = this.tryHandleHeartbeatFrame(e.data);
        if (handled) return;
      }
      this.emitter.emit("channelMessage", { data: e.data });
    };
    ch.onerror = (e) =>
      this.emitter.emit("error", new Error(`data channel error: ${String(e)}`));
    ch.onclose = () => this.stopHeartbeat();
  }

  /**
   * Handle inbound ping/pong control frames. Returns true if the frame was
   * consumed (caller should NOT bubble it up to channelMessage).
   *
   * Frame format (kept tiny on the wire — runs every 5s per side):
   *   ping → {"kind":"hb-ping","t": <senderClock>}
   *   pong → {"kind":"hb-pong","t": <echoedSenderClock>}
   *
   * We echo the sender's clock back unchanged so the originating side can
   * compute RTT without a clock-sync handshake.
   */
  private tryHandleHeartbeatFrame(raw: string): boolean {
    // Cheap guard before JSON.parse — avoids parsing every meta/resume frame.
    if (raw[0] !== "{" || (raw.indexOf("\"hb-") === -1)) return false;
    try {
      const f = JSON.parse(raw) as { kind?: string; t?: number };
      if (f.kind === "hb-ping") {
        this.sendControlFrame({ kind: "hb-pong", t: f.t ?? 0 });
        return true;
      }
      if (f.kind === "hb-pong") {
        this.lastPongAt = Date.now();
        const rtt = this.lastPongAt - (f.t ?? this.lastPongAt);
        if (rtt >= 0) this.emitter.emit("rtt", rtt);
        return true;
      }
    } catch {
      /* malformed — let it bubble (probably not a heartbeat after all) */
    }
    return false;
  }

  /** Send a small JSON control frame on the data channel. Best-effort. */
  private sendControlFrame(obj: object): void {
    const ch = this.dataChannel;
    if (!ch || ch.readyState !== "open") return;
    try {
      ch.send(JSON.stringify(obj));
    } catch {
      /* channel closed mid-send — heartbeat tick will catch it */
    }
  }

  /**
   * Begin sending heartbeat pings every HEARTBEAT_INTERVAL_MS. Detects a
   * silent stall (no pong within HEARTBEAT_DEADLINE_MS) and force-closes
   * the channel so the existing reconnect path can take over.
   *
   * Safe to call multiple times — clears any prior timer first.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Seed timestamps so the first interval doesn't immediately false-alarm.
    this.lastPongAt = Date.now();
    this.heartbeatStalled = false;
    this.heartbeatTimer = setInterval(() => {
      const ch = this.dataChannel;
      if (!ch || ch.readyState !== "open") {
        this.stopHeartbeat();
        return;
      }
      const now = Date.now();
      const silentForMs = now - this.lastPongAt;
      if (silentForMs > TeleportSession.HEARTBEAT_DEADLINE_MS) {
        // Channel still "open" but peer hasn't responded — declare stall.
        if (!this.heartbeatStalled) {
          this.heartbeatStalled = true;
          this.emitter.emit("log",
            `heartbeat stall (no pong for ${silentForMs}ms) — closing channel to force reconnect`);
          this.emitter.emit("stalled", { silentForMs });
          // Force-close: triggers ch.onclose → stopHeartbeat, and
          // RTCPeerConnection.onconnectionstatechange should fire
          // "disconnected"/"failed" within a few seconds, kicking the
          // existing peer-rejoined / restartAsHost reconnect logic.
          try { ch.close(); } catch { /* noop */ }
        }
        return;
      }
      // All good — send next ping.
      this.sendControlFrame({ kind: "hb-ping", t: now });
    }, TeleportSession.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    this.cachedOffer = offer;
    this.sendSignal({ type: "offer", payload: offer });
    // NOTE: no startConnectTimer here — we'll start it in
    // onconnectionstatechange once the receiver actually answers.
  }

  /** Receiver path: join room, await offer. */
  async joinAuto(roomId: string) {
    this.role = "receiver";
    this.roomId = roomId;
    this.emitter.emit("state", "signaling");
    await this.openSignaling(roomId);
    // Receiver is opening a fresh link — peer should answer within seconds.
    // Safe to start the 15s timer immediately here.
    this.startConnectTimer();
  }

  /**
   * Paired-device entry point: open signaling and let the server tell us
   * whether we're host (first to arrive) or join (second). Eliminates the
   * "both peers think they're host" glare bug that breaks reconnect.
   *
   * Resolves once role is assigned and the appropriate handshake has been
   * kicked off. The session reaches "connected" via the normal state events.
   */
  /**
   * Tear down the stale RTCPeerConnection and rebuild as host — used
   * when the worker tells us the other side reconnected. We promote to
   * host regardless of previous role (worker just re-assigned us).
   */
  private async restartAsHost() {
    // Tear down old PC + DC.
    try { this.dataChannel?.close(); } catch { /* noop */ }
    try { this.peer.close(); } catch { /* noop */ }
    this.dataChannel = null;
    this.cachedCandidates = [];
    this.candidatesReceived = 0;
    this.candidateTypes = { host: 0, srflx: 0, prflx: 0, relay: 0 };

    // Rebuild PC with same ICE config.
    const cfg = { iceServers: this.opts.iceServers ?? DEFAULT_ICE };
    this.peer = new RTCPeerConnection(cfg);
    this.wireUpPeer();
    this.role = "sender";

    const ch = this.peer.createDataChannel("file-payload");
    this.attachChannel(ch);
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    this.cachedOffer = offer;
    this.sendSignal({ type: "offer", payload: offer });
    this.emitter.emit("state", "signaling");
  }

  async connectAuto(roomId: string): Promise<"sender" | "receiver"> {
    this.roomId = roomId;
    this.emitter.emit("state", "signaling");

    // Open signaling FIRST and capture role assignment before deciding what to do.
    const rolePromise = new Promise<"sender" | "receiver">((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Role assignment timeout")), 8_000);
      const off = this.emitter.on("serverRole", (r) => {
        clearTimeout(timer);
        off();
        resolve(r === "host" ? "sender" : "receiver");
      });
    });

    await this.openSignaling(roomId);
    const decided = await rolePromise;
    this.role = decided;

    if (decided === "sender") {
      // Host path: create data channel + offer (mirrors hostAuto).
      const ch = this.peer.createDataChannel("file-payload");
      this.attachChannel(ch);
      const offer = await this.peer.createOffer();
      await this.peer.setLocalDescription(offer);
      this.cachedOffer = offer;
      this.sendSignal({ type: "offer", payload: offer });
    } else {
      // Join path: just wait for the host's offer (mirrors joinAuto).
      this.startConnectTimer();
    }
    return decided;
  }

  // ---------- MANUAL (paranoid) MODE ----------

  /**
   * Sender path, manual: returns a base64 offer blob.
   * Wait for the peer's answer blob, then call acceptManualAnswer().
   * NOTE: paranoid mode skips the auto connect timer entirely — the
   * handshake is gated on human copy/paste which can take a long time.
   */
  async hostManual(): Promise<string> {
    this.role = "sender";
    this.isParanoid = true;
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
    // No startConnectTimer — paranoid mode never auto-times-out.
  }

  /**
   * Receiver path, manual: paste the offer blob, get back an answer blob.
   * Same rationale as hostManual — no auto timeout.
   */
  async joinManual(offerBlob: string): Promise<string> {
    this.role = "receiver";
    this.isParanoid = true;
    this.emitter.emit("state", "signaling");

    const decoded = decodeBlob(offerBlob);
    if (decoded.type !== "offer") throw new Error("Expected 'offer' blob");
    await this.peer.setRemoteDescription(decoded.sdp);

    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    await this.waitForIceGathering();
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
      if (msg.type === "role") {
        const r = (msg.payload as { role?: "host" | "join" })?.role;
        if (r === "host" || r === "join") {
          this.emitter.emit("serverRole", r);
        }
      } else if (msg.type === "offer") {
        await this.peer.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        const answer = await this.peer.createAnswer();
        await this.peer.setLocalDescription(answer);
        this.sendSignal({ type: "answer", payload: answer });
      } else if (msg.type === "answer") {
        await this.peer.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
      } else if (msg.type === "candidate") {
        try {
          await this.peer.addIceCandidate(msg.payload as RTCIceCandidateInit);
          this.candidatesReceived++;
          this.emitDiag();
        } catch (err) {
          this.emitter.emit("log", `addIceCandidate failed: ${String(err)}`);
        }
      } else if (msg.type === "error") {
        this.emitter.emit("error", new Error((msg.payload as { message: string }).message));
      } else if (msg.type === "peer-rejoined") {
        // The other side refreshed / re-connected. Our existing PC is
        // stale (its remote description points at a dead session). Tear
        // it down and start a fresh handshake — but ONLY if we're host.
        // Joiner just waits for the new offer.
        this.emitter.emit("log", "peer rejoined — rebuilding handshake");
        await this.restartAsHost().catch((err) =>
          this.emitter.emit("log", `restartAsHost failed: ${String(err)}`),
        );
      }
    };
    this.ws.onerror = () =>
      this.emitter.emit("log", "Signaling WebSocket error");

    // Auto-reconnect if the WS closes while we're still waiting for the
    // peer (common when mobile backgrounds the tab — iOS/Android suspend
    // sockets aggressively). We DON'T reconnect once the peer is
    // connected because at that point signaling is no longer needed.
    this.ws.onclose = () => {
      if (
        this.destroyed ||
        this.peer.connectionState === "connected" ||
        this.peer.connectionState === "closed"
      ) {
        return;
      }
      // Only auto-reconnect when the document is visible — no point
      // reconnecting in the background just to be killed again.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // Will be reconnected by the visibilitychange listener below.
        return;
      }
      this.emitter.emit("log", "Signaling WS closed unexpectedly — reconnecting");
      this.openSignaling(roomId).catch((err) => {
        this.emitter.emit("error", new Error(`Signaling reconnect failed: ${String(err)}`));
      });
    };

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => {
        this.sendSignal({ type: "join", payload: {} });
        // If we're the sender and we already have an offer cached from a
        // previous session (this is a reconnect), replay it + all the
        // ICE candidates so the receiver — whenever they finally join —
        // gets the handshake regardless of any DO buffer eviction.
        if (this.role === "sender" && this.cachedOffer) {
          this.sendSignal({ type: "offer", payload: this.cachedOffer });
          for (const c of this.cachedCandidates) {
            this.sendSignal({ type: "candidate", payload: c });
          }
          this.emitter.emit(
            "log",
            `Replayed handshake on reconnect (offer + ${this.cachedCandidates.length} candidates)`,
          );
        }
        resolve();
      };
      setTimeout(() => reject(new Error("Signaling connect timeout")), 8000);
    });
  }

  /**
   * Manually nudge the session back to life — used when the page
   * regains visibility after being backgrounded. Reopens the signaling
   * WebSocket if it died and we're still waiting for a peer.
   */
  resumeIfStale() {
    if (this.destroyed || !this.roomId) return;
    if (
      this.peer.connectionState === "connected" ||
      this.peer.connectionState === "closed"
    ) {
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.emitter.emit("log", "Resuming session after foreground");
    this.openSignaling(this.roomId).catch((err) => {
      this.emitter.emit("error", new Error(`Resume failed: ${String(err)}`));
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
            "Could not establish a direct connection within 15s. This usually happens on strict mobile networks (carrier NAT) or corporate firewalls. Try: (a) one peer switch to Wi-Fi, or (b) flip on Paranoid mode and exchange the handshake manually.",
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
  type: "offer" | "answer" | "candidate" | "join" | "error" | "role" | "peer-rejoined";
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
