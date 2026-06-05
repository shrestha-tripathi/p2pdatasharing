# Self-hosted TURN on Azure — Quick Setup

End-to-end provisioning of a hardened coturn relay for FileTransferNow.
**Four scripts, ~15 minutes from `az login` to a working TURN server.**

## Why self-host?

Cloudflare TURN is the right default (free 1 TB/mo, zero ops). Self-hosting on
Azure makes sense if:
- You have MSDN/EA Azure credits sitting unused
- You want full control + observable logs
- You want to learn how a production TURN deployment actually works

## Cost

| Item | Monthly |
|---|---|
| Standard_B1s VM (2 vCPU burst, 1 GB RAM) | ~$7 |
| Static public IPv4 | ~$3 |
| Egress: first 100 GB free, then $0.087/GB | varies |
| **Typical FileTransferNow workload** | **~$10/mo** |

MSDN credits cover this easily.

## Architecture

```
filetransfernow.com  ──HTTPS──►  Cloudflare Worker /turn
                                       │
                            mints HMAC creds (10-min TTL)
                                       │ shared secret
                                       ▼
                          Azure VM   coturn   ◄──── relays media on demand
                                  (turn.filetransfernow.com)
```

The Cloudflare Worker holds the shared secret and mints
[REST API time-limited creds](https://datatracker.ietf.org/doc/html/draft-uberti-rtcweb-turn-rest-00).
Coturn validates them server-side via HMAC; no callback needed.
Stolen creds expire in 10 min — they can't be stockpiled.

## Prereqs

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
  installed (`curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash` on WSL/Ubuntu)
- `az login` complete
- Right subscription selected (`az account set --subscription "..."`)
- A domain you control — these docs assume `filetransfernow.com`; you'll add a
  `turn.<your-domain>` A record between steps 1 and 2

## Run order

### 1. Provision the VM (on your laptop)

```bash
cd ~/projects/p2pdatesharing/scripts/turn-azure
./01-provision-vm.sh
```

Output ends with a public IP. Add it to DNS as `turn.<your-domain>` and wait for
propagation:

```bash
dig +short turn.filetransfernow.com @1.1.1.1
# Must print the IP from step 01 before proceeding
```

### 2. Install + configure coturn (on the VM)

```bash
# Copy the script over
scp ./02-install-coturn.sh azureuser@<TURN_IP>:~/

# SSH in and run
ssh azureuser@<TURN_IP>
TURN_DOMAIN=turn.filetransfernow.com \
LE_EMAIL=you@filetransfernow.com \
bash ~/02-install-coturn.sh
```

The script prints a **TURN_SHARED_SECRET** at the end. **Save it now** — you
need it for step 4.

### 3. Manually verify with trickle-ice (recommended once)

Back on your laptop:

```bash
TURN_DOMAIN=turn.filetransfernow.com \
TURN_SHARED_SECRET='paste-the-secret' \
./03-test.sh
```

Prints a fresh 10-min credential. Paste it into
<https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/> and
click "Gather candidates". You should see a `relay` candidate. If yes, ✓.

### 4. Wire up the Cloudflare Worker

```bash
TURN_DOMAIN=turn.filetransfernow.com \
TURN_SHARED_SECRET='paste-the-secret' \
./04-wire-worker.sh
```

This sets the secrets, redeploys the worker, and verifies the live `/turn`
endpoint now returns your self-hosted server in the iceServers list.

### 5. Real-world test

Phone on mobile data + laptop on WiFi (the symmetric-NAT case that
breaks today). Open <https://filetransfernow.com/transfer> on both, pair,
send a file. Should connect in 2-4s. In the diagnostics panel you'll see
"Relayed via TURN" when TURN was actually needed.

## Maintenance

### Watch live coturn logs

```bash
ssh azureuser@<TURN_IP> 'sudo tail -f /var/log/turnserver/turnserver.log'
```

### Watch worker logs

```bash
cd ~/projects/p2pdatesharing/worker
npx wrangler tail
```

### Bandwidth usage

```bash
ssh azureuser@<TURN_IP> 'sudo apt install -y vnstat && vnstat -i eth0 -m'
```

### Cert renewal

Daily cron installed by `02-install-coturn.sh`. Test it:

```bash
ssh azureuser@<TURN_IP> 'sudo certbot renew --dry-run'
```

### Rotate the shared secret

If the secret ever leaks:

```bash
# On the VM
NEW_SECRET=$(openssl rand -hex 32)
sudo sed -i "s|^static-auth-secret=.*|static-auth-secret=$NEW_SECRET|" /etc/turnserver.conf
sudo systemctl restart coturn
echo "New secret: $NEW_SECRET"

# On your laptop — push it to the worker
cd ~/projects/p2pdatesharing/worker
echo "$NEW_SECRET" | npx wrangler secret put TURN_SHARED_SECRET
npx wrangler deploy
```

All in-flight clients with the old cred will fail at next allocation refresh
(~10 min) and auto-retry with a fresh one.

## Tearing it down

```bash
# Delete the entire resource group — nuclear option, removes VM + IP + NSG
az group delete -n ftn-turn --yes --no-wait

# Restore the worker to Cloudflare-TURN or STUN-only mode
cd ~/projects/p2pdatesharing/worker
npx wrangler secret delete TURN_SHARED_SECRET
npx wrangler secret delete TURN_DOMAIN
npx wrangler deploy
```

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| `certbot` fails: "Failed authorization" | Port 80 not actually open, OR DNS not pointing to this VM | Re-check NSG rule `AllowHttpForCertbot`; verify `dig turn.<domain>` matches the VM IP |
| `coturn` won't start (`systemctl status coturn` shows "fail") | Usually cert file permissions | Re-run the `chgrp turnserver /etc/letsencrypt/...` block from `02-install-coturn.sh` |
| Trickle-ICE: no relay candidates | Realm mismatch or shared secret typo | Verify `realm=` in `/etc/turnserver.conf` matches the URL hostname exactly; re-paste the secret |
| Trickle-ICE: relay candidate appears but real transfer fails | Relay UDP port range blocked | Confirm Azure NSG rule `AllowRelayUDP` (49152-65535) exists and is enabled |
| Works on home WiFi, fails on corporate | Corporate blocks UDP entirely | Client must fall back to `turns:5349?transport=tcp` (TLS-over-TCP); it's in the iceServers list, but check the browser actually tried it via WebRTC internals |
| Random sites burning your TURN bandwidth | Missing Origin allowlist | Set `ALLOWED_ORIGINS` secret — `04-wire-worker.sh` does this by default |

## Files in this directory

| File | Purpose |
|---|---|
| `01-provision-vm.sh` | Azure VM + static IP + NSG rules. Run on laptop. |
| `02-install-coturn.sh` | coturn + Let's Encrypt + systemd. Run on VM. |
| `03-test.sh` | Generate fresh test credential. Run anywhere. |
| `04-wire-worker.sh` | Update worker source + set secrets + deploy. Run on laptop. |
| `.turn-context` | (Generated, .gitignore'd) VM IP + RG name for later scripts |

## Security posture

This setup gives you:
- ✅ TLS 1.2+ only (1.0/1.1 explicitly disabled)
- ✅ HMAC time-limited credentials (10-min TTL, can't be stockpiled)
- ✅ Origin allowlist on worker (blocks browser-context scraping)
- ✅ Private/loopback peer blocking (can't pivot into internal nets)
- ✅ Per-session bandwidth cap (2 Mbps)
- ✅ Total + per-user allocation quotas (200 / 12)
- ✅ Auto cert renewal
- ⚠️ Not behind WAF — for that, put Cloudflare in front of the VM on a
  separate hostname and proxy through `turns:443?transport=tcp` only

For abuse-resistance hardening beyond Origin checks, add a Cloudflare rate-limit
rule on `/turn` (Dashboard → Security → WAF → Rate limiting rules → 30/IP/hr).
