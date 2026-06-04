/**
 * DeviceLobby — client-side WebSocket connection to the worker's
 * LobbyDO. Maintains the roster of currently-online peers for a
 * pair, exposes invite/accept primitives, and emits roster updates.
 *
 * Typical lifecycle:
 *   const lobby = new DeviceLobby({ signalingUrl, lobbyId, deviceId, nickname, role });
 *   lobby.on("roster", (peers) => updateUI(peers));
 *   lobby.on("invite", ({ from, sessionRoomId }) => { ... });
 *   await lobby.start();
 *   ...
 *   lobby.invite(peerDeviceId, sessionRoomId);
 *   ...
 *   lobby.stop();
 */

import { createEmitter } from "./emitter";

export interface RosterEntry {
  deviceId: string;
  nickname: string;
  role: string;
  joinedAt: number;
}

export interface IncomingInvite {
  fromDeviceId: string;
  fromNickname: string;
  sessionRoomId: string;
}

export interface InviteAck {
  fromDeviceId: string;
  sessionRoomId: string;
  accepted: boolean;
  reason?: string;
}

export interface LobbyEvents {
  roster: RosterEntry[];
  invite: IncomingInvite;
  inviteAck: InviteAck;
  open: void;
  close: { code: number; reason: string };
  error: string;
  log: string;
}

export interface DeviceLobbyOptions {
  signalingUrl: string;
  lobbyId: string;
  deviceId: string;
  nickname: string;
  role: "available" | "sending" | "receiving";
}

const PING_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 15_000;

export class DeviceLobby {
  readonly emitter = createEmitter<LobbyEvents>();
  private ws: WebSocket | null = null;
  private destroyed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private currentRole: "available" | "sending" | "receiving";

  constructor(private opts: DeviceLobbyOptions) {
    this.currentRole = opts.role;
  }

  start() {
    this.connect();
  }

  stop() {
    this.destroyed = true;
    this.clearTimers();
    try { this.ws?.close(1000, "client stop"); } catch { /* noop */ }
    this.ws = null;
  }

  /** Update our advertised role. Re-announces if connected. */
  setRole(role: "available" | "sending" | "receiving") {
    if (this.currentRole === role) return;
    this.currentRole = role;
    this.announce();
  }

  /** Send an invite to another device in the lobby. */
  invite(toDeviceId: string, sessionRoomId: string) {
    this.send({ type: "invite", payload: { toDeviceId, sessionRoomId } });
  }

  /** Respond to an invite — accept (true) or decline (false). */
  respondToInvite(toDeviceId: string, sessionRoomId: string, accepted: boolean, reason?: string) {
    this.send({
      type: "invite-ack",
      payload: { toDeviceId, sessionRoomId, accepted, reason },
    });
  }

  on<K extends keyof LobbyEvents>(event: K, handler: (data: LobbyEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }

  private connect() {
    if (this.destroyed) return;
    const url = new URL(this.opts.signalingUrl);
    url.searchParams.set("lobby", this.opts.lobbyId);
    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.emitter.emit("open", undefined);
      this.announce();
      this.startPing();
    };

    this.ws.onmessage = (e) => {
      let msg: { type: string; payload?: unknown };
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;
      }
      if (msg.type === "roster") {
        this.emitter.emit("roster", (msg.payload as RosterEntry[]) ?? []);
      } else if (msg.type === "invite-received") {
        this.emitter.emit("invite", msg.payload as IncomingInvite);
      } else if (msg.type === "invite-ack") {
        this.emitter.emit("inviteAck", msg.payload as InviteAck);
      } else if (msg.type === "pong") {
        /* keepalive */
      } else if (msg.type === "error") {
        const m = (msg.payload as { message?: string })?.message ?? "lobby error";
        this.emitter.emit("error", m);
      }
    };

    this.ws.onerror = () => this.emitter.emit("log", "lobby WS error");

    this.ws.onclose = (e) => {
      this.clearTimers();
      this.ws = null;
      this.emitter.emit("close", { code: e.code, reason: e.reason || "" });
      if (this.destroyed) return;
      // Backoff reconnect — mobile suspends sockets aggressively.
      this.reconnectAttempt++;
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * Math.pow(1.5, this.reconnectAttempt - 1),
      );
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private announce() {
    this.send({
      type: "announce",
      payload: {
        deviceId: this.opts.deviceId,
        nickname: this.opts.nickname,
        role: this.currentRole,
      },
    });
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(msg)); } catch { /* noop */ }
    }
  }

  private startPing() {
    this.clearTimers();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_INTERVAL_MS);
  }

  private clearTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}
