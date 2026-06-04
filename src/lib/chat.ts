/**
 * Chat over the open RTCDataChannel — uses the existing TeleportSession.
 *
 * Wire format (all JSON strings — coexists with file `meta` + binary chunks):
 *   { kind: "chat",   id, text, ts }
 *   { kind: "typing", isTyping }
 *
 * Privacy: messages are ephemeral, never persisted, never seen by any server.
 * Same DTLS encryption as file chunks.
 */
import type { TeleportSession } from "./teleportSession";
import { createEmitter } from "./emitter";

export interface ChatMessage {
  id: string;
  text: string;
  ts: number;
}

export interface ChatEvents {
  message: ChatMessage;
  peerTyping: boolean;
  peerDisconnected: void;
  error: Error;
}

const MAX_TEXT_LEN = 2000;
const TYPING_DEBOUNCE_MS = 1000;
const TYPING_AUTO_OFF_MS = 3000;

export class ChatManager {
  readonly emitter = createEmitter<ChatEvents>();
  private lastTypingSent = 0;
  private autoOffTimer: ReturnType<typeof setTimeout> | null = null;
  private currentlyTyping = false;

  constructor(private session: TeleportSession) {
    session.emitter.on("channelMessage", (m) => {
      if (typeof m.data !== "string") return;
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.kind === "chat" && typeof parsed.text === "string") {
          this.emitter.emit("message", {
            id: String(parsed.id ?? Date.now()),
            text: String(parsed.text).slice(0, MAX_TEXT_LEN),
            ts: Number(parsed.ts) || Date.now(),
          });
        } else if (parsed.kind === "typing") {
          this.emitter.emit("peerTyping", Boolean(parsed.isTyping));
        }
      } catch {
        /* not a chat message — file meta or other; ignore */
      }
    });

    session.emitter.on("state", (s) => {
      if (s === "disconnected" || s === "failed") {
        this.emitter.emit("peerDisconnected", undefined);
      }
    });
  }

  /**
   * Send a chat message. Returns the locally-emitted ChatMessage (so the UI
   * can render it immediately). Throws if the data channel is gone.
   */
  send(rawText: string): ChatMessage {
    const text = rawText.trim().slice(0, MAX_TEXT_LEN);
    if (!text) throw new Error("Empty message");
    const msg: ChatMessage = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      ts: Date.now(),
    };
    this.session.send(JSON.stringify({ kind: "chat", ...msg }));
    // Stop showing "you are typing" once you actually send.
    this.setTyping(false);
    return msg;
  }

  /**
   * Notify peer that the user is (or isn't) typing. Debounced so we send at
   * most one `typing:true` per second. Auto-flips to false after 3s of no
   * keystrokes (caller should call `setTyping(true)` on every keystroke).
   */
  setTyping(isTyping: boolean) {
    if (isTyping) {
      const now = Date.now();
      if (!this.currentlyTyping || now - this.lastTypingSent > TYPING_DEBOUNCE_MS) {
        this.safeSend({ kind: "typing", isTyping: true });
        this.lastTypingSent = now;
      }
      this.currentlyTyping = true;
      if (this.autoOffTimer) clearTimeout(this.autoOffTimer);
      this.autoOffTimer = setTimeout(() => this.setTyping(false), TYPING_AUTO_OFF_MS);
    } else {
      if (this.currentlyTyping) {
        this.safeSend({ kind: "typing", isTyping: false });
      }
      this.currentlyTyping = false;
      if (this.autoOffTimer) {
        clearTimeout(this.autoOffTimer);
        this.autoOffTimer = null;
      }
    }
  }

  private safeSend(obj: unknown) {
    try {
      this.session.send(JSON.stringify(obj));
    } catch {
      /* channel may have just closed — chat is best-effort */
    }
  }
}
