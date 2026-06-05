# Network-Switch Survival — ICE Restart on Connectivity Change

**Status:** New feature. No existing implementation. Scope: ~80-120 LOC across
3 files. **No worker changes.**

**The bug we're fixing**

> "It resumes when I go to background and come back, however the connection
> doesn't survive if I switch the network or go offline and online."

When the user switches Wi-Fi → cellular (or any network change), the OS rips
down the underlying UDP socket the WebRTC peer is using. Currently:

1. `RTCPeerConnection.connectionState` transitions to `"disconnected"` after
   a few seconds, then `"failed"` after 30-60s.
2. The session emits the matching `state` event.
3. UI shows "failed" / retry panel (or — for paired devices — kicks the
   sequential probe loop after multiple seconds of stall).
4. The user has to manually click Retry / Reload. **No automatic recovery.**

WebRTC's built-in cure for this exact scenario is **ICE Restart** — the
sender re-creates an offer with `{ iceRestart: true }`, both sides re-gather
candidates over the new network path, and the data channel stays alive on
the same `RTCPeerConnection` (no resume-from-byte protocol needed because
the channel never closed at the wire level).

The browser also gives us two early-warning signals we currently ignore:

- `window.addEventListener("online" | "offline")` — fires immediately on
  OS connectivity change, well before the PC notices its socket is dead
- `navigator.connection.addEventListener("change")` (Chromium / Android) —
  fires on transitions like wifi → cellular even when both endpoints stay
  "online" (e.g. handing off between two access points on the same SSID)

---

## ✅ What's already shipped (verified by reading code)

| Capability | Where | Notes |
|---|---|---|
| `RTCPeerConnection.onconnectionstatechange` emits state events | `teleportSession.ts:183-202` | `"connected"`, `"disconnected"`, `"failed"` go to UI |
| 15s "could not establish" connect timer | `teleportSession.ts:640-652` | One-shot, fires `state="failed"` + error |
| Cached `offer` + `candidates` for signaling re-send | `teleportSession.ts:110-111, 591-598` | Used on WS-reconnect today, NOT on ICE restart |
| `visibilitychange` listener → `session.resumeIfStale()` | `transfer.astro:3754-3762` | Wakes the **signaling WS**, not the PC |
| Auto-recovery on `state="failed"` (sender, one-shot) | `transfer.astro` `wireSession` → `autoReconnectAttempted` | Mints a **brand new room** — overkill for a transient network blip |
| Paired-device reconnect on `state="failed"` | `transfer.astro` (activePair branch) | Re-runs `bootDevicesAuto()` — heavy, ~3-8s |
| Layer 4 heartbeat (force-closes channel on stall) | `teleportSession.ts:122-339` | Triggers same `state="failed"` path — could benefit from same fix |

---

## ❌ What's missing (the real gaps)

### Gap A — No `online`/`offline` listeners

Browser fires `window.online` instantly when the OS regains connectivity.
We don't listen anywhere. Means we have to wait for the PC to time out before
even noticing — adds 5-30s of dead time per network switch.

### Gap B — No ICE restart path

Today's recovery options are:
1. **Random-room sender:** mint a new room ID, rebuild PC from scratch,
   share fresh link — totally wrong for a transient network blip (peer
   doesn't get the new link)
2. **Paired-device:** re-run lobby auto-connect — heavy, takes seconds,
   loses in-flight resume-state for active file
3. **Manual retry button:** user has to notice + click

What's missing: a lightweight `restartIce()` method on `TeleportSession`
that calls `peer.restartIce()` (or fallback `createOffer({iceRestart:true})`),
re-sends the new SDP through the existing signaling channel, and lets the
data channel continue. This is **the** WebRTC-native solution for this
exact problem.

### Gap C — `disconnected` doesn't trigger any recovery

Currently `state="disconnected"` only emits an event. The UI shows nothing
actionable. No recovery is attempted until the state transitions further to
`failed` (which can take 30s+ on default browser config). With ICE restart
available, `disconnected` is the **right** trigger — fastest signal, before
the PC actually gives up.

### Gap D — No "Reconnecting…" UI feedback

When the auto-recovery kicks in, the user currently sees the standard
"failed" status pill flash, then a fresh connection appears. Looks like
the app glitched. Need a clear "Reconnecting over new network…" status
during the ICE restart window so the user knows what's happening.

---

## 📋 Plan — 3 surgical commits

### Commit 1 — `feat(reliability): ICE restart method on TeleportSession`

**Scope:** new `restartIce()` method + signaling message routing. Zero
behavioral change to existing flows; this is a pure capability add.

**Files:**
- `src/lib/teleportSession.ts` — add method (~60 LOC)

**Surface:**

```ts
/**
 * Recover from a network change without losing the data channel.
 * Called by the page when window.online fires or PC enters
 * "disconnected". Sender-only: receiver waits for the renegotiated
 * offer via the existing signaling channel.
 *
 * Idempotent — safe to call multiple times; only the first invocation
 * during an inflight restart actually does anything.
 */
async restartIce(): Promise<void>;

/** True while ICE restart is mid-flight (between createOffer and connected). */
get isRestartingIce(): boolean;
```

**Implementation sketch:**

```ts
private iceRestartInFlight = false;
private iceRestartTimer: ReturnType<typeof setTimeout> | null = null;

async restartIce(): Promise<void> {
  // Only the side that originally created the offer can drive ICE
  // restart. Receiver waits for the new offer via signaling.
  if (this.role !== "sender") return;
  if (this.destroyed) return;
  if (this.iceRestartInFlight) return;
  if (!this.roomId) return;
  // No-op if PC is already healthy.
  const s = this.peer.connectionState;
  if (s === "connected" || s === "closed") return;

  this.iceRestartInFlight = true;
  this.emitter.emit("log", `ICE restart starting (peer state: ${s})`);
  this.emitter.emit("state", "signaling"); // surfaces "Reconnecting…" in UI

  try {
    // Reopen signaling if needed (network change usually kills the WS too).
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.openSignaling(this.roomId);
    }

    // Reset candidate cache — we're about to gather a fresh set on the
    // new network. Keep candidatesReceived intact so diag stats are honest.
    this.cachedCandidates = [];
    this.candidateTypes = { host: 0, srflx: 0, prflx: 0, relay: 0 };

    // peer.restartIce() is the modern API (Chrome 77+, Safari 14+, Firefox 70+).
    // Calling createOffer({iceRestart: true}) afterwards (or as fallback)
    // is what actually emits the new offer.
    if (typeof this.peer.restartIce === "function") {
      this.peer.restartIce();
    }
    const offer = await this.peer.createOffer({ iceRestart: true });
    await this.peer.setLocalDescription(offer);
    this.cachedOffer = offer;
    this.sendSignal({ type: "offer", payload: offer });

    // Cap the recovery attempt — if the PC doesn't transition back to
    // "connected" within 20s, fall back to whatever the page-level
    // failure-recovery does. 20s comfortably covers TURN re-allocation
    // plus 3G/4G handoff (typically 2-8s).
    this.iceRestartTimer = setTimeout(() => {
      if (this.peer.connectionState !== "connected") {
        this.emitter.emit("log", "ICE restart timed out");
        this.emitter.emit("state", "failed");
      }
      this.clearIceRestartTimer();
    }, 20_000);
  } catch (err) {
    this.iceRestartInFlight = false;
    this.emitter.emit("error", new Error(`ICE restart failed: ${String(err)}`));
  }
}

get isRestartingIce(): boolean { return this.iceRestartInFlight; }

private clearIceRestartTimer() {
  if (this.iceRestartTimer) {
    clearTimeout(this.iceRestartTimer);
    this.iceRestartTimer = null;
  }
  this.iceRestartInFlight = false;
}
```

**Hook into `onconnectionstatechange`** so the flag clears on success:

```ts
} else if (s === "connected") {
  this.clearConnectTimer();
  this.clearIceRestartTimer();   // <-- new
  this.emitter.emit("state", "connected");
  this.closeSignaling();
}
```

**Receiver side: nothing to add.** The new offer arrives via the existing
`ws.onmessage` `msg.type === "offer"` branch — `setRemoteDescription` then
`createAnswer` then `setLocalDescription` then `sendSignal({type:"answer"})`.
That code path is already there; we just have to confirm it handles a
second offer on an existing PC (it does — RTCPeerConnection supports
re-negotiation natively).

**Open questions answered up front:**

- *Why sender-only?* WebRTC SDP renegotiation can be initiated by either
  side, but our protocol has the sender create the initial offer; flipping
  who's the offerer mid-session would require new signal types. Sender-only
  ICE restart matches the existing wire protocol exactly.
- *What if the WS is also dead?* We re-open it (the `openSignaling()` call
  at the top of `restartIce`).
- *What about the cached candidates / offer?* Reset candidates so diag is
  clean; cachedOffer gets overwritten with the new restart-offer, so any
  WS-reconnect replay logic naturally picks up the new offer.

---

### Commit 2 — `feat(reliability): auto-trigger ICE restart on online/connectionchange`

**Scope:** page-level listeners that call `session.restartIce()` at the
right moments. No new methods, no new state.

**Files:**
- `src/pages/transfer.astro` — new listener block (~30 LOC)

**Triggers (in priority order):**

1. **`window.addEventListener("online", ...)`** — fires the moment the OS
   detects connectivity. Best signal: it precedes the PC noticing.
2. **`navigator.connection.change`** — Chromium-only. Fires on type change
   (`wifi` → `cellular`) even while staying online. Use it as a second
   poke; `restartIce()` is idempotent.
3. **`peer.connectionState === "disconnected"`** — fallback. If the user
   was already online and only the PC sees the problem (silent NAT
   timeout), this catches it.

**Implementation:**

```ts
// ---------- Network-change auto-recovery ----------
// Listen for OS-level connectivity changes and proactively restart ICE
// before the peer connection notices it's dead. Cuts the recovery window
// from ~30s (waiting for PC timeout) down to ~2-5s (TURN re-allocation).
let lastIceRestartAt = 0;
const ICE_RESTART_COOLDOWN_MS = 5_000;

const maybeRestartIce = (reason: string) => {
  if (!session) return;
  if (session.role !== "sender") return;       // only sender restarts ICE
  if (!isChannelLive()) return;                // nothing to recover
  const now = Date.now();
  if (now - lastIceRestartAt < ICE_RESTART_COOLDOWN_MS) return;
  lastIceRestartAt = now;
  addInfo(`Network change detected (${reason}) — reconnecting…`);
  void session.restartIce();
};

window.addEventListener("online",  () => maybeRestartIce("online"));
window.addEventListener("offline", () => addWarning("You're offline. Will reconnect when network returns."));

const conn = (navigator as any).connection;
if (conn && typeof conn.addEventListener === "function") {
  conn.addEventListener("change", () => maybeRestartIce(`type=${conn.effectiveType ?? "?"}`));
}
```

**Plus: trigger on `state="disconnected"` too** (third trigger, safety net).
Add to the existing `state` handler in `wireSession`:

```ts
} else if (state === "disconnected") {
  setStatus("connecting", "Reconnecting over new network…");
  // Schedule ICE restart after a tiny grace — if it's a momentary blip
  // the PC will recover on its own. If not, we kick.
  setTimeout(() => {
    if (session && session.role === "sender" &&
        session.peer.connectionState === "disconnected") {
      maybeRestartIce("disconnected-state");
    }
  }, 2_000);
}
```

`isChannelLive()` already exists at module scope (per pitfall #9 in the
project skill). `addInfo()` / `addWarning()` / `setStatus()` all exist.

**Side effect:** today the `state="disconnected"` UI handler silently
flashes a "disconnected" pill. After this commit, it shows "Reconnecting
over new network…" + an info banner. Receiver side gets the same banner
when the renegotiated offer triggers a fresh signaling round.

---

### Commit 3 — `feat(reliability): receiver-side feedback during ICE restart`

**Scope:** receiver doesn't drive ICE restart but should still show the user
"reconnecting" feedback when the sender does. Plus polish: small "📶
Reconnecting…" status badge, plus banner cleanup on success.

**Files:**
- `src/pages/transfer.astro` — minor (~15 LOC)

**Behavior:**
- Receiver detects "new offer arrived on existing PC" → sets a transient
  flag → status pill shows "Renegotiating…" for the SDP exchange window
- On `state="connected"` while flag is set → flash "✓ Reconnected" pill
  for 2s, then return to "connected" status

Use the existing `wireSession()` state handler:

```ts
let renegotiating = false;
session.emitter.on("state", (state) => {
  if (state === "signaling" && lastSessionState === "connected") {
    renegotiating = true;
    setStatus("signaling", "Reconnecting over new network…");
  } else if (state === "connected" && renegotiating) {
    renegotiating = false;
    addInfo("✓ Reconnected — transfer continuing");
    setStatus("connected", "Connected");
  }
  lastSessionState = state;
  // ... existing handlers continue
});
```

---

## 🧪 Verification

Local-network smoke test (manual, no automation needed):

1. Sender + receiver on two devices, start sending a **2 GB+ file**
   (large enough to span the network switch + verify resume).
2. At ~30%, switch the sender's Wi-Fi → cellular (or toggle airplane mode
   on, then off after 5s).
3. **Expected:** Status pill flips to "Reconnecting over new network…"
   within ~1s of network coming back. ICE renegotiation completes within
   ~3-8s. Transfer continues from the byte where it paused (existing
   layer-3 resume protocol takes over).
4. Repeat with **receiver** switching networks. ICE restart still works
   because the sender's `online`/`disconnected` triggers still fire (the
   sender's PC sees the channel go quiet).

Edge cases to verify:
- [ ] Switch network 3 times in 10s → cooldown prevents thrash; only one
  restart fires per 5s window
- [ ] Switch network while paranoid mode session is active → ICE restart
  is no-op because there's no signaling WS to push the new offer through
  (paranoid mode is human-paced; skip auto-recovery for it). The
  `session.role !== "sender"` guard already covers this since paranoid
  sessions have role set to either side — extra check: skip if
  `session.isParanoid` (need new getter or check `connectAuto` wasn't used)
- [ ] Network change during ICE restart → cooldown gates the second call
- [ ] Disconnect peer (sender closes tab) → ICE restart attempts hit the
  20s timer, transitions to `failed`, falls through to existing recovery

---

## 🚫 Out of scope

- **Multipath / connection migration** (a.k.a. QUIC-style 0-RTT resume on
  new path) — WebRTC doesn't support it, would need WebTransport rewrite.
- **Server-side handoff** (sticky-session tokens) — irrelevant; we're peer-
  to-peer, no server in the data path.
- **Cellular-only TURN forcing** — adding `iceTransportPolicy: "relay"` would
  guarantee TURN even when STUN finds direct, increasing reliability at
  the cost of latency. Separate decision, not part of this feature.
- **Reconnect on receiver-initiated network change without sender online** —
  paired-device flow already handles this via lobby presence. ICE restart
  is for *in-session* recovery, not session re-establishment.

---

## 🔧 Decisions to confirm before coding

1. **Cooldown window: 5s** — too short = thrash on flaky cellular, too long
   = slow recovery on real switch. 5s is balanced.
2. **ICE restart timeout: 20s** — covers TURN re-allocation + cellular handoff.
3. **Banner copy:** "Reconnecting over new network…" / "✓ Reconnected —
   transfer continuing" — Shrestha to OK if the wording clashes with brand voice.
4. **Receiver-side action: none** — receiver just shows status during the
   renegotiation. No code change to the receiver's recovery logic.

If those four are good, the plan is locked.
