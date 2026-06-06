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
 * Cloudflare's free TURN service or self-hosted coturn via HMAC).
 * Returns null on failure so we still try STUN-only — useful when the
 * Worker's TURN binding isn't set up.
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

/**
 * Module-level single-flight cache of the TURN-creds fetch.
 *
 * Why module-level: we want the HTTP request to fire as soon as the
 * teleport-session module is imported — typically during page load,
 * long before the user clicks "Connect". By the time they actually
 * connect, the promise is usually already resolved.
 *
 * Why single-flight: multiple sessions on the same page (rare, but
 * possible for paired-device flows) share one fetch instead of
 * thrashing the Worker.
 *
 * Why null-on-failure (not throw): so callers can fall back to
 * STUN-only without crashing. The diag UI will show "no relay
 * candidate" if it actually matters.
 *
 * Refresh on next session: we don't pre-emptively refresh — the
 * HMAC creds we mint are valid for 1 hour (see worker/src/index.ts),
 * which is longer than any realistic single-session lifetime. Page
 * reload re-runs the module, which re-fetches. Good enough.
 */
let _turnCredsPromise: Promise<RTCIceServer[] | null> | null = null;

function preloadTurnCreds(signalingUrl: string): Promise<RTCIceServer[] | null> {
  if (_turnCredsPromise) return _turnCredsPromise;
  _turnCredsPromise = fetchTurnCreds(signalingUrl);
  return _turnCredsPromise;
}

/**
 * Wait up to `maxWaitMs` for the cached TURN-creds promise to resolve.
 * If it hasn't resolved by then, return null so we proceed STUN-only
 * rather than block the entire connect flow on a flaky /turn endpoint.
 *
 * 2000ms covers the realistic worst case (cold worker + slow mobile
 * network ≈ 800ms). If we still haven't heard back by 2s, TURN is
 * probably broken and STUN-only is the right answer anyway.
 */
async function awaitTurnCredsWithDeadline(
  signalingUrl: string,
  maxWaitMs = 2000,
): Promise<RTCIceServer[] | null> {
  const promise = preloadTurnCreds(signalingUrl);
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), maxWaitMs)),
  ]);
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

  // ── ICE restart (network-switch survival) ────────────────────────
  /**
   * Max time we'll wait for an ICE restart attempt to land us back in
   * "connected" before declaring the restart failed and falling through
   * to whatever the page-level recovery does. Covers worst-case TURN
   * re-allocation + cellular handoff (~2-8s typical).
   */
  private static readonly ICE_RESTART_TIMEOUT_MS = 20_000;
  /** True between createOffer({iceRestart:true}) and the next "connected" state. */
  private iceRestartInFlight = false;
  private iceRestartTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Eagerly warm the module-level TURN-creds cache so by the time
    // hostAuto/joinAuto is actually called (after the user fills the
    // room code, clicks Connect, etc.), the promise is usually already
    // resolved. The actual peer-config update happens in
    // maybeApplyTurnCreds(), awaited *before* any setLocalDescription —
    // eliminates the race where ICE gathering started without TURN.
    if (!opts.iceServers) {
      preloadTurnCreds(opts.signalingUrl);
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
        this.clearIceRestartTimer();
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

  /**
   * Pull the cached TURN creds (waiting up to 2s if the preload is
   * still pending) and apply them to the peer connection. Idempotent —
   * `_turnApplied` ensures we don't double-apply if called multiple
   * times during a session (e.g. host then receiver promotion).
   *
   * MUST be awaited before any setLocalDescription, otherwise ICE
   * gathering starts without TURN in the config and the relay
   * candidate never appears in the offer.
   */
  private _turnApplied = false;
  private async maybeApplyTurnCreds(): Promise<void> {
    if (this._turnApplied) return;
    if (this.opts.iceServers) return; // caller overrode — don't touch
    const extra = await awaitTurnCredsWithDeadline(this.opts.signalingUrl);
    if (!extra) {
      this.emitter.emit("log", "TURN creds unavailable — proceeding STUN-only");
      // Mark applied so we don't keep retrying the slow path on every offer.
      this._turnApplied = true;
      return;
    }
    const current = this.peer.getConfiguration();
    const merged = [...(current.iceServers ?? []), ...extra];
    try {
      this.peer.setConfiguration({ ...current, iceServers: merged });
      this.emitter.emit("log", `TURN credentials loaded (${extra.length} servers)`);
      this._turnApplied = true;
    } catch {
      // setConfiguration after gathering started is a no-op on some
      // browsers. STUN will still work for non-NAT cases.
    }
  }

  /** Sender path: create room + offer, connect via signaling. */
  async hostAuto(roomId: string) {
    this.role = "sender";
    this.roomId = roomId;
    this.emitter.emit("state", "signaling");
    // Apply TURN creds BEFORE setLocalDescription — otherwise ICE
    // gathering kicks off without TURN and the relay candidate is missing.
    await this.maybeApplyTurnCreds();
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
    // Apply TURN creds BEFORE we receive any offer — the offer handler
    // calls setLocalDescription(answer) which starts ICE gathering.
    await this.maybeApplyTurnCreds();
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

    // Fresh peer → need to re-apply TURN creds (the cache is still warm,
    // so this is ~0ms in practice).
    this._turnApplied = false;
    await this.maybeApplyTurnCreds();

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

    // Apply TURN creds BEFORE any setLocalDescription happens in either
    // branch below. The cache is usually warm by now (preloaded in ctor).
    await this.maybeApplyTurnCreds();

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

  /** Current role (sender/receiver). Page-level recovery logic needs this. */
  get currentRole(): PeerRole {
    return this.role;
  }

  /** True while an ICE restart is mid-flight. Surface as "Reconnecting…" in UI. */
  get isRestartingIce(): boolean {
    return this.iceRestartInFlight;
  }

  /**
   * Recover from a network change without losing the data channel.
   *
   * Called by the page when `window.online` fires or the PC enters
   * `"disconnected"`. Sender-only — receiver auto-handles the renegotiated
   * offer through the existing `ws.onmessage` "offer" branch (WebRTC PCs
   * support re-offering natively).
   *
   * Idempotent: subsequent calls during an in-flight restart are no-ops.
   * Cooldown / dedup at the call site (page layer) is also recommended.
   */
  async restartIce(): Promise<void> {
    if (this.destroyed) return;
    if (this.role !== "sender") return;
    if (this.isParanoid) return;             // paranoid mode is human-paced
    if (this.iceRestartInFlight) return;
    if (!this.roomId) return;

    const s = this.peer.connectionState;
    if (s === "connected" || s === "closed") return;

    this.iceRestartInFlight = true;
    this.emitter.emit("log", `ICE restart starting (peer state: ${s})`);
    // Tell the UI we're reconnecting — caller will surface a friendlier
    // status. Emitting "signaling" reuses the same code path that handles
    // initial handshake (status pill, spinner, etc.).
    this.emitter.emit("state", "signaling");

    try {
      // Network change usually killed the signaling WS too. Reopen it
      // before we have anything to send through it.
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.openSignaling(this.roomId);
      }

      // Reset candidate accounting — we're about to gather a fresh set
      // over the new network path. Keeping `candidatesReceived` so diag
      // stats reflect everything we ever heard, not just the latest gen.
      this.cachedCandidates = [];
      this.candidateTypes = { host: 0, srflx: 0, prflx: 0, relay: 0 };

      // peer.restartIce() is the modern entry point (Chrome 77+, Safari
      // 14+, Firefox 70+). Older browsers fall through to the
      // createOffer({iceRestart:true}) below, which still works.
      try {
        if (typeof this.peer.restartIce === "function") {
          this.peer.restartIce();
        }
      } catch { /* tolerate; createOffer below is the actual trigger */ }

      const offer = await this.peer.createOffer({ iceRestart: true });
      await this.peer.setLocalDescription(offer);
      this.cachedOffer = offer;
      this.sendSignal({ type: "offer", payload: offer });

      // Cap the recovery window — if the PC doesn't reach "connected"
      // by then, emit "failed" so page-level recovery (rebuild room,
      // lobby reconnect, etc.) can take over.
      this.iceRestartTimer = setTimeout(() => {
        if (this.peer.connectionState !== "connected") {
          this.emitter.emit("log", "ICE restart timed out");
          this.emitter.emit("state", "failed");
        }
        this.clearIceRestartTimer();
      }, TeleportSession.ICE_RESTART_TIMEOUT_MS);
    } catch (err) {
      this.clearIceRestartTimer();
      this.emitter.emit("error", new Error(`ICE restart failed: ${String(err)}`));
    }
  }

  private clearIceRestartTimer(): void {
    if (this.iceRestartTimer !== null) {
      clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }
    this.iceRestartInFlight = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearConnectTimer();
    this.clearIceRestartTimer();
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
