/**
 * Local Teleport — Cloudflare Worker signaling server.
 *
 * Architecture
 * ------------
 *   GET wss://<worker>/?room=<id>
 *       → Worker fetches the DurableObject keyed by <id>
 *       → DO accepts the WebSocket, joins it to the room (max 2 peers)
 *       → DO forwards all subsequent JSON messages to the OTHER peer
 *
 * Why DurableObjects?
 *   A plain Worker is stateless per-request — two peers wanting to
 *   share a WebSocket relay need a single instance to hold both sockets.
 *   DOs guarantee exactly one instance per ID, globally.
 *
 * Wire protocol (same as the Node + ws reference):
 *   { "room": "<id>", "type": "offer"|"answer"|"candidate"|"join", "payload": ... }
 *   Server may emit: { "type": "error", "payload": { "message": "..." } }
 */

export interface Env {
  ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  CODES: DurableObjectNamespace;
  ALLOWED_ORIGIN: string;
  // Cloudflare Realtime TURN credentials — set via:
  //   npx wrangler secret put TURN_TOKEN_ID
  //   npx wrangler secret put TURN_API_TOKEN
  // Get them from: dash.cloudflare.com → Calls → TURN App → Create
  TURN_TOKEN_ID?: string;
  TURN_API_TOKEN?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check.
    if (url.pathname === "/" && request.headers.get("Upgrade") !== "websocket") {
      return new Response("local-teleport-signaling: alive\n", {
        headers: { "content-type": "text/plain", ...CORS_HEADERS },
      });
    }

    // TURN credential endpoint — issues short-lived creds via Cloudflare
    // Realtime TURN. Falls back to public STUN if secrets aren't set.
    if (url.pathname === "/turn") {
      return handleTurn(env);
    }

    // Short-code pairing routes — see worker/src/index.ts → CodeDO and
    // docs/specs/local-network-code-pairing.md for the full design.
    // Both mint and claim are routed to a single global CodeDO instance
    // so code collisions are detected authoritatively.
    if (url.pathname === "/code/mint") {
      return handleCodeMint(request, env);
    }
    if (url.pathname === "/code/claim") {
      return handleCodeClaim(request, env);
    }

    // Everything else expects a WebSocket upgrade with ?room=<id>.
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Lobby route: ?lobby=<id> → LobbyDO (N-peer roster + invite relay).
    if (url.searchParams.has("lobby")) {
      const lobby = url.searchParams.get("lobby")!;
      if (!lobby || lobby.length > 128 || !/^[\w-]+$/.test(lobby)) {
        return new Response("Invalid ?lobby", { status: 400 });
      }
      const id = env.LOBBY.idFromName(lobby);
      return env.LOBBY.get(id).fetch(request);
    }

    const room = url.searchParams.get("room");
    if (!room || room.length > 128 || !/^[\w-]+$/.test(room)) {
      return new Response("Invalid or missing ?room", { status: 400 });
    }

    const id = env.ROOM.idFromName(room);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};

async function handleTurn(env: Env): Promise<Response> {
  const headers = { "content-type": "application/json", ...CORS_HEADERS };

  if (!env.TURN_TOKEN_ID || !env.TURN_API_TOKEN) {
    // No TURN configured — return public STUN only.
    return new Response(
      JSON.stringify({
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        warning: "TURN not configured — STUN only. Set TURN_TOKEN_ID + TURN_API_TOKEN secrets.",
      }),
      { headers },
    );
  }

  try {
    // Cloudflare Realtime TURN — credentials valid for 10 minutes.
    // Docs: https://developers.cloudflare.com/realtime/turn/
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 600 }),
      },
    );
    if (!res.ok) {
      return new Response(
        JSON.stringify({
          iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
          error: `Cloudflare TURN API: ${res.status}`,
        }),
        { headers, status: 200 },
      );
    }
    const data = (await res.json()) as { iceServers: RTCIceServer };
    return new Response(JSON.stringify(data), { headers });
  } catch (err) {
    return new Response(
      JSON.stringify({
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        error: String(err),
      }),
      { headers },
    );
  }
}

/**
 * Forward a code-pairing request to the global CodeDO instance.
 *
 * Why a single global DO?
 *   - Code collisions only matter globally — a 4-char Crockford Base32
 *     code lives in a 1.05M-entry namespace. With ~60s TTL, ~10k mints/sec
 *     would be needed to cause regular collisions. We're nowhere near that.
 *   - One authoritative instance means collision detection is trivial
 *     (just check a Map<code, record>).
 *   - DO migration: if a region becomes hot, Cloudflare auto-migrates the
 *     DO toward it. At 10M+ DAU we'd shard regionally; the wire protocol
 *     here already supports that change without client coordination.
 */
const CODE_DO_NAME = "global-v1";

function getCodeDO(env: Env) {
  return env.CODES.get(env.CODES.idFromName(CODE_DO_NAME));
}

async function handleCodeMint(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
  // Validate room param before bothering the DO.
  const url = new URL(request.url);
  const room = url.searchParams.get("room");
  if (!room || room.length > 128 || !/^[\w-]+$/.test(room)) {
    return jsonResponse({ error: "invalid room" }, 400);
  }
  return getCodeDO(env).fetch(request);
}

async function handleCodeClaim(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // Validation: 4-8 alphanumeric chars. We ship 4 today; the range covers
  // any future format bump (5-char would be config-only on the server).
  if (!code || !/^[0-9A-Za-z]{4,8}$/.test(code)) {
    return jsonResponse({ error: "invalid" }, 400);
  }
  return getCodeDO(env).fetch(request);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export class RoomDO implements DurableObject {
  private peers = new Set<WebSocket>();
  /**
   * Messages buffered while only one peer was in the room. Replayed in
   * order to the second peer the moment they join. Fixes the race where
   * the host creates an offer (and gathers ICE candidates) BEFORE the
   * receiver has even opened their WebSocket — without buffering, those
   * messages are forwarded to an empty peer set and lost forever.
   */
  private pendingForJoiner: (string | ArrayBuffer)[] = [];
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.peers.size >= 2) {
      return new Response("Room full", { status: 423 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.accept(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private accept(ws: WebSocket) {
    ws.accept();
    const isSecondPeer = this.peers.size === 1;
    this.peers.add(ws);

    // Tell the client whether they're first ("host") or second ("join") in
    // this room. Lets paired-device clients elect roles dynamically without
    // relying on stored iAmHost — eliminates the "both think they're host"
    // glare bug when peers refresh / re-pair / clear storage.
    try {
      ws.send(JSON.stringify({
        type: "role",
        payload: { role: isSecondPeer ? "join" : "host" },
      }));
    } catch {
      /* peer may have closed instantly — ignore */
    }

    // If this is the second peer, replay everything the first peer sent
    // while they were alone in the room.
    if (isSecondPeer && this.pendingForJoiner.length > 0) {
      for (const buffered of this.pendingForJoiner) {
        try {
          ws.send(buffered as string);
        } catch {
          /* peer may have closed instantly — ignore */
        }
      }
      this.pendingForJoiner = [];
    }

    // If this is the second peer joining a room where the first peer is
    // already established (no buffered offer), notify the host to restart
    // the handshake. Fixes the "refresh one device, other side stuck"
    // reconnect bug: without this, the existing host has a stale PC and
    // never sends a fresh offer to the newly-arrived second peer.
    if (isSecondPeer) {
      for (const peer of this.peers) {
        if (peer !== ws && peer.readyState === WebSocket.READY_STATE_OPEN) {
          try {
            // Re-assign the existing peer as host (they're now alone-then-paired,
            // so by definition they're "first in room" again). Then tell them
            // to restart the handshake against the freshly-arrived second peer.
            peer.send(JSON.stringify({ type: "role", payload: { role: "host" } }));
            peer.send(JSON.stringify({ type: "peer-rejoined" }));
          } catch {
            /* ignore */
          }
        }
      }
    }

    ws.addEventListener("message", (event) => {
      if (this.peers.size < 2) {
        // No peer to forward to yet — buffer for the future joiner.
        // Cap buffer to prevent abuse / runaway memory.
        if (this.pendingForJoiner.length < 256) {
          this.pendingForJoiner.push(event.data);
        }
        return;
      }
      for (const peer of this.peers) {
        if (peer !== ws && peer.readyState === WebSocket.READY_STATE_OPEN) {
          try {
            peer.send(event.data);
          } catch {
            /* peer gone — cleanup happens via close listener */
          }
        }
      }
    });

    const cleanup = () => {
      this.peers.delete(ws);
      if (this.peers.size === 0) {
        // Grace period — the lone remaining client probably backgrounded
        // the tab and the OS killed their socket. Keep their buffered
        // offer/ICE around for 5 minutes so when they reconnect (or the
        // actual receiver joins), the handshake still works. Clear
        // earlier if a fresh peer arrives and gets it.
        const snapshot = this.pendingForJoiner;
        setTimeout(
          () => {
            // Only clear if NO ONE is in the room AND the buffer hasn't
            // been replaced by a fresh session.
            if (this.peers.size === 0 && this.pendingForJoiner === snapshot) {
              this.pendingForJoiner = [];
            }
          },
          5 * 60 * 1000,
        );
      }
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }
}

/**
 * LobbyDO — N-peer presence + invite-relay Durable Object.
 *
 * Unlike RoomDO (capped at 2 peers, dumb message relay), the lobby
 * maintains a roster of devices currently online for a given pair
 * (one lobby per pair secret). Devices use it to discover each other
 * by deviceId+nickname, then exchange invite/invite-ack messages to
 * negotiate a fresh per-session room for the actual WebRTC handshake.
 *
 * Wire protocol
 * -------------
 *   Client → server:
 *     { type: "announce",   payload: { deviceId, nickname, role } }
 *     { type: "invite",     payload: { toDeviceId, sessionRoomId } }
 *     { type: "invite-ack", payload: { toDeviceId, sessionRoomId, accepted, reason? } }
 *     { type: "ping" }
 *
 *   Server → client:
 *     { type: "roster",          payload: [{ deviceId, nickname, role, joinedAt }, ...] }
 *     { type: "invite-received", payload: { fromDeviceId, fromNickname, sessionRoomId } }
 *     { type: "invite-ack",      payload: { fromDeviceId, sessionRoomId, accepted, reason? } }
 *     { type: "pong" }
 *     { type: "error",           payload: { message } }
 *
 * Roles are advisory strings the UI uses for filtering — typically
 * "available" (idle, ready to receive), "sending", or "receiving".
 */
interface LobbyPeer {
  ws: WebSocket;
  deviceId: string;
  nickname: string;
  role: string;
  joinedAt: number;
}

export class LobbyDO implements DurableObject {
  private peers = new Map<WebSocket, LobbyPeer>();

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private accept(ws: WebSocket) {
    ws.accept();
    // No roster entry until the client sends "announce". This keeps
    // ghost sockets out of the roster.

    ws.addEventListener("message", (event) => {
      let msg: { type: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      const payload = msg.payload ?? {};

      if (msg.type === "announce") {
        const deviceId = String(payload.deviceId ?? "");
        const nickname = String(payload.nickname ?? "").slice(0, 80);
        const role = String(payload.role ?? "available").slice(0, 20);
        if (!deviceId || deviceId.length > 64) return;

        // If a different socket already claimed this deviceId, evict it
        // (single session per device — newer tab wins).
        for (const [otherWs, p] of this.peers) {
          if (p.deviceId === deviceId && otherWs !== ws) {
            try { otherWs.close(1000, "replaced by newer session"); } catch { /* */ }
            this.peers.delete(otherWs);
          }
        }

        const existing = this.peers.get(ws);
        this.peers.set(ws, {
          ws,
          deviceId,
          nickname,
          role,
          joinedAt: existing?.joinedAt ?? Date.now(),
        });
        this.broadcastRoster();
        return;
      }

      const self = this.peers.get(ws);
      if (!self) {
        // Haven't announced yet — every other message requires identity.
        try {
          ws.send(JSON.stringify({
            type: "error",
            payload: { message: "Must announce before sending other messages" },
          }));
        } catch { /* */ }
        return;
      }

      if (msg.type === "invite") {
        const toDeviceId = String(payload.toDeviceId ?? "");
        const sessionRoomId = String(payload.sessionRoomId ?? "");
        if (!toDeviceId || !sessionRoomId) return;
        const target = this.findByDeviceId(toDeviceId);
        if (!target) {
          try {
            ws.send(JSON.stringify({
              type: "invite-ack",
              payload: {
                fromDeviceId: toDeviceId,
                sessionRoomId,
                accepted: false,
                reason: "Target device is offline",
              },
            }));
          } catch { /* */ }
          return;
        }
        try {
          target.ws.send(JSON.stringify({
            type: "invite-received",
            payload: {
              fromDeviceId: self.deviceId,
              fromNickname: self.nickname,
              sessionRoomId,
            },
          }));
        } catch { /* */ }
      } else if (msg.type === "invite-ack") {
        const toDeviceId = String(payload.toDeviceId ?? "");
        const sessionRoomId = String(payload.sessionRoomId ?? "");
        const accepted = Boolean(payload.accepted);
        const reason = typeof payload.reason === "string" ? payload.reason : undefined;
        if (!toDeviceId) return;
        const target = this.findByDeviceId(toDeviceId);
        if (!target) return;
        try {
          target.ws.send(JSON.stringify({
            type: "invite-ack",
            payload: {
              fromDeviceId: self.deviceId,
              sessionRoomId,
              accepted,
              reason,
            },
          }));
        } catch { /* */ }
      } else if (msg.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* */ }
      }
    });

    const cleanup = () => {
      this.peers.delete(ws);
      this.broadcastRoster();
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  private findByDeviceId(deviceId: string): LobbyPeer | undefined {
    for (const p of this.peers.values()) {
      if (p.deviceId === deviceId) return p;
    }
    return undefined;
  }

  private broadcastRoster() {
    const roster = Array.from(this.peers.values()).map((p) => ({
      deviceId: p.deviceId,
      nickname: p.nickname,
      role: p.role,
      joinedAt: p.joinedAt,
    }));
    const msg = JSON.stringify({ type: "roster", payload: roster });
    for (const p of this.peers.values()) {
      if (p.ws.readyState === WebSocket.READY_STATE_OPEN) {
        try { p.ws.send(msg); } catch { /* */ }
      }
    }
  }
}

/**
 * CodeDO — short-code pairing Durable Object.
 *
 * Holds the global `code → roomId` map for 4-char Crockford Base32
 * codes. One global instance (`idFromName("global-v1")`) — see the
 * routing wrapper functions above for why.
 *
 * Wire protocol
 * -------------
 *   POST /code/mint?room=<roomId>
 *     → 200 { code: "H7K2", expiresInMs: 60000, expiresAt: <ms> }
 *     → 503 { error: "exhausted" }     (5 collision-retries failed)
 *
 *   POST /code/claim?code=<code>
 *     → 200 { roomId: "<id>" }
 *     → 404 { error: "invalid" }       (code never minted)
 *     → 410 { error: "expired" }       (code existed but TTL elapsed)
 *     → 410 { error: "claimed" }       (single-use; another peer won)
 *
 * Lifecycle
 * ---------
 *   - Memory-only (no SQLite). DO restart loses ≤60s of pending mints.
 *   - Periodic GC sweeps expired entries every 30s.
 *   - Codes are single-use: claim deletes the entry immediately.
 */

// Crockford Base32 — excludes I, L, O, U to avoid visual confusion and
// accidental profanity. https://www.crockford.com/base32.html
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 4;                          // 32^4 = 1,048,576 codes
const CODE_TTL_MS = 60_000;                     // 60s
const CODE_MAX_RETRIES = 5;                     // collision re-rolls
const CODE_GC_INTERVAL_MS = 30_000;             // sweep expired entries

interface CodeRecord {
  roomId: string;
  expiresAt: number;
}

export class CodeDO implements DurableObject {
  private codes = new Map<string, CodeRecord>();
  private gcAlarmScheduled = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/code/mint") {
      return this.mint(url);
    }
    if (url.pathname === "/code/claim") {
      return this.claim(url);
    }
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  }

  private mint(url: URL): Response {
    const room = url.searchParams.get("room") || "";
    // Outer router already validated; defence in depth.
    if (!room || !/^[\w-]+$/.test(room)) {
      return jsonResponse({ error: "invalid room" }, 400);
    }

    // Sweep before generating so the namespace check is accurate.
    this.gcExpired();

    let code = "";
    for (let attempt = 0; attempt < CODE_MAX_RETRIES; attempt++) {
      const candidate = this.generateCode();
      const existing = this.codes.get(candidate);
      // Treat expired-but-not-yet-GC'd entries as free.
      if (!existing || existing.expiresAt < Date.now()) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      return jsonResponse({ error: "exhausted" }, 503);
    }

    const expiresAt = Date.now() + CODE_TTL_MS;
    this.codes.set(code, { roomId: room, expiresAt });
    this.scheduleGc();

    return jsonResponse({
      code,
      expiresInMs: CODE_TTL_MS,
      expiresAt,
    });
  }

  private claim(url: URL): Response {
    const codeRaw = url.searchParams.get("code") || "";
    // Normalise: codes are case-insensitive at input but stored uppercase.
    const code = codeRaw.toUpperCase();

    if (!code || !/^[0-9A-Z]{4,8}$/.test(code)) {
      return jsonResponse({ error: "invalid" }, 400);
    }

    const record = this.codes.get(code);
    if (!record) {
      return jsonResponse({ error: "invalid" }, 404);
    }
    if (record.expiresAt < Date.now()) {
      this.codes.delete(code);
      return jsonResponse({ error: "expired" }, 410);
    }

    // Single-use: delete on claim. A second simultaneous claim sees nothing
    // (atomicity guaranteed by DO's single-threaded event loop).
    this.codes.delete(code);
    return jsonResponse({ roomId: record.roomId });
  }

  private generateCode(): string {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      // Mask to 5 bits → index into 32-char alphabet. Uniform distribution
      // (modulo bias is zero because 256 is a multiple of 32).
      out += CROCKFORD_ALPHABET[bytes[i] & 0x1f];
    }
    return out;
  }

  private gcExpired() {
    const now = Date.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt < now) {
        this.codes.delete(code);
      }
    }
  }

  private scheduleGc() {
    // Self-throttling background sweep. We don't use alarm() because the
    // sweep is cheap and the next mint will trigger it anyway; this is
    // just for the case where the DO sits idle with stale entries.
    if (this.gcAlarmScheduled) return;
    this.gcAlarmScheduled = true;
    setTimeout(() => {
      this.gcAlarmScheduled = false;
      this.gcExpired();
      if (this.codes.size > 0) this.scheduleGc();
    }, CODE_GC_INTERVAL_MS);
  }
}
