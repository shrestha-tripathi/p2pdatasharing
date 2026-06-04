# Layer 3 — Resume-from-Offset: Spec & Gap Analysis

**Status:** Existing implementation is ~70% complete. This spec documents what's
already shipping vs. what needs to land, focusing only on the **real gaps** that
hurt prod reliability — no rebuilding what works.

**File scope:** `src/lib/fileTransfer.ts`, marginal touches to
`src/lib/teleportSession.ts`. **No worker changes.**

---

## ✅ Already shipped (verified by reading the code)

| Feature | Where | How |
|---|---|---|
| Stable per-file UUID (`meta.id`) | `fileTransfer.ts:32-38, 64-68` | `crypto.randomUUID()` per `send()` call |
| OPFS persistence of partials keyed by UUID | `fileTransfer.ts:381-411` | `root.getFileHandle(meta.id, {create:...})` |
| Receiver auto-detects partial size | `fileTransfer.ts:389-402` | reads existing OPFS file's `.size` |
| Receiver answers with resume offset | `fileTransfer.ts:397, 422-423` | `{kind:"resumeAnswer", id, offset}` |
| Sender waits for resumeAnswer (5s timeout) | `fileTransfer.ts:159, 280-292` | `awaitResumeAnswer()` promise |
| Sender slices file from resume offset | `fileTransfer.ts:164-167` | `file.slice(sliceFrom).stream()` |
| Send retry loop (8 attempts, 30s timeout each) | `fileTransfer.ts:113-131` | `awaitChannelOpen` then `sendOnce` again |
| "Already complete" edge case | `fileTransfer.ts:393-402, 173-185` | early-emit `receiveComplete`, skip transfer |
| Receiver UI shows resumed-from indicator | `transfer.astro:1653-1658` | `showResumeBadge()` |
| Sender UI shows resumed-from indicator | `transfer.astro:1685-1690` | same |
| Race-condition fix (queue-based message handler) | `fileTransfer.ts:21-27, 88-97` | `rxQueue` Promise chain |

**Bottom line:** if a transfer drops mid-flight and the channel reconnects
within 30s × 8 = 4 min, **the file resumes from the last on-disk byte** today.

---

## 🔴 Real gaps (what this spec actually adds)

### Gap A — Heartbeat-induced reconnect can outlast the 30s `awaitChannelOpen` window

**Problem:** Layer 4 force-closes the channel when peer goes silent. Sender's
retry loop calls `awaitChannelOpen(30_000)`. On flaky mobile networks, the
TURN renegotiation through `restartAsHost` + `peer-rejoined` can take 45-90s.
We give up too soon and surface a fake error.

**Fix:** Make the timeout adaptive:
- Default: 30s (unchanged)
- **If we just received a `stalled` event** (within last 60s): bump to 90s
- If we just received a `state: "failed"`: bump to 90s

Tiny code change in `awaitChannelOpen()` — track `lastStallAt` in `FileTransfer`,
look it up on each retry.

### Gap B — Resume timeout (5s) is too short for slow networks

**Problem:** Receiver's `resumeAnswer` reply travels through the same flaky
channel. On a freshly-reconnected TURN-relayed link, the round trip can take
2-4s just for the TCP/UDP path to warm up. The current 5s `RESUME_ANSWER_TIMEOUT_MS`
trips false-positive → sender treats it as "legacy receiver, restart from 0"
→ **wipes the resume benefit on the very networks that need it most.**

**Fix:** Bump to 12s. If timeout still fires, surface a warning emit so we know.
Cheap and high-impact.

### Gap C — Orphaned OPFS partials accumulate forever

**Problem:** Every file the user *almost* received leaves a partial OPFS blob
named by UUID. After weeks of use, this consumes quota silently until OPFS
storage estimates fail and `beginReceive()` rejects with "Not enough storage."

**Fix:** Garbage-collect on `receiveComplete` (existing path) AND on a
best-effort sweep at `FileTransfer` construction:
- Sweep finds OPFS entries with names matching `/^[0-9a-f-]{36}$/` (UUID shape)
- For each: if mtime > 7 days old AND not in any active session, delete
- Also drop on explicit "Clear list" (receiver-side button already exists)

### Gap D — Sender's `pendingResumes` map leaks on abandoned transfers

**Problem:** If a transfer fails terminally (8 retries exhausted, user closes
tab), the `pendingResumes` entry is never deleted (timeout DOES fire eventually
and calls `.delete`, but only after `RESUME_ANSWER_TIMEOUT_MS`). Minor leak.

**Fix:** Delete the entry inside the `catch` of `sendOnce()` and in `awaitResumeAnswer`'s
finalize path on terminal abort. Tiny.

### Gap E — `MAX_ATTEMPTS = 8` × no user-visible "give up" affordance

**Problem:** A transfer can sit "Reconnecting…" for up to 4 minutes silently
before the error toast finally fires. Users assume it's stuck and refresh,
losing the OPFS partial state (well — it persists, but the *sender* loses
their File handle which can't be reconstructed without re-drag).

**Fix:** Per-file UI control:
- "Cancel transfer" button on each active row that aborts the retry loop
- Emit `sendProgress` with `attempt` count in metadata, UI shows "Retry 3/8…"
- Auto-give-up at 8 attempts → error toast → "Drag the file again to retry"

This is more UX than reliability but materially reduces "stuck" perception.

### Gap F — Receiver-side partial doesn't validate size match

**Problem:** Extremely unlikely with UUIDs, but if the OPFS already holds a
partial with the same `id` but the incoming `meta.size` differs (would imply
sender re-rolled the UUID or version mismatch), we'd start writing wrong-sized
content over correct content.

**Fix:** In `beginReceive`, if `existing.size > 0` AND `meta.size` differs
from any previously-recorded expected-size for this id, **wipe and restart**
rather than appending. Need a small sidecar OPFS file or `meta.size` written
into the first chunk header. Cheapest version: just check `existing.size > meta.size`
and wipe if so (mismatch in the other direction).

### Gap G — Sender can't recover from its OWN tab refresh

**Acknowledge but punt:** Browsers don't allow re-opening a `File` object
from disk path after a refresh. The receiver-side partial survives, but the
sender has lost the File reference and would need the user to re-drag.

**Out of scope for this spec.** Solving it requires asking for OPFS write
access for sender too, or File System Access API persistent permissions.
Documented as a known limitation, deferred.

---

## 📋 Implementation plan (3 commits, ~2 hours total)

### Commit 1: Reliability hardening (Gaps A + B + D + F)
Touches `fileTransfer.ts` only. ~30 min.
- Track `lastStallAt` in FileTransfer; subscribe to `session.emitter.on("stalled", ...)`
- Replace fixed 30s `awaitChannelOpen` with adaptive `computeReconnectTimeout()`
- Bump `RESUME_ANSWER_TIMEOUT_MS` from 5_000 → 12_000
- Emit `resumeTimeout` warning event on timeout fall-through
- Add `pendingResumes.delete(id)` on sendOnce catch path
- Size-mismatch guard in `beginReceive`

### Commit 2: OPFS GC (Gap C)
Touches `fileTransfer.ts`. ~20 min.
- New `garbageCollectOldPartials()` method called in constructor
- Sweeps UUID-named files in OPFS root
- Deletes if `lastModifiedDate < now - 7 days`
- Wrap in try/catch; never block transfer if GC fails

### Commit 3: UX — retry counter + cancel button (Gap E)
Touches `fileTransfer.ts` (emit attempt count) + `transfer.astro` (UI). ~30 min.
- Add `attempt: number` field to `sendProgress` and `sendStart`
- Add `cancel(fileId)` method on FileTransfer that sets a `cancelled` flag
- UI: per-row cancel button while transfer active
- UI: "Reconnecting (3/8)…" status label during retry waits

---

## ❌ Explicitly NOT shipping in Layer 3

- **Sender-side tab-refresh recovery** (Gap G) — needs separate spec
- **Cross-device resume** (e.g. partial received on phone, completes on laptop)
  — would need cloud storage, violates "zero cloud" thesis
- **Chunked acks / sliding window** — current "send-as-fast-as-channel-allows"
  + `bufferedAmountLowThreshold` pacing is good enough; explicit ack windows
  would add complexity for marginal gain since dropping bytes triggers
  `awaitChannelOpen` → `resumeAnswer` → continue
- **Multi-stream parallel chunks** — current sequential file send is fine for
  the per-file resumption guarantee; parallel chunks complicates resume math

---

## 🎯 Expected behavior after Layer 3 ships

Pre-Layer 3 (today):
> Send 500MB → phone screen locks after 30s → channel drops → 30s timeout fires →
> retry waits, but TURN renegotiation takes 45s → retry gives up → user sees
> error → has to re-drag file → starts from byte 0

Post-Layer 3:
> Send 500MB → phone screen locks → heartbeat (layer 4) declares stall in 15s →
> sender's `awaitChannelOpen` sees recent stall → uses 90s timeout → reconnect
> completes in 45s → resumeAnswer arrives within 12s → sender resumes from
> 247MB exactly where it stopped → transfer completes seamlessly

---

**Ready to code?** Commit 1 alone delivers the biggest reliability win
(the heartbeat handoff). Commits 2 + 3 are nice-to-have polish that can ship
later if time-bound.
