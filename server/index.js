/**
 * Local Teleport — signaling server.
 *
 * Stateless WebSocket router. Maps room IDs to (at most) two connected
 * peers and forwards SDP/ICE messages between them. No persistence, no
 * logging beyond errors. Intentionally tiny.
 *
 * Wire protocol (client ↔ server):
 *   { "room": "abc123", "type": "join" }
 *   { "room": "abc123", "type": "offer",     "payload": <RTCSessionDescriptionInit> }
 *   { "room": "abc123", "type": "answer",    "payload": <RTCSessionDescriptionInit> }
 *   { "room": "abc123", "type": "candidate", "payload": <RTCIceCandidateInit> }
 *
 * Server may emit:
 *   { "type": "error", "payload": { "message": "Room full" } }
 */

import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_PEERS_PER_ROOM = 2;
const PING_INTERVAL_MS = 30_000;

const wss = new WebSocketServer({ port: PORT });
/** roomId -> Set<WebSocket> */
const rooms = new Map();

const sendJson = (ws, obj) => {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket may be gone */
  }
};

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: "error", payload: { message: "Malformed JSON" } });
      return;
    }

    const { room, type } = msg;
    if (typeof room !== "string" || !room || typeof type !== "string") {
      sendJson(ws, { type: "error", payload: { message: "Missing room/type" } });
      return;
    }

    if (!rooms.has(room)) rooms.set(room, new Set());
    const peers = rooms.get(room);

    if (type === "join") {
      if (peers.size >= MAX_PEERS_PER_ROOM && !peers.has(ws)) {
        sendJson(ws, { type: "error", payload: { message: "Room full" } });
        return;
      }
      peers.add(ws);
      ws.roomId = room;
      return;
    }

    // Forward offer/answer/candidate to the other peer(s) in the room.
    for (const peer of peers) {
      if (peer !== ws && peer.readyState === ws.OPEN) {
        sendJson(peer, msg);
      }
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

const leaveRoom = (ws) => {
  if (!ws.roomId) return;
  const peers = rooms.get(ws.roomId);
  if (!peers) return;
  peers.delete(ws);
  if (peers.size === 0) rooms.delete(ws.roomId);
};

// Heartbeat — drop zombie connections that fail to pong.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      leaveRoom(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* noop */
    }
  }
}, PING_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

process.on("SIGINT", () => {
  wss.close(() => process.exit(0));
});

console.log(`[signaling] listening on ws://0.0.0.0:${PORT}`);
