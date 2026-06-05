/**
 * Short-code pairing client — wraps the Worker's `/code/mint` and
 * `/code/claim` endpoints. See docs/specs/local-network-code-pairing.md
 * and worker/src/index.ts → CodeDO for the wire protocol.
 *
 * Codes are 4-char Crockford Base32 (case-insensitive at input). The
 * Worker normalises to uppercase server-side, so this client doesn't
 * need to upper-case before sending.
 */

export interface MintedCode {
  code: string;
  /** ms until the code expires (typically 60000). */
  expiresInMs: number;
  /** Absolute server timestamp (Date.now()) when the code expires. */
  expiresAt: number;
}

export type ClaimError =
  | "invalid"  // code never minted or wrong format
  | "expired"  // code existed but TTL elapsed
  | "claimed"  // single-use; another peer won the race
  | "network"; // fetch failed entirely

export interface ClaimResult {
  roomId?: string;
  error?: ClaimError;
}

/** Convert the configured ws:// signaling URL to its http base. */
function httpBase(signalingUrl: string): string {
  return signalingUrl.replace(/^ws/, "http");
}

/**
 * Ask the Worker to mint a fresh short code bound to `roomId`. Returns
 * `null` on any failure (network, server, format) so callers can fall
 * back to QR/link gracefully — no exceptions thrown.
 */
export async function mintCode(
  signalingUrl: string,
  roomId: string,
): Promise<MintedCode | null> {
  try {
    const url = new URL("/code/mint", httpBase(signalingUrl));
    url.searchParams.set("room", roomId);
    const res = await fetch(url.toString(), { method: "POST" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<MintedCode>;
    if (!data.code || typeof data.expiresInMs !== "number") return null;
    return {
      code: String(data.code).toUpperCase(),
      expiresInMs: data.expiresInMs,
      expiresAt: typeof data.expiresAt === "number"
        ? data.expiresAt
        : Date.now() + data.expiresInMs,
    };
  } catch {
    return null;
  }
}

/**
 * Try to claim a code. Returns a result object that's either `{roomId}`
 * or `{error}` — never throws.
 */
export async function claimCode(
  signalingUrl: string,
  code: string,
): Promise<ClaimResult> {
  try {
    const url = new URL("/code/claim", httpBase(signalingUrl));
    url.searchParams.set("code", code);
    const res = await fetch(url.toString(), { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as {
      roomId?: string;
      error?: string;
    };

    if (res.ok && data.roomId) {
      return { roomId: data.roomId };
    }

    // Map the Worker's error string to our union type.
    switch (data.error) {
      case "invalid":
      case "expired":
      case "claimed":
        return { error: data.error };
      default:
        return { error: "invalid" };
    }
  } catch {
    return { error: "network" };
  }
}
