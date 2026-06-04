---
title: "Why your file transfer keeps failing on corporate WiFi (and how to fix it)"
description: "Corporate firewalls block peer-to-peer connections by default. Here's why WebRTC fails on locked-down office networks, what TURN relays do to rescue it, and what to try when even that fails."
pubDate: 2026-06-04
tags: ["troubleshooting", "corporate", "webrtc", "firewalls"]
---

If you've tried to share a file between two laptops on the same corporate WiFi and the transfer mysteriously stalls at "Connecting..." forever — congratulations, you've discovered the dirty secret of enterprise networks. They actively block peer-to-peer connections by design.

This post explains *why* that happens, *what* tools like FileTransferNow do to work around it, and *what to try* when even the workarounds fail.

## The problem: NAT, but worse

Most home routers use NAT (Network Address Translation) — your devices share one public IP. NAT is annoying for P2P but solvable: a STUN server tells each browser its public-facing address, and the browsers connect directly through their NATs. Works on ~85% of home networks.

Corporate networks are different. They typically have:

1. **Symmetric NAT** — your apparent public port changes for every destination, so STUN's "what's my public address?" answer is useless. The address it tells you is only valid for *that specific* STUN server.
2. **Strict firewalls** — outbound connections on ports other than 80 (HTTP) and 443 (HTTPS) are dropped. P2P traffic typically uses UDP on random ports, which gets nuked.
3. **Deep packet inspection (DPI)** — even traffic that *looks* like normal HTTPS might get scanned and blocked if it doesn't behave exactly like a browser.
4. **No UDP allowed** — many corporate networks block UDP entirely (used for video calls, gaming, and WebRTC). Only TCP is allowed.

If you ever wondered why Slack huddles, Google Meet, and Zoom all sometimes fail to connect on your work network — this is why.

## What WebRTC does first: STUN

When you open FileTransferNow (or any WebRTC app), your browser asks a public STUN server like `stun.l.google.com:19302`: "Hey, what does my public IP and port look like to you?" The STUN server replies with what it sees. Your browser then shares that with the other browser via the signaling channel.

On a home network: this works. The address is stable, both browsers can reach each other on it.

On corporate WiFi: this often *partially* works (your browser gets an answer from STUN) but the answer is useless because your apparent port keeps changing per destination. The other browser tries to connect to the address STUN gave you, and the firewall drops the packet because it never saw your browser send anything to that IP first.

## What WebRTC does second: TURN

When direct connection fails, WebRTC falls back to a **TURN server** — a relay that both browsers connect *outbound* to. Because outbound connections to a known public server are usually allowed (it looks like normal HTTPS traffic), this almost always works.

The data flow becomes:

```text
Sender browser → TURN relay → Receiver browser
                 (both outbound)
```

The TURN server forwards bytes between the two sides. It can't read them (still DTLS-encrypted) but it does see encrypted ciphertext flowing through. FileTransferNow uses Cloudflare's free TURN service (`turn.cloudflare.com`), which is fast and globally distributed.

**TURN rescues maybe 90% of failed corporate connections.** When you see FileTransferNow struggle for 5-10 seconds and then suddenly connect, that's TURN kicking in.

## What if even TURN fails?

About 1% of locked-down networks block TURN too. Common scenarios:

- **Bank / military / healthcare**: only port 443 to a specific allowlist of domains is permitted
- **School/university student networks**: aggressive filtering, especially Chinese, Indian, and Middle Eastern campuses
- **Hotel guest WiFi**: surprisingly aggressive on chains like Marriott, Hilton
- **Airline WiFi**: typically blocks everything except web browsing
- **VPN with kill-switch**: some corporate VPNs route all traffic through the company's network and then enforce the corporate firewall on top

Symptoms:
- Connection times out after 30-60 seconds
- "Failed to gather ICE candidates"
- Stuck at "Connecting..." or 0% progress

## What to try when it fails

### 1. Use mobile data instead of WiFi

The single most reliable fix. Switch one device (preferably the sender) from corporate WiFi to your phone's mobile data hotspot. Mobile carrier NATs are usually more permissive, and you've completely escaped the corporate firewall.

This works ~95% of the time.

### 2. Both devices on a personal hotspot

If you have to share between two devices in a locked-down office, tether both to your phone. Now they're on the same NAT (your phone's), which is a much easier case for WebRTC — often direct STUN traversal works.

### 3. Try a personal VPN

A consumer VPN like ProtonVPN, Mullvad, or Tailscale routes traffic out of the corporate network through a known-good exit, bypassing the firewall.

**Important caveat:** if your laptop is on a corporate VPN with kill-switch enforcement, your *personal* VPN won't work (the corporate VPN will block it). You'd need to use a personal device.

### 4. Use paranoid mode (manual SDP exchange)

FileTransferNow has a "paranoid mode" where you skip the signaling server entirely. You manually copy/paste the SDP handshake between sender and receiver via Signal, email, or any messaging app you can both use. The browsers still need to be able to connect to each other (or to TURN), so this fixes the *signaling* problem but not the *transport* problem.

This helps when:
- Your network blocks our signaling WebSocket but allows TURN
- You want zero involvement from any of our infrastructure
- You're transferring something so sensitive you don't even trust our signaling

### 5. Last resort: USB drive + sneakernet

Sometimes the network just isn't your friend. There's no shame in walking the file over on a USB stick. The sneakernet has 10+ Gbit/s of bandwidth and 100% reliability — it just has high latency.

## Why I'm telling you all this

Most file-transfer tools just say "transfer failed, try again" without explaining why. That's frustrating because the *real* problem is usually network policy, not the tool. Knowing what's actually happening (STUN failed → TURN attempted → firewall blocked TURN → game over) saves you 30 minutes of "is it broken? did I do something wrong?"

For everyday transfers on home WiFi, mobile data, or normal corporate networks, none of this matters — WebRTC just works. But if you're hitting the 1% case, at least now you know what to blame.

---

*Want to skip the WebRTC dance entirely? Use [paranoid mode in FileTransferNow](/transfer) — exchange the handshake over Signal, no signaling server involved. Or read more about [how WebRTC actually works](/how-it-works) under the hood.*
