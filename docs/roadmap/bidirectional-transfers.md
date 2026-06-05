# Bidirectional File Transfers

**Status:** Roadmap / spec draft (not yet implementation-ready)
**Author:** session 2026-06-05
**Related:** `src/lib/teleportSession.ts`, `src/lib/fileTransfer.ts`, `src/pages/transfer.astro`, `docs/specs/layer-3-resume.md`
**Estimated work:** 600-900 LOC across 3 commits, ~3-5 working days
**Risk:** Medium-high — touches the wire protocol AND the UI shell

---

## Problem

Today FileTransferNow is **half-duplex**: at pairing time each peer is locked
into either "Sender" or "Receiver" for the life of the session.

| Friction | Concrete example |
|---|---|
| To swap direction, both peers must reload | "Got your photos, now send me back the edited version" → reload + repair |
| Two-way batches are tedious | Mom sends 12 vacation pics, then needs the laptop-to-phone leg → second pairing dance |
| Conflicts with "My Devices" persistent pairs | A pre-paired phone↔laptop should feel like AirDrop — either side initiates anytime |
| Cancel UX is asymmetric | Receiver can't cancel, only sender. Once you become receiver, you wait. |

For the **persistent device-pair flow** (already shipped) this asymmetry is
particularly awkward — the pair already trusts each other; arbitrarily
designating one side as "the sender for this session" is a UX wart inherited
from the original ad-hoc room model.

**Goal:** after the data channel opens, either peer can drop a file at any time
and it streams to the other side. The words "sender" and "receiver" disappear
from the UI. Symmetric model, like AirDrop / LocalSend / Nearby Share.

---

## Current architecture (what we'd be changing)

### Signaling layer — `teleportSession.ts`

```ts
export type PeerRole = "sender" | "receiver";

private role: PeerRole = "sender";
```

The `role` is essentially **"who creates the SDP offer"**:
- Sender → calls `peer.createOffer()`, creates the data channel via
  `peer.createDataChannel("file")`
- Receiver → waits for `peer.ondatachannel` to fire after the answer is set

After the channel opens, **WebRTC itself is fully symmetric**. The `role`
field only continues to matter because the application layer above
(`fileTransfer.ts`) is half-duplex.

### Data layer — `fileTransfer.ts`

```ts
// Receiver state — single mutable slot, one inbound file at a time
private rxMeta: FileMeta | null = null;
private rxHandle: FileSystemWritableFileStream | null = null;
private rxBytes = 0;

// Sender state — tracked per call, but only one concurrent outbound transfer
// because send() is serialized by the for-loop in sendMultiple*()
```

The receiver code reads from a single `rxMeta` slot. The wire format
implicitly assumes "the side that sent `meta` first owns the channel until
the file completes." There's no direction tag; no concept of two concurrent
streams in opposite directions.

### UI shell — `transfer.astro`

10+ hard role gates:

```ts
if (role === "sender") { ... }
if (role === "receiver") { ... }
resetSendMoreBtn.classList.toggle("hidden", role !== "sender");
statusRole.textContent = `${myName} · ${role === "receiver" ? "Receiver" : "Sender"}`;
```

Plus the entire page layout splits into "Sender drop zone" vs "Receiver
waiting" panels.

---

## Design options

### Option A — Direction tag on meta frame (minimal)

Add a `from` field to the wire meta frame so receiver knows whose perspective
it's from. UI sprouts a drop zone on the receiver side too. Channel is shared.

```jsonc
// before
{ "kind": "meta", "id": "...", "name": "img.jpg", "size": 1024 }

// after
{ "kind": "meta", "id": "...", "name": "img.jpg", "size": 1024, "from": "A" }
```

| Pros | Cons |
|---|---|
| Tiny wire change | Doesn't solve concurrent bidirectional sends — still one rxMeta slot |
| Backward-compatible (old peers ignore `from`) | UI still implicitly thinks of "the other one" as receiver |
| Receiver can now send too, but only when no other transfer is active | Doesn't address chunk-interleaving on a single channel — both peers' chunks would race |

**Verdict:** Insufficient. Solves UI symmetry but leaves the data layer half-duplex.

### Option B — Per-stream rx state (multi-direction, single channel)

Same single data channel, but receiver state becomes a `Map<id, RxStream>`
keyed by file id. Both peers can have multiple inbound streams at any time.
Chunks are framed with their file id so the receiver can demux.

```ts
// new chunk frame format
[8-byte id prefix][bytes...]
// OR: continue using JSON meta + binary, but require strict serialization
// per file id, with the receiver picking the right rxStream based on
// the most recent meta of the matching id.
```

| Pros | Cons |
|---|---|
| True bidirectional, multiple concurrent streams | Wire format breaking change — every binary chunk needs an id header |
| One channel = one DTLS context = best congestion control | Receiver code becomes a demuxer; more state to track |
| Symmetric — both sides look identical | UI must handle interleaved progress events for many files |

### Option C — Two data channels, one per direction (recommended)

Open a **second** data channel from receiver→sender at pairing time. Each
channel is half-duplex (matches today's protocol), but together the pair is
full-duplex.

```ts
// At pairing time:
//   Sender (offerer): creates channel "ab" → A→B traffic
//   Receiver (answerer): on data channel "ab" arriving, also creates "ba" → B→A traffic
```

Wire format on each channel is **completely unchanged** — every meta frame
and chunk on channel "ab" is implicitly A→B, no direction tag needed.

| Pros | Cons |
|---|---|
| **Zero wire-format change** — existing fileTransfer.ts works per-channel | Two channels = slightly more memory + two `bufferedAmountLow` listeners |
| Receiver state stays a single slot per channel | Two `FileTransfer` instances (one per channel) need to share UI |
| Concurrent bidirectional sends naturally interleave (each on its own DTLS lane) | Slight backward-compat risk if old peers don't expect a second channel |
| Easy mental model: each channel is just today's protocol | Negotiation: receiver must wait for sender's channel then open its own |

**Verdict:** Best risk/reward. We keep all the existing fileTransfer.ts logic
(cancel, resume, retry, queue) and just instantiate it twice.

### Comparison summary

|  | A (direction tag) | B (multi-stream demux) | C (dual channel) |
|---|---|---|---|
| Wire change | Tiny | Breaking | None per-channel |
| Concurrent bi-directional | ❌ | ✅ | ✅ |
| fileTransfer.ts changes | UI only | Major rewrite | None (instantiate 2x) |
| UI changes | Medium | Large | Medium |
| Backward compat with old clients | ✅ | ❌ | ⚠️ Negotiable (see below) |
| Cancel/resume work today | ✅ | Rework needed | ✅ |

---

## Chosen approach: Option C — dual data channels

### High-level architecture after change

```
                       ┌──────────────────────────────┐
                       │   Single PeerConnection      │
                       │                              │
   ┌────────────┐      │  ┌─────────────────────┐    │      ┌────────────┐
   │  Peer A    │◄────►│  │ Channel "ab"        │◄───┼─────►│   Peer B   │
   │            │      │  │ (A → B file bytes)  │    │      │            │
   │ FileTransfer      │  └─────────────────────┘    │      │ FileTransfer
   │  for "ab"  │      │  ┌─────────────────────┐    │      │  for "ba"  │
   │            │◄────►│  │ Channel "ba"        │◄───┼─────►│            │
   │ FileTransfer      │  │ (B → A file bytes)  │    │      │ FileTransfer
   │  for "ba"  │      │  └─────────────────────┘    │      │  for "ab"  │
   └────────────┘      └──────────────────────────────┘      └────────────┘
        │                                                          │
        │  outbound: channel "ab" (its FileTransfer.send)          │
        │  inbound:  channel "ba" (its FileTransfer.emitter)       │
        │                                                          │
        ▼                                                          ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  Single unified UI: drop zone + inbox + chat                    │
   │  Rows tagged with direction emoji (↑ / ↓) instead of role       │
   └─────────────────────────────────────────────────────────────────┘
```

### Channel naming

- Initiator-of-offer creates `outbound-A` → receiver gets it as `inbound`
- Receiver creates `outbound-B` → initiator gets it as `inbound`
- For per-peer code, we abstract this as **`outbound` / `inbound`** locally —
  the wire labels are arbitrary as long as they're distinct per direction

### Two `FileTransfer` instances per peer

```ts
class TeleportSession {
  /** Channel we send on. */
  outboundChannel: RTCDataChannel | null = null;
  /** Channel we receive on. */
  inboundChannel: RTCDataChannel | null = null;

  /** Wraps outboundChannel — used for send(), cancel(), sendMultiple(). */
  outboundTransfer: FileTransfer | null = null;
  /** Wraps inboundChannel — emits receiveStart, receiveProgress, receiveCancelled. */
  inboundTransfer: FileTransfer | null = null;
}
```

Each `FileTransfer` operates on its own channel. The existing code doesn't
change — we just instantiate it twice, with each instance bound to a
different RTCDataChannel. The instances share heartbeat/chat/reconnect
infrastructure at the session level.

### Wire frames stay identical

Every existing frame (`meta`, `resumeAnswer`, `cancel`, `done`, chunks) flies
on the channel that owns that direction. No version bump, no new fields.

### Backward-compat: detection + fallback

Old clients (pre-bidirectional) won't open a second channel. The new client
detects this:

1. After ICE completes, new client creates `outbound-B` if it's the answerer
2. Watches `peer.ondatachannel` — if the partner is new too, their `outbound-A`
   arrives within a few RTTs
3. If 5 seconds elapse with no second channel from the partner, assume legacy
   peer and degrade to half-duplex (hide the drop zone on the answerer side,
   restore old "Receiver waiting" UI)

Detection is best-effort; the UI smoothly degrades.

### Negotiation gotcha — perfect negotiation pattern

WebRTC has a known issue when both sides try to call `createDataChannel`
simultaneously. Use the **perfect negotiation** convention:

- Whichever peer is the "polite" peer (the answerer in our model) creates
  its `outbound` channel **only after** receiving the impolite peer's channel
  via `ondatachannel`. This serializes the two channel-creation events on
  the same SDP negotiation cycle, no race.

---

## UI redesign

### Before — split layout

```
┌─────────────────────┐  ┌─────────────────────┐
│  Sender drop zone   │  │  Receiver waiting   │
│  + queue            │  │  + inbox            │
│  + chat (left)      │  │  + chat (right)     │
└─────────────────────┘  └─────────────────────┘
       (sender only)             (receiver only)
```

### After — unified, role-free

```
┌──────────────────────────────────────────────┐
│  Drop / pick zone                            │
│  (visible to both peers)                     │
└──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┐
│  Transfers                                   │
│   ↑ IMG_4225.mov · 17% · 325 KB/s · Cancel  │
│   ↓ Photo_Album.zip · 84% · ETA 1m 02s      │
│   ↑ Notes.pdf · Queued · 3 of 5             │
│   ↓ ✓ resume.docx · Saved                   │
└──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┐
│  Chat (unchanged)                            │
└──────────────────────────────────────────────┘
```

Direction is conveyed by a single glyph (↑ outbound, ↓ inbound) and the
existing "Sending" / "Receiving" pill becomes a direction-aware verb.

### Pages affected

- `src/pages/transfer.astro` — biggest churn (UI shell)
- `src/components/MechanismAnimation.astro` — currently shows arrow
  pointing right (sender → receiver). New design: animation alternates
  direction, or shows two simultaneous arcs (one each way)
- `src/components/OldWayDiagram.astro` / `NewWayDiagram.astro` —
  unchanged (still about cloud vs. direct, not direction)

---

## Cancel UX in a bidirectional world

The receiver's existing `receiveCancelled` event (commit `722d218`) becomes
**doubly useful**: when peer A cancels their outbound, peer B's inbound
row gets the "✕ Cancelled by sender" flip. Same code path, both sides
now reciprocal.

New: **receiver can cancel their inbound transfer**. The mechanism mirrors
the cancel-from-sender flow:

```jsonc
{ "kind": "cancelRequest", "id": "..." }
```

Sent on the inbound channel (i.e. the channel the receiver is consuming
from). The sender of that channel observes the frame in its `handleMessage`
and treats it identically to a local `cancel(id)` call.

The wire-protocol kind name `cancelRequest` is distinct from `cancel` to
avoid ambiguity at the receiver-of-cancel:
- `cancel` = "I (sender of this channel) am aborting; close your handle"
- `cancelRequest` = "I (receiver of this channel) want you to stop sending"

---

## Migration plan — 3 commits

### Commit 1 — Plumb a second data channel through `teleportSession`

- Add `outboundChannel` / `inboundChannel` fields
- After ICE: if answerer, wait for offerer's channel, then `createDataChannel("outbound-B")`
- Detection timer (5s) — if no second channel arrives, mark partner legacy,
  fire `bidirectional: false` event
- Heartbeat continues to run only on `inboundChannel` (one timer is enough)
- Existing `session.channel` (singular) stays as a getter aliasing
  `outboundChannel` for backward-compat with the rest of the codebase

**Scope:** ~150 LOC in `teleportSession.ts`, no UI changes yet
**Risk:** Medium — channel negotiation races

### Commit 2 — Instantiate `FileTransfer` twice in the page bootstrap

- `outboundTransfer = new FileTransfer(session, "outbound")`
- `inboundTransfer = new FileTransfer(session, "inbound")`
- UI listens to both — `outboundTransfer.emitter.on("sendStart", ...)` for ↑ rows,
  `inboundTransfer.emitter.on("receiveStart", ...)` for ↓ rows
- `FileTransfer` constructor needs to take a channel selector or the channel
  directly (currently it reads `session.channel`)
- Existing `transfer.send(file)` → `outboundTransfer.send(file)` everywhere
- Receiver-side drop zone wired up for the answerer too (was hidden before)

**Scope:** ~200 LOC across `fileTransfer.ts` (constructor + channel param)
and `transfer.astro` (UI dedupe + drop zone visibility)
**Risk:** Low — same logic, just split

### Commit 3 — UI symmetrization

- Remove all `role === "sender"` / `role === "receiver"` UI gates from
  `transfer.astro` except the status-pill display
- Status pill changes from "Sender ↔ Receiver" to "You ↔ Peer Name"
- Row rendering: tag by direction (↑/↓) instead of "Sending"/"Receiving"
- Receiver-cancel button (new `cancelRequest` wire frame)
- Backward-compat: if `bidirectional: false`, fall back to the old
  role-gated UI; surface a small "partner needs to update" hint

**Scope:** ~300-400 LOC, mostly deletions of role checks + new direction
rendering + cancelRequest plumbing
**Risk:** Medium — biggest UI churn; needs careful regression testing of
the existing single-direction flow

---

## Non-goals

- **No multiple concurrent files per direction.** Both `outboundTransfer`
  and `inboundTransfer` still serialize files within their direction —
  the existing queue mechanism is reused. Different *directions* are
  concurrent; different files in the *same* direction still queue.
- **No conflict resolution for "both peers send the same file."** It's two
  independent transfers in opposite directions; receiver-side dedupe
  (by content hash) is a separate feature.
- **No "broadcast send" to multiple paired devices.** Pairing remains 1:1.
  Multi-peer fan-out is a different problem (requires SFU or per-peer
  bandwidth budgeting).
- **No bandwidth fairness between the two directions.** WebRTC's SCTP
  per-channel scheduling handles this passively. We don't impose
  application-layer rate limits.

---

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Channel-creation race on simultaneous open | Medium | Channel never opens | Perfect negotiation pattern — polite peer waits |
| Old client doesn't get second channel | Always (until partner updates) | Half-duplex fallback | 5s detection + graceful degrade |
| Two `FileTransfer` instances confuse heartbeat ownership | Medium | Phantom disconnect events | Heartbeat lives at session level, owns neither transfer |
| User sends bidirectionally on a slow link → both bars stall | Low | Confusing UX | Surface a small "throughput shared with peer's send" tooltip |
| Cancel-request from receiver arrives after sender already completed | Low | No-op (sender ignores unknown id) | Idempotent — same pattern as today's cancel |
| `bufferedAmount` budgeting differs per channel | Low | Slight throughput dip | Tune `bufferedAmountLowThreshold` independently |
| Chat lives on one channel only — which? | Definite | Bidirectional chat breaks if we pick wrong channel | Pick `inbound` channel for chat — it's always present, both sides agree |

---

## Open questions

1. **Should chat move to its own dedicated data channel?** Today chat
   shares the file channel. With two channels available, isolating chat
   on the inbound one (or a third "control" channel) avoids chat latency
   spikes during big transfers. Recommend deciding when implementing
   Commit 2.

2. **How do we handle a paired-device flow where the user adds a new
   device while a transfer is in flight?** Out-of-scope for v1 of
   bidirectional; the device pair model is 1:1 anyway. Note for future.

3. **Telemetry — do we want to track ratio of bidirectional vs. legacy
   sessions?** Yes, helps decide when we can drop the fallback. Add an
   anonymous counter via existing GA event.

4. **Mobile keyboard collapsing the drop zone when chat focuses?**
   Existing problem; bidirectional UI inherits it. Track separately.

---

## Success criteria

A user opens FileTransferNow on two devices, pairs them (via QR or code),
and:

1. From phone, drops a 50 MB file → laptop receives it
2. **Without reloading**, drops a different file from laptop → phone receives it
3. **Simultaneously**, both peers drop files at the same time → both
   transfers proceed in parallel, no row stomping, no progress mixing
4. Either peer can cancel either direction; UI reflects the cancel on
   the partner within ~100ms (matches current cancel latency)
5. Existing receiver-only / sender-only flows still work when one peer
   is on an older client (graceful degrade)

When all 5 hold, ship.

---

## Appendix: why not WebTransport / WebSocket Streams?

These were considered briefly:

- **WebTransport** — symmetric streams natively, would be a cleaner fit,
  but Safari support is still partial as of 2026 Q1. Not a goal-blocker
  for v1.
- **WebSocket through worker** — defeats the entire P2P value prop
  (worker would see bytes, also bandwidth costs).

WebRTC remains the right choice. The dual-channel pattern is a well-trodden
WebRTC idiom (used by Jitsi, Daily, BBB for screen-share vs. camera).
