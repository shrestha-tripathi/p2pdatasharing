/**
 * Device pairing — "My Devices" mode.
 *
 * Lets a user link multiple of their own devices (phone <-> laptop) so they
 * auto-connect whenever both are on /transfer, with no QR / link exchange
 * after the one-time pair.
 *
 * Security model:
 *   - Each pair has a 128-bit random `secret` (base32-encoded, ~26 chars).
 *   - The discovery room ID is derived deterministically from the secret via
 *     SHA-256, truncated to 12 hex chars (matches generateRoomId format).
 *   - The secret itself NEVER leaves the device after pairing — only the
 *     hashed room ID hits the signaling server. So the server cannot impersonate
 *     a paired device.
 *   - WebRTC DTLS still provides end-to-end encryption on top.
 *
 * Storage layout (localStorage):
 *   p2pds:devices:pairs   JSON array of Pair
 *   p2pds:devices:autoAccept  "1" | "0"  (auto-accept transfers from paired devices)
 */

const PAIRS_KEY = "p2pds:devices:pairs";
const AUTO_ACCEPT_KEY = "p2pds:devices:autoAccept";

export interface Pair {
  /** Base32-encoded 128-bit shared secret. Stable forever (or until removed). */
  secret: string;
  /** Human label for the OTHER device, set during pairing. */
  nickname: string;
  /** ms since epoch */
  addedAt: number;
  /**
   * True if THIS device originated the pair (i.e. hit "Add device" and
   * generated the secret). False if this device accepted via a pair link.
   * The originator always hosts on the derived room; the acceptor joins.
   * This avoids glare (two devices both creating offers) without needing
   * any signaling-server changes.
   */
  iAmHost: boolean;
}

// ---------- Crypto primitives ----------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648, no padding

/** Encode bytes -> RFC 4648 base32 (no padding, uppercase). */
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode a base32 string -> bytes. Returns null on invalid input. */
export function base32Decode(input: string): Uint8Array | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (cleaned.length === 0) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Generate a fresh 128-bit secret, base32-encoded. */
export function generatePairSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/**
 * Derive the discovery room ID from a pair secret.
 * Same shape as generateRoomId() (12 lowercase hex chars) so the signaling
 * server treats it like any other room.
 */
export async function deriveRoomId(secret: string): Promise<string> {
  const bytes = base32Decode(secret);
  if (!bytes) throw new Error("Invalid pair secret");
  // Domain-separate so a pair secret can't collide with any other hashed
  // identifier we might add later.
  const enc = new TextEncoder();
  const domain = enc.encode("p2pds:device-pair-room:v1");
  const buf = new Uint8Array(domain.length + bytes.length);
  buf.set(domain, 0);
  buf.set(bytes, domain.length);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 12);
}

// ---------- Pair CRUD ----------

function readPairs(): Pair[] {
  try {
    const raw = localStorage.getItem(PAIRS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is Pair =>
        p &&
        typeof p.secret === "string" &&
        typeof p.nickname === "string" &&
        typeof p.addedAt === "number",
    ).map((p): Pair => ({
      secret: p.secret,
      nickname: p.nickname,
      addedAt: p.addedAt,
      // Back-compat: pairs saved before phase 3 had no role flag.
      // Assume host (the originator was the most common first-mover).
      iAmHost: typeof (p as Pair).iAmHost === "boolean" ? (p as Pair).iAmHost : true,
    }));
  } catch {
    return [];
  }
}

function writePairs(pairs: Pair[]): void {
  try {
    localStorage.setItem(PAIRS_KEY, JSON.stringify(pairs));
  } catch {
    // Quota or privacy mode — silently drop, caller should surface a warning.
  }
}

export function listPairs(): Pair[] {
  return readPairs();
}

/**
 * Add or replace a pair with the given secret. If the secret already exists
 * we update the nickname (most-recent-wins) but keep the original addedAt.
 */
export function upsertPair(secret: string, nickname: string, iAmHost: boolean): Pair {
  const cleanedSecret = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const cleanedName = nickname.trim().slice(0, 40) || "Unnamed device";
  const pairs = readPairs();
  const existing = pairs.find((p) => p.secret === cleanedSecret);
  if (existing) {
    existing.nickname = cleanedName;
    // Don't override role on re-pair — first write wins.
    writePairs(pairs);
    return existing;
  }
  const fresh: Pair = { secret: cleanedSecret, nickname: cleanedName, addedAt: Date.now(), iAmHost };
  pairs.push(fresh);
  writePairs(pairs);
  return fresh;
}

export function removePair(secret: string): boolean {
  const pairs = readPairs();
  const next = pairs.filter((p) => p.secret !== secret);
  if (next.length === pairs.length) return false;
  writePairs(next);
  return true;
}

export function renamePair(secret: string, nickname: string): boolean {
  const pairs = readPairs();
  const target = pairs.find((p) => p.secret === secret);
  if (!target) return false;
  target.nickname = nickname.trim().slice(0, 40) || "Unnamed device";
  writePairs(pairs);
  return true;
}

export function findPair(secret: string): Pair | undefined {
  return readPairs().find((p) => p.secret === secret);
}

// ---------- Auto-accept toggle ----------

export function getAutoAccept(): boolean {
  try {
    return localStorage.getItem(AUTO_ACCEPT_KEY) !== "0"; // default ON
  } catch {
    return true;
  }
}

export function setAutoAccept(on: boolean): void {
  try {
    localStorage.setItem(AUTO_ACCEPT_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
}

// ---------- Pair URL helpers ----------

/**
 * Build the "open me on the other device" URL.
 * Uses URL fragment so the secret never reaches the server, isn't logged
 * by analytics, and isn't included in Referer headers.
 *
 *   https://site/transfer#pair=BASE32&name=URLEncodedNickname
 */
export function buildPairUrl(origin: string, basePath: string, secret: string, myNickname: string): string {
  const base = `${origin}${basePath}transfer`;
  const params = new URLSearchParams();
  params.set("pair", secret);
  if (myNickname) params.set("name", myNickname);
  return `${base}#${params.toString()}`;
}

/**
 * Parse a pair fragment from the current URL (or any URL).
 * Returns null if the fragment doesn't contain a valid `pair=` token.
 */
export function parsePairFragment(hash: string): { secret: string; nickname: string } | null {
  if (!hash) return null;
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(trimmed);
  const secret = params.get("pair");
  if (!secret) return null;
  const cleaned = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  // 128 bits => 26 chars of base32 (since ceil(128/5)=26). Allow some slack
  // in case of stray padding/quoting.
  if (cleaned.length < 20 || cleaned.length > 32) return null;
  return { secret: cleaned, nickname: (params.get("name") || "").slice(0, 40) };
}
