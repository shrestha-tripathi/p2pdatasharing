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

    // Everything else expects a WebSocket upgrade with ?room=<id>.
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
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
