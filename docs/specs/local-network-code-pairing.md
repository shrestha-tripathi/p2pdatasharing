# 4-Char Local-Network Code Pairing

**Status:** Spec → in-flight
**Author:** session 2026-06-05
**Related:** `worker/src/index.ts`, `src/pages/transfer.astro`, `src/lib/teleportSession.ts`

## Problem

Two people in the same room want to send a file. Today they must:
1. Share a URL via messenger (annoying with no pre-existing chat), OR
2. Scan a QR code (works, but needs camera alignment + on-screen QR), OR
3. Permanently pair via "My Devices" (overkill for one-off send)

Wanted: type **4 chars on each side, paired**. Industry-standard pattern
(LocalSend, AirDrop, TV pairing, banking OTP) — instantly recognisable.

## Solution

A short, human-readable, time-limited code minted by the sender, claimed
by the receiver via a global Cloudflare Worker DO.

### Code format

**4-char Crockford Base32**, case-insensitive at input.

Alphabet (32 chars):
```
0 1 2 3 4 5 6 7 8 9
A B C D E F G H J K M N P Q R S T V W X Y Z
```

Excludes `I, L, O, U`:
- `I/1`, `L/1`, `O/0` ambiguity gone
- `U` removed by Crockford convention to prevent accidental obscenities
- Side-effect: most explicit 4-letter words can't form (need a vowel + the
  removed `I`/`U`)

Space: `32⁴ = 1,048,576` codes — comfortable through ~100M DAU.

### TTL & lifecycle

- **60 seconds** TTL per code
- **Auto-refresh** on sender: when countdown hits 0, mint a new code and
  redisplay (sender never sees an expired code)
- **Single-use:** first claim wins; further claims get "code already used"
- **Memory-only** in `CodeDO` — no SQLite, codes expire on TTL or claim

### Discovery model

**Code-only.** No IP-bucket grouping (Snapdrop-style). Reasons:

| Issue | IP-bucket | Code |
|---|---|---|
| Home WiFi | ✅ | ✅ |
| Office 200-person NAT | ❌ privacy disaster | ✅ |
| Hotel WiFi | ❌ stranger list | ✅ |
| Corporate VPN | ❌ "your network" is global | ✅ |
| Cellular hotspot | ❌ false negatives | ✅ |
| Two people, different carriers, same room | ❌ no shared IP | ✅ |

We trade Snapdrop's zero-input pairing for **universal-network correctness**.
Codes are 4 chars (less than a name) — friction is minimal.

### Mint-always policy

The sender page mints a code immediately on role-boot, in parallel with QR
rendering. The code is **always visible** next to the QR/link. Three pairing
methods coexist:

- **Link** → remote pairing (chat / DM)
- **QR** → "point phone at laptop"
- **Code** → "walk over and type 4 chars"

User picks whichever fits. No disclosure UI; no "show me a code" click.

### Server-issued (not client-chosen)

Client never picks the code. Server:
1. Generates 4 random Crockford chars
2. Checks collision against active codes
3. Re-rolls up to 5 times on collision (probability of all-5-failing at
   1M concurrent active codes: `(0.95)⁵ ≈ effectively zero`)
4. Returns `{code, expiresInMs, roomId}`

Server-side control means a future format bump (4 → 5 chars, or different
alphabet) requires **zero client coordination**.

## Architecture

### New: `CodeDO` (one global instance)

```ts
class CodeDO {
  // code → { roomId, expiresAt, claimed }
  private codes = new Map<string, CodeRecord>();

  POST /code/mint?room=<roomId>
    → { code: "H7K2", expiresInMs: 60000 }

  POST /code/claim?code=<code>
    → { roomId: "..." }
    | { error: "expired" | "invalid" | "claimed" }
}
```

Routed via `env.CODES.idFromName("global-v1")` — single DO worldwide.

**Why one DO globally:**
- 4-char codes will eventually collide; one authoritative picker prevents
  cross-instance duplicates
- ~10k active mints expected at 1M DAU (~6 mints/sec) → well under DO
  burst limit of 10k req/s

**Why memory-only:**
- 60s TTL means SQLite would just be churn
- DO restart loses ≤60s of pending mints; users re-mint, no data loss

### Existing flow, unchanged

After `/code/claim` returns a roomId:
1. Receiver opens WebSocket to `?room=<roomId>` exactly as today
2. Sender already has that room open (it's the same room shown in QR/link)
3. Standard `RoomDO` handshake runs — **no protocol changes downstream**

### Variable-length tolerance

Worker validation: `/^[0-9A-Za-z]{4,8}$/i` — accepts 4-8 chars. We ship
4 today; bumping to 5 later requires only:
1. Change `CODE_LENGTH = 4` → `5` in Worker
2. Rebuild + deploy

Receiver UI dynamically renders N input boxes based on `CODE_LENGTH`
(via a server-exposed constant or just a sensible cap).

### Rate limiting

**Cloudflare WAF rate rules** (no app code):
- `/code/mint`: 5 req/min per IP
- `/code/claim`: 10 req/min per IP

Stops:
- **Enumeration:** attacker tries codes → caps at 10/min instead of 10k
- **Squatting:** attacker mints 10k codes to exhaust pool → caps at 5/min

(Configured in Cloudflare dashboard, documented in this spec.)

## Wire protocol

### `POST /code/mint`

**Request:**
```
POST https://<worker>/code/mint?room=<roomId>
(no body)
```

**Response 200:**
```json
{
  "code": "H7K2",
  "expiresInMs": 60000,
  "expiresAt": 1717575600000
}
```

**Response 429:** rate-limited (from WAF, not Worker)

**Response 400:** invalid `roomId` (not a 12-hex string)

**Response 503:** code-space exhausted after 5 retries (effectively never)

### `POST /code/claim?code=<code>`

**Request:**
```
POST https://<worker>/code/claim?code=H7K2
(no body)
```

**Response 200:**
```json
{
  "roomId": "abcdef012345"
}
```

**Response 404:**
```json
{ "error": "invalid" }   // code not found / never minted
```

**Response 410:**
```json
{ "error": "expired" }   // code existed but TTL elapsed
{ "error": "claimed" }   // another receiver already claimed it
```

**Response 429:** rate-limited

## Client UI

### Sender (`transfer.astro`)

On role=send boot, in parallel with QR render:

```
┌──────────────────────────────────────────────────────────────┐
│ Send this link to the receiver:                              │
│ [https://filetransfernow.com/transfer?r=ab12cd34ef56] [Copy] │
│                                                              │
│ [Show QR code]  ·  Or use code:  H 7 K 2  ·  expires 0:58    │
│                                                              │
│ Tap to scan from another device 📱                           │
└──────────────────────────────────────────────────────────────┘
```

- Code rendered in monospace, large, kerned (4 boxes or `letter-spacing`)
- Countdown ticks every second
- At 0s: auto-mint new code, replace display, reset countdown to 60s
- On peer connection: countdown stops (code no longer needed)

### Receiver (`transfer.astro`)

Add a third option next to "Paste link" / "Scan QR" in `role-receive-input`:

```
┌──────────────────────────────────────────────────────────┐
│ Got an invite link?                                      │
│ [https://...                                  ] [Join]   │
│ — or — [Scan QR]                                         │
│ — or — Enter 4-char code:                                │
│        [ _ ] [ _ ] [ _ ] [ _ ]   [Connect]               │
└──────────────────────────────────────────────────────────┘
```

- 4 input boxes, monospace, `inputmode="text"`, `autocapitalize="characters"`, `maxlength=1`
- Auto-advance on input, auto-back on backspace
- Paste-aware: pasting `H7K2` distributes across all 4 boxes
- Auto-submits on 4th character (no Connect button click needed for happy path)
- On success: navigate to `?r=<roomId>` (joins same flow as link)
- On error: toast (expired / invalid / claimed) + clear inputs

## Failure modes

| Failure | UX |
|---|---|
| Code expired during typing | Toast: "Code expired — ask for a new one"; clear inputs |
| Wrong code | Toast: "No active session for that code"; clear inputs |
| Network down (mint) | Sender shows "—" + retry button; existing QR/link still works |
| Network down (claim) | Receiver shows toast + retry button |
| CodeDO unreachable | Same as network down; link/QR pairing unaffected |
| Race: two receivers claim same code | First wins; second gets "already claimed" |
| Sender closes tab before claim | Code expires in ≤60s naturally |

## Out of scope

- Voice readout of code (a11y enhancement; future)
- "Send to many" via multiple claims (intentionally single-use)
- Persistent codes across browser restarts (defeats security model)
- 6-char codes (premature; 4 is fine through 100M DAU)
- IP-bucket grouping as a second discovery method (re-evaluate if users ask)
- Profanity filter beyond what Crockford alphabet naturally prevents

## Commits

1. **`feat(signaling): CodeDO + /code/mint + /code/claim`** — Worker class,
   routes, wrangler v3 migration, spec doc
2. **`feat(ui): sender-side pairing code with auto-refresh`** — mint on
   boot, render alongside QR, countdown, re-mint at 0
3. **`feat(ui): receiver-side 4-box code input with paste & autoadvance`** —
   new claim UI in role-receive-input, error toasts, success → join room

## Pre-existing project conventions honoured

- All user-facing strings via i18n-ready inline (matches current transfer.astro)
- No new env vars (CodeDO uses existing binding pattern)
- TS strict (no implicit any)
- Pre-existing `astro check` errors in transfer.astro unaffected
