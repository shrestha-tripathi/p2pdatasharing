/**
 * Chat over the open RTCDataChannel — uses the existing TeleportSession.
 *
 * Wire format (all JSON strings — coexists with file `meta` + binary chunks):
 *   { kind: "chat",   id, text, ts }
 *   { kind: "typing", isTyping }
 *   { kind: "hello",  name }    // nickname exchange on channel open
 *   { kind: "visibility", hidden }  // peer tab visibility (mobile background detection)
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
  peerHello: { name: string };
  peerVisibility: { hidden: boolean };
  error: Error;
}

const MAX_TEXT_LEN = 2000;
const MAX_NAME_LEN = 40;
const TYPING_DEBOUNCE_MS = 1000;
const TYPING_AUTO_OFF_MS = 3000;

export class ChatManager {
  readonly emitter = createEmitter<ChatEvents>();
  private lastTypingSent = 0;
  private autoOffTimer: ReturnType<typeof setTimeout> | null = null;
  private currentlyTyping = false;
  private myName: string | null = null;
  private helloSent = false;

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
        } else if (parsed.kind === "hello" && typeof parsed.name === "string") {
          const name = String(parsed.name).trim().slice(0, MAX_NAME_LEN);
          if (name) this.emitter.emit("peerHello", { name });
        } else if (parsed.kind === "visibility") {
          this.emitter.emit("peerVisibility", { hidden: Boolean(parsed.hidden) });
        }
      } catch {
        /* not a chat message — file meta or other; ignore */
      }
    });

    session.emitter.on("channelOpen", () => {
      // Re-send hello on every channel open (covers reconnects).
      this.helloSent = false;
      this.sendHelloIfReady();
    });

    session.emitter.on("state", (s) => {
      // Only treat 'failed' as terminal — 'disconnected' fires transiently
      // during ICE renegotiation on mobile networks and recovers shortly.
      if (s === "failed") {
        this.emitter.emit("peerDisconnected", undefined);
      }
    });
  }

  /** Set local nickname. Triggers a hello to the peer if channel is up. */
  setMyName(name: string) {
    const clean = name.trim().slice(0, MAX_NAME_LEN);
    this.myName = clean || null;
    this.helloSent = false;
    this.sendHelloIfReady();
  }

  private sendHelloIfReady() {
    if (this.helloSent || !this.myName) return;
    try {
      this.session.send(JSON.stringify({ kind: "hello", name: this.myName }));
      this.helloSent = true;
    } catch {
      // Channel not open yet — channelOpen handler will retry
    }
  }

  /** Announce local tab visibility to peer (best-effort, silent on failure). */
  sendVisibility(hidden: boolean) {
    try {
      this.session.send(JSON.stringify({ kind: "visibility", hidden }));
    } catch { /* channel not ready — ignore */ }
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
