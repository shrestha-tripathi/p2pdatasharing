# Manual Test Plan — FileTransferNow

**Last updated:** 2026-06-06
**Production URL:** https://filetransfernow.com
**Coverage:** every shipped feature + recent bug fixes (cancel flow, lobby state, bye protocol, showOnly UI machine, TURN relay)

---

## How to use this doc

1. Work through sections **in order** — early tests assume nothing, later ones build on what's already known to work
2. For each test, record **Pass / Fail / Skip** with notes if anything's off
3. For failures, copy the **🐛 Bug Report Template** at the bottom and fill it in
4. Ping back the filled-in template(s) so they can be triaged & fixed

**Two-device setup recommended:**
- **Device A** — laptop (Chrome or Edge preferred, has DevTools for `webrtc-internals`)
- **Device B** — phone (Safari iOS or Chrome Android)
- Some tests need a 3rd browser tab (incognito) on same laptop as a stand-in

**Test environment variations to cycle through:**

| Network combo | What it stresses |
|---|---|
| Both on same WiFi | Happy LAN path (host candidates) |
| Laptop WiFi + phone mobile data (Jio/Airtel) | TURN relay (symmetric NAT) |
| Laptop home WiFi + phone office WiFi | Cross-network direct (srflx) |
| Both behind same router, different WiFi bands (2.4 vs 5GHz) | mDNS / LAN edge cases |

---

## 0. Pre-flight checks (30 sec)

Before running any user-flow test, confirm infrastructure is alive.

### 0.1 Worker `/turn` endpoint returns self-hosted TURN

```bash
curl -s https://p2pdatasharing.shresth-2tripathi.workers.dev/turn \
  -H "Origin: https://filetransfernow.com" | jq .provider
```

✅ **Expected:** `"self-hosted"`
❌ If `"stun-only"` → secrets not deployed; re-run `npx wrangler deploy` and re-test

### 0.2 Coturn server reachable + TLS valid

```bash
timeout 5 openssl s_client -connect turn.filetransfernow.com:5349 \
  -servername turn.filetransfernow.com </dev/null 2>&1 | grep "Verify return"
```

✅ **Expected:** `Verify return code: 0 (ok)`

### 0.3 Trickle-ICE shows working relay

1. Open https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
2. Paste your TURN config from `curl /turn` output above
3. Click "Gather candidates"
4. ✅ At least one row with `Type: relay`, `Address` matches your public IP (NOT 10.x.x.x)
5. ❌ If relay row shows `10.0.0.4` → coturn `external-ip` misconfigured (see TURN_TROUBLESHOOTING)

---

## 1. Happy paths (must always work)

### 1.1 Single small file, same network, link-share
**Setup:** Device A on WiFi, open `https://filetransfernow.com/transfer/`
**Steps:**
1. Click "Send files"
2. Wait for QR + link to appear (should be <1s)
3. On Device B, open the link
4. Drag a small file (~5 MB) onto Device A
5. Wait for completion

✅ **Expected:** Transfer completes in <10s; file opens correctly on Device B; no errors in either console.

### 1.2 Single large file (1 GB+), same network
Same flow as 1.1 but with a 1+ GB file.
✅ **Expected:** Progress bar smooth; ETA accurate; speed >50 Mbps on same WiFi; file integrity preserved.

### 1.3 Multiple files in one batch
Same as 1.1 but drag 5 files at once.
✅ **Expected:** Queue shows all 5 as pending → 1 active + 4 queued → completes one-by-one without manual nudging.

### 1.4 Folder send (preserves tree)
**Steps:**
1. Click "Pick folder" on sender
2. Pick a folder with ~20 files in nested subdirectories
3. Send

✅ **Expected:** Each file streams individually (NOT zipped first — sender stays responsive, transfer starts immediately). Receiver's "Save all to folder" bar shows `N files · X folders preserved`. On Save All → uses Chromium `showDirectoryPicker` → recreates the directory tree.

📝 **Note:** We intentionally do NOT zip on the sender — streaming individual files is faster (instant start vs. wait-for-zip), lower memory, and survives mid-transfer cancel. Receiver reconstructs the tree via `webkitRelativePath` metadata.

### 1.5 Receiver "Save all" works (two options)
After 1.3 (multi-file) completes, the Save All bar shows **two buttons**:

**Option A — Download as .zip (every browser):**
1. Click "Download as .zip" on receiver
2. Wait for "Zipping X%…" → browser download triggers

✅ **Expected:**
- Zip filename uses folder name if applicable (e.g. `MyPhotos.zip`), otherwise `filetransfernow-N-files-YYYY-MM-DD.zip`
- All files inside the zip; folder structure preserved if folder-aware items
- Works on Firefox, Safari, Chrome, Edge — universal fallback

**Option B — Save all to folder (Chromium only):**
1. Click "Save all to folder" on receiver
2. Pick a destination folder

✅ **Expected:**
- Button hidden on Firefox/Safari (only "Download as .zip" shown there)
- Files written directly to picked folder, tree recreated for folder-aware items
- No zip step — native filesystem writes

### 1.6 Chat works alongside transfer
**Steps:**
1. Connect like 1.1
2. Before sending file, type "hello" in chat → ✓ should appear on receiver
3. Start a large transfer
4. Send chat message DURING transfer

✅ **Expected:** Chat messages flow both ways without disrupting transfer.

---

## 2. Cross-network (TURN relay path)

These tests force the relay path to validate the TURN setup end-to-end.

### 2.1 Mobile data ↔ WiFi
**Setup:** Phone on mobile data (Jio/Airtel — symmetric NAT), laptop on home WiFi.
1. Open same flow as 1.1
2. Send a 50 MB file

✅ **Expected:** Connects within 5s; transfer completes; in `chrome://webrtc-internals` the selected candidate pair has `Type: relay`.

### 2.2 Different WiFi networks
**Setup:** Phone on personal hotspot, laptop on different WiFi.
Same test as 2.1.
✅ **Expected:** Connects (may go direct via srflx or relay depending on NAT types).

### 2.3 Adaptive retry kicks in on hostile network
Hard to reproduce on demand — best surfaced by Test 1.1 failing once, then auto-retrying with relay-only.
**Watch for:** in DevTools console, you should see the log `"Adaptive retry: rebuilding peer with iceTransportPolicy=relay"` appear ~15s into a stuck connection, followed by a successful connect ~2-3s later.

### 2.4 STUN candidates use Cloudflare (not Azure)
**Steps:**
1. Open `chrome://webrtc-internals` BEFORE starting a transfer
2. Start a connect
3. Look at `local-candidate` entries — find one with `candidateType: srflx`
4. ✅ Its `address` should NOT be your Azure IP (4.240.x.x) — it should be your actual public IP

---

## 3. Cancel flow (recent fix `c77fb4c` + `722d218` + `e4b6ce2`)

### 3.1 Sender cancels mid-transfer
**Steps:**
1. Connect like 1.1
2. Send a 500 MB file
3. ~10% into the transfer, click the sender-side X on the active row

✅ **Expected:**
- Sender row flips to "Cancelled at N%" within 1s
- Receiver row flips to "✕ Cancelled by sender at X% (X MB of Y MB)"
- No console errors
- Subsequent transfers still work (channel stays open)

### 3.2 Sender cancels queued file (not yet started)
**Steps:**
1. Connect like 1.1
2. Drag 3 large files (>100 MB each)
3. While file 1 is sending, cancel file 3 (queued)

✅ **Expected:** File 3 row removed without disrupting file 1. File 2 still queued.

### 3.3 Cancel during slow TURN-relay transfer
Same as 3.1 but with both peers on mobile data (slowest path). Verifies cancel responsive even on high-latency relay.

✅ **Expected:** Cancel button responds within 1s even at 10 KB/s relay speed.

### 3.4 Cancel watchdog fires on hung cancel
**Hard to repro deliberately** — but if the cancel button ever appears stuck, the 5s watchdog should restore it. If you see "Cancel" button stuck disabled for >10s, that's a regression.

---

## 4. Lobby state / paired devices (recent fix `bb459ca`)

### 4.1 First-time device pairing
**Setup:** Open the app for the first time on Device A. Click "+" on My Devices to add.
**Steps:**
1. Get the pair URL/QR
2. Open it on Device B
3. Both should ask to confirm pairing — accept on both
4. Verify both show in each other's "My Devices" list

✅ **Expected:** Pair appears in both devices' lists; nicknames sync; status shows "online" on both.

### 4.2 Auto-connect on page load (paired devices)
**Setup:** Devices A + B already paired.
**Steps:**
1. Open the page on Device B first — let it sit
2. Open the page on Device A
3. ✅ Within ~3s, Device A's "Online devices" list shows Device B with green dot
4. Click Device B on Device A

✅ **Expected:** Connection establishes within 5s; both flip to "✓ Connected"; ready to send.

### 4.3 BUG FIX TEST — Refresh sender during paired connection
**Setup:** Devices A + B connected via paired flow (4.2).
**Steps:**
1. Refresh Device A's browser
2. Wait for it to reload
3. ✅ Within 2s, Device B should show Device A as offline OR auto-reconnect should fire
4. Click Device B in Device A's roster

✅ **Expected:** Re-pair works immediately. Device B's row should NOT show "Receiving…" stuck — should show "Ready to receive".

❌ **REGRESSION if:** Device B's row says "Receiving…" with opacity-60 and isn't clickable.

### 4.4 BUG FIX TEST — Refresh receiver, sender re-invites
**Setup:** Same as 4.2, connected.
**Steps:**
1. Refresh Device B
2. After reload, on Device A click Device B in the online list

✅ **Expected:** Invite goes through; receiver gets the invite confirm; connects normally.

❌ **REGRESSION if:** "Already in another session" error appears.

### 4.5 Manual disconnect, then re-invite
**Setup:** Same as 4.2, connected.
**Steps:**
1. On Device A, click manual Disconnect button
2. Confirm
3. On Device A, click Device B again in online list

✅ **Expected:** Device B gets fresh invite popup; re-connects.

### 4.6 Close sender tab — receiver sees instant offline
**Setup:** Connected via 4.2.
**Steps:**
1. Close Device A's tab entirely
2. Watch Device B

✅ **Expected:** Device B sees "Lappy disconnected" within 2s (NOT 15s).

❌ **REGRESSION if:** Receiver still shows "✓ Connected to Lappy" for >5s.

### 4.7 Multiple paired devices in roster
**Setup:** Pair Device A with TWO other devices (B and C).
**Steps:**
1. Bring all three online
2. Device A should show both B and C in roster
3. Send to B → C should still show as available
4. After B transfer completes, send to C

✅ **Expected:** Both visible; sending to one doesn't lock the other out.

---

## 5. UI consistency (recent fixes `342b324` + `02e0a9a`)

### 5.1 Try Again after connection failure — clean UI
**How to repro a failure:** simplest is to use a stale `?r=` URL (manually edit the URL to a different random suffix on the receiver).
**Steps:**
1. Sender opens `/transfer/` and gets a link
2. Receiver opens a DIFFERENT random `?r=xyz123abc456` URL (not the real one)
3. Wait ~15-30s for sender's "Connection failed" panel
4. Click "Try again"

✅ **Expected:** ONLY the new role-picker / sender-link panel visible after retry. No leftover role-picker bleeding through.

❌ **REGRESSION if:** Role-picker + sender-link + receiver-wait + retry panel all visible simultaneously.

### 5.2 BUG FIX TEST — Receiver UI shows correct state during sender retry
**Setup:** Connected via 1.1.
**Steps:**
1. On sender, click "Switch to paranoid mode" or toggle the paranoid switch
2. Watch receiver

✅ **Expected:** Receiver instantly shows "Lappy switched modes. Waiting for them to reconnect…" — NOT a vague "Peer disconnected" error 15s later.

### 5.3 BUG FIX TEST — Adaptive relay retry is transparent
**Hard to deliberately trigger** — happens automatically when first attempt fails AND TURN candidate is available.
**Watch for:** receiver should see "Lappy is reconnecting via relay…" mid-session NOT a hard "Connection failed" error.

### 5.4 Theme toggle persists across panels
**Steps:**
1. Click moon icon to toggle dark mode
2. Switch through role picker → sender link → connect → transfer

✅ **Expected:** Theme stays consistent across every state.

### 5.5 Mobile viewport — no horizontal scroll
On phone:
1. Open `/transfer/` in portrait
2. Scroll through every panel state (role picker, sender link with QR, transfer panel, retry panel)

✅ **Expected:** Zero horizontal scroll on any panel. QR code fits screen width.

---

## 6. Paranoid mode (offline handshake)

### 6.1 Send via paranoid mode
**Setup:** Toggle paranoid mode ON before clicking Send.
**Steps:**
1. Click "Send files" → should generate a blob string
2. Copy the blob → share manually (e.g. WhatsApp) to receiver
3. Receiver toggles paranoid mode ON → "Receive" → pastes blob
4. Receiver generates a reply blob → sends back to sender
5. Sender pastes reply blob

✅ **Expected:** Connection establishes; files transfer normally.

### 6.2 Paranoid mode skips connect timer
✅ **Expected:** No 15s "connection failed" error since paranoid handshake is human-paced.

---

## 7. QR code scan (mobile)

### 7.1 Phone scans laptop's QR
**Steps:**
1. Open `/transfer/` on laptop, click Send
2. On phone, open camera or QR scanner
3. Point at laptop screen

✅ **Expected:** Phone opens browser with the receive link; connects.

### 7.2 In-app QR scanner
**Steps:**
1. On phone with no link yet, look for "Scan QR" option
2. Tap it → camera opens
3. Point at another laptop's QR

✅ **Expected:** Scanner detects + autofills link; connects.

---

## 8. 4-char code pairing (UNBUILT — verify backend only)

### 8.1 Worker `/code/mint` endpoint
```bash
curl -s -X POST "https://p2pdatasharing.shresth-2tripathi.workers.dev/code/mint?room=abc123def456" | jq
```
✅ **Expected:** `{"code":"H7K2","expiresInMs":60000,...}`

### 8.2 Worker `/code/claim` endpoint
```bash
curl -s -X POST "https://p2pdatasharing.shresth-2tripathi.workers.dev/code/claim?code=H7K2" | jq
```
✅ **Expected:** First call → `{"roomId":"abc123def456"}`; second call → `{"error":"claimed"}`

❗ **UI for code pairing not yet shipped** — backend ready, frontend planned.

---

## 9. Edge cases

### 9.1 Receiver opens link AFTER sender closes tab
**Steps:**
1. Sender creates link, then closes tab
2. Receiver opens link 30s later

✅ **Expected:** Receiver sees "Sender not available — ask them to reopen the link" (graceful fail).

### 9.2 Same browser, two tabs as sender + receiver
**Steps:** Open sender in tab A, receiver in tab B with the link.
✅ **Expected:** Should work (useful for self-testing).

### 9.3 Send 0-byte file
**Steps:** Create empty `touch empty.txt` and send.
✅ **Expected:** Completes instantly; receiver gets the empty file correctly.

### 9.4 Send file with unicode/emoji in filename
`你好-🚀.png`
✅ **Expected:** Filename preserved on download.

### 9.5 Tab backgrounded during transfer
**Steps:**
1. Start a long transfer
2. Switch to another tab on the sender for 30s
3. Switch back

✅ **Expected:** Transfer paused/resumed gracefully (mobile may throttle JS — pause expected); banner shows "Peer is in background" on receiver.

### 9.6 Network change mid-transfer (WiFi → mobile data)
**Steps:**
1. Start a transfer on phone
2. Turn off WiFi mid-transfer (forces switch to mobile data)

✅ **Expected:** ICE restart fires; transfer resumes from where it stopped (NOT from 0).

### 9.7 Refresh receiver mid-transfer
✅ **Expected:** Sender sees disconnect notice; receiver on reload should be able to re-request resume.

### 9.8 100 small files batch
Send 100 files of ~1 MB each.
✅ **Expected:** Completes without UI lag; all 100 receivable.

---

## 10. Performance benchmarks

### 10.1 Same-WiFi peak speed
**Setup:** Two laptops on same gigabit WiFi.
**Test:** Send 1 GB file. Note completion time.
✅ **Target:** >50 Mbps (>6 MB/s)

### 10.2 TURN relay speed
**Setup:** Forced through TURN (cross-network with symmetric NAT both sides).
**Test:** Send 100 MB file. Note completion time.
✅ **Target:** >5 Mbps (>600 KB/s) — TURN adds latency, slower than direct.

### 10.3 First-byte time (TTFB)
From "click Send" → "first byte arrives at receiver":
✅ **Target:** <3s on same WiFi; <5s through TURN.

---

## 11. Browser compatibility matrix

Run Test **1.1** (basic happy path) in each combo:

| Sender | Receiver | Expected |
|---|---|---|
| Chrome (desktop) | Chrome (desktop) | ✅ |
| Chrome (desktop) | Safari (iOS) | ✅ |
| Chrome (desktop) | Chrome (Android) | ✅ |
| Safari (macOS) | Safari (iOS) | ✅ |
| Edge (desktop) | Chrome (Android) | ✅ |
| Firefox (desktop) | Chrome (desktop) | ✅ |

Note any combo that fails — WebRTC compat issues are common at the SDP layer.

---

## 12. Security / privacy spot checks

### 12.1 DTLS encryption verified
In `chrome://webrtc-internals` during a live transfer, look at the transport stats:
✅ **Expected:** `dtlsState: "connected"`, `srtpCipher` present.

### 12.2 No file data appears in worker logs
Worker should never see file content — only signaling JSON.
**Check:** `wrangler tail` while transferring; should show only `offer`/`answer`/`candidate` messages, NO file bytes.

### 12.3 Files don't persist on receiver after refresh
**Steps:**
1. Send a file → receiver gets it but doesn't click Save
2. Refresh receiver page

✅ **Expected:** File gone (was in OPFS; cleared on next session OR with explicit "Reset").

### 12.4 Worker `/turn` requires correct Origin
```bash
curl -s "https://p2pdatasharing.shresth-2tripathi.workers.dev/turn" -H "Origin: https://evil.com"
```
✅ **Expected:** `{"error":"forbidden"}` with HTTP 403.

---

# 🐛 Bug Report Template

For each failure, copy this and fill in. Send back as a bunch.

```
## BUG #N — short description

**Test ID:** (e.g. 4.3)
**Severity:** Critical / Major / Minor / Cosmetic

**Devices:**
- Sender: <browser> <version> on <OS>, <network>
- Receiver: <browser> <version> on <OS>, <network>

**Steps to reproduce:**
1.
2.
3.

**Expected:**

**Actual:**

**Console errors (DevTools → Console):**
```
<paste any red errors here>
```

**webrtc-internals snapshot (if relevant):**
- iceConnectionState:
- connectionState:
- Selected candidate-pair type (host/srflx/relay):
- candidatesGathered:
- candidatesReceived:

**Screenshot:** (attach if visual bug)

**Frequency:** Always / Sometimes / Once
```

---

## Priority ranking (when reporting multiple)

| Severity | Definition | Example |
|---|---|---|
| **Critical** | Blocks core feature for everyone | "Can't send any file at all" |
| **Major** | Blocks specific flow / wrong state | "Refresh sender → device stuck on 'Receiving…'" |
| **Minor** | Annoying but workaround exists | "Wrong error message text" |
| **Cosmetic** | Visual / copy issue | "Text overflows on phone landscape" |

When sending the bundle, group by severity and put Critical first.
