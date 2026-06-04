---
title: "How peer-to-peer file sharing actually works in the browser (without uploading anything)"
description: "A no-jargon explainer of how WebRTC, STUN/TURN, and the Origin Private File System let two browsers send a file directly to each other — no server in the middle, no upload, no size limit."
pubDate: 2026-06-04
tags: ["webrtc", "p2p", "explainer", "how-it-works"]
---

If you've ever uploaded a file to WeTransfer or Dropbox just to send it to one specific person, you've probably wondered: *why does it have to go to a server first?* The recipient is right there — why is the file taking a detour through a data center in Virginia?

The honest answer is: it doesn't have to. Modern browsers shipped a protocol called **WebRTC** about a decade ago that lets two web pages talk directly to each other — no server in the middle. It was originally built for video calls (Google Meet, Discord voice, and Whereby all use it), but the same plumbing works for transferring files. That's what WebFileSend does.

This post walks through how it actually works, plain English, no marketing fluff.

## The problem with cloud upload

Here's what happens when you send a 5GB file via WeTransfer:

1. Your browser uploads the file to WeTransfer's servers (slow, bottlenecked by your upload speed)
2. WeTransfer stores it on their disks (for 7 days, on the free tier)
3. They send your recipient a link
4. Your recipient downloads the file from WeTransfer's servers (fast for them, but they still had to wait for step 1)

The file travels **twice**. It sits on a third party's server. There's a size limit (2GB free, 20GB Pro). The link expires. And critically: WeTransfer *can* read it. They might not — but they could.

## What WebRTC does differently

WebRTC turns your browser into a node in a peer-to-peer network. Two browsers can establish a direct, end-to-end-encrypted data channel between each other, and stream bytes back and forth. No server needed for the actual data.

But there's a catch — two browsers can't just call each other out of the blue. They need to be **introduced**. That's where a signaling server comes in.

### Step 1: The handshake (the only server moment)

When you open WebFileSend, your browser opens a tiny WebSocket connection to our signaling server. When the recipient opens the same room URL, they do the same. Our server passes a few text messages between them — specifically:

- **SDP offers and answers**: technical descriptions of what audio/video/data each side can handle
- **ICE candidates**: every possible network address each browser could be reached at

That's it. Maybe 4-5 KB of text per session. **The signaling server never sees a single byte of your file.** Even if our signaling infrastructure went down mid-transfer, the file would keep flowing.

### Step 2: NAT traversal (the hard part)

Here's where it gets interesting. Your home router uses **NAT** (Network Address Translation) — your phone, laptop, and TV all share one public IP address. Two browsers behind different NATs can't just connect by IP, because neither knows the other's public address, and routers reject unsolicited inbound packets.

WebRTC solves this with two helpers:

- **STUN servers** answer one question: "What does my public IP look like to you?" Your browser asks `stun.l.google.com`, gets back its public-facing IP+port combo, and shares it via the signaling server. Works for ~85% of home networks.
- **TURN servers** are the backup plan. For the ~15% of networks where direct peer-to-peer fails (symmetric NATs, locked-down corporate firewalls), TURN servers act as a relay — but a DTLS-encrypted one, so the relay sees only ciphertext, never plaintext.

Once ICE (Interactive Connectivity Establishment) figures out the best path between the two browsers, a direct data channel opens. From this point on, the signaling server is irrelevant.

### Step 3: The data channel

A WebRTC data channel is a stream of bytes, end-to-end encrypted with DTLS 1.3 by default. There's no opt-in for encryption — if the channel is open, it's encrypted. The encryption keys are negotiated browser-to-browser during the handshake and never leave the browsers.

The sender reads the file in chunks (typically 16 KB at a time), sends each chunk over the channel, and waits when the outbound buffer fills up. The receiver gets each chunk and writes it straight to disk — not to memory.

```javascript
// Sender side — read chunks, send them
const reader = file.stream().getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
    await new Promise(r => channel.onbufferedamountlow = r);
  }
  channel.send(value);
}
```

### Step 4: Writing to disk (without crashing the browser)

Reading a 100GB file into memory crashes any browser. So instead, the receiver uses the **Origin Private File System (OPFS)** — a per-origin sandboxed disk that browsers expose at `navigator.storage.getDirectory()`. Each incoming chunk is written directly to OPFS at the correct file offset.

This means:
- RAM stays flat even on a 100GB transfer
- If the connection drops, the partial file is still on disk — we can resume from byte N instead of restarting from zero
- The file is sandboxed (only this origin can read it), so privacy is preserved

```javascript
// Receiver side — write each chunk to disk
const root = await navigator.storage.getDirectory();
const draft = await root.getFileHandle(filename, { create: true });
const writer = await draft.createWritable();
await writer.write({ type: 'write', data: chunk, position: offset });
```

When the transfer completes, OPFS streams the assembled file to the browser's download manager, and the user sees a normal "save as" dialog.

## Why this is actually better than the cloud

| | Cloud upload (WeTransfer, etc.) | Direct P2P (WebFileSend) |
|---|---|---|
| File travels | Twice (up, down) | Once (direct) |
| Server sees the file | Yes | No (signaling only) |
| Size limit | 2-20 GB | None |
| Link expires | 3-30 days | Lasts while tabs stay open |
| Speed bottleneck | Your upload speed | Network path between the two devices |
| Encryption | TLS in transit + at rest on their servers | DTLS end-to-end, even we can't decrypt |
| Works on same WiFi | Yes (slow round-trip) | Yes, near-LAN speed (data stays on your router) |
| Cost to operator | Storage + bandwidth | Tiny signaling server |

The last row is why this approach scales: WebFileSend's marginal cost per transfer is essentially zero, because we never touch the file. Which is also why we'll never need to add file size limits, expiring links, or premium tiers.

## When P2P doesn't work

Honesty section: WebRTC isn't magic. There are edge cases:

- **Symmetric NATs** (some mobile carriers, locked-down corporate networks): direct connections fail, we fall back to TURN relay (still encrypted, slightly slower)
- **Very strict firewalls** (some banks, military, healthcare): even TURN can fail. In that case we offer a "paranoid mode" — manual SDP exchange where you paste the handshake text via Signal or email
- **iOS Safari** (~iOS 15+): supported, but Safari's WebRTC stack is fussier than Chrome's for very large files

For the ~99% of users on home WiFi, mobile data, or normal corporate networks: it just works.

## The bigger picture

P2P file sharing in the browser is one of those quiet quality-of-life upgrades that the web has gotten in the last decade but most people don't know exists. The protocol has been stable for years. The browser support is universal. The only thing missing is people knowing they can use it.

That's what we're trying to fix. If you've got a file to send, [open the app](/transfer), generate a room, share the URL. The whole cloud round-trip vanishes.

---

*Curious about the edge cases? See the [full FAQ](/faq) or read [how it works](/how-it-works) for the deep technical dive.*
