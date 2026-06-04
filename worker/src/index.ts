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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check (handy for browser smoke test).
    if (url.pathname === "/" && request.headers.get("Upgrade") !== "websocket") {
      return new Response("local-teleport-signaling: alive\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    // Everything else expects a WebSocket upgrade with ?room=<id>.
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const room = url.searchParams.get("room");
    if (!room || room.length > 128 || !/^[\w-]+$/.test(room)) {
      return new Response("Invalid or missing ?room", { status: 400 });
    }

    // Route to the DurableObject for this room.
    const id = env.ROOM.idFromName(room);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};

export class RoomDO implements DurableObject {
  private peers = new Set<WebSocket>();
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.peers.size >= 2) {
      // Reject the third joiner with a friendly close code.
      return new Response("Room full", { status: 423 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.accept(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private accept(ws: WebSocket) {
    ws.accept();
    this.peers.add(ws);

    ws.addEventListener("message", (event) => {
      // Forward verbatim to every other peer in the room.
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
      // No explicit storage clear needed — DOs evict themselves automatically
      // once they're idle and have no in-memory state.
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }
}
