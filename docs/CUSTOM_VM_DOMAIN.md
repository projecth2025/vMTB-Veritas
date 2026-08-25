# Switching the VM to `https://meet.vmtb.in`

Migrating the Jitsi VM off the raw-IP sslip.io hostname onto your real domain.

## Why do this

| Problem today | After migration |
|---|---|
| Meeting URL breaks whenever the VM's ephemeral IP changes | Hostname never changes — only a DNS record needs updating |
| Browsers demand a click-through… actually no, you already have a valid LE cert for sslip.io — but that cert dies on IP change | Trusted cert re-issued for `meet.vmtb.in` |
| Static IP reservation (~₹10/day) becomes almost mandatory | Not needed — ephemeral IP is free |

**Prerequisites:** access to the DNS settings for `vmtb.in`; ~45 minutes;
the VM will be **on** during setup (~₹3/hr, shut it down at the end).

---

## Part 1 — Start the VM and capture its IP

```bash
gcloud compute instances start jitsi-vm --zone=asia-south1-c --project vmtb-new
sleep 60   # let it boot
gcloud compute instances describe jitsi-vm \
  --zone=asia-south1-c --project vmtb-new \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
```

Write the IP down — call it `$NEW_IP`.

## Part 2 — DNS

At your DNS provider for `vmtb.in`, create/update:

```
Type: A    Host: meet    Value: $NEW_IP    TTL: 300
```

Verify before continuing (Let's Encrypt refuses otherwise):

```bash
dig +short meet.vmtb.in        # must print $NEW_IP
```

## Part 3 — Reinstall Jitsi against the new name

SSH in (`gcloud compute ssh jitsi-vm --zone=asia-south1-c`). This replays the
battle-tested sequence from the sslip.io install — the purge removes the old
hostname's configs, the reinstall creates everything under `meet.vmtb.in`:

```bash
sudo systemctl stop prosody jicofo nginx jitsi-videobridge2 || true

sudo apt purge -y 'jitsi-meet*' prosody-0.12 jicofo jitsi-videobridge2
sudo rm -rf /etc/prosody /var/lib/prosody /var/log/prosody /etc/jitsi /etc/jicofo
sudo rm -f /etc/nginx/sites-available/34-180-60-14.sslip.io.conf \
           /etc/nginx/sites-enabled/34-180-60-14.sslip.io.conf

sudo apt install -y prosody-0.12
# Lua 5.4 launcher fix (fresh binaries reintroduce the bug):
sudo sed -i '1c #!/usr/bin/lua5.4' /usr/bin/prosody /usr/bin/prosodyctl

sudo apt update && sudo apt install -y jitsi-meet
```

Installer prompts:
- **FQDN**: `meet.vmtb.in`
- **Certificate**: *Generate a new self-signed certificate*

```bash
# Real certificate (DNS already resolves from Part 2)
sudo /usr/share/jitsi-meet/scripts/install-letsencrypt-cert.sh
```

Quick sanity: open `https://meet.vmtb.in` — **green padlock, no warning**.

### Recovery note (if install half-fails)

If `jitsi-meet-prosody` errors with *"No such file or directory:
/etc/prosody/prosody.cfg.lua"* (the purge deleted prosody's own configs while
the package stayed installed), run:

```bash
sudo apt-get install --reinstall -o Dpkg::Options::="--force-confmiss" prosody-0.12
sudo sed -i '1c #!/usr/bin/lua5.4' /usr/bin/prosody /usr/bin/prosodyctl
sudo dpkg --configure -a && sudo apt-get install -f -y
```
then retry the `jitsi-meet` install.

## Part 4 — Re-wire transcription (§6.5 equivalents)

The purge erased these; redo with the **new** filenames:

**(a)** Recreate `/usr/share/jitsi-meet/prosody-plugins/mod_force_async_transcription.lua`
(copy-paste block from `DEPLOYMENT.md` §6.5a — the version that forces BOTH
`asyncTranscription` and `recording.isTranscribingEnabled`).

**(b)** Edit `/etc/prosody/conf.avail/meet.vmtb.in.cfg.lua` → inside
`Component "conference.meet.vmtb.in" "muc"` ensure `modules_enabled` contains
both `"muc_meeting_id";` and `"force_async_transcription";`.

**(c)** Edit `/etc/jitsi/jicofo/jicofo.conf` → inside the top-level
`jicofo { … }` add:

```
transcription {
  url-template = "wss://PROXY_PUBLIC_URL/transcribe?sessionId={{MEETING_ID}}&sendBack=true"
  ping { enabled = true  interval = 10 seconds  timeout = 3 seconds }
}
```

(`PROXY_PUBLIC_URL` = your opus-transcriber-proxy URL — unchanged by this
migration.)

**(d)** `/etc/jitsi/meet/meet.vmtb.in-config.js` → add
`transcription: { enabled: true },`

**(e)** `sudo systemctl restart prosody jicofo nginx` — all three active.

## Part 5 — Point the frontends at the new domain

Vercel (loader project) → Environment Variables:

| Var | New value |
|---|---|
| `VITE_JITSI_DOMAIN` | `meet.vmtb.in` |

Then **Actions → Deploy jitsi-frontend → Run** (branch `main`).

Everything else needs **nothing**: Render, Supabase, proxy/STT/worker, the
activation backend (its CORS default already allows `https://meet.vmtb.in`),
and the Pub/Sub pipeline are all hostname-agnostic for the VM.

## Part 6 — Life afterwards (stop/start routine)

Shut down when done: `gcloud compute instances stop jitsi-vm --zone=asia-south1-c`
(or let the worker's automatic `/stop-jitsi` do it — it fires ~1 min after the
last person leaves).

Next session:

```bash
gcloud compute instances start jitsi-vm --zone=asia-south1-c
gcloud compute instances describe jitsi-vm --zone=asia-south1-c --project vmtb-new \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
# if the IP changed -> update the meet.vmtb.in A record (Part 2). Wait for TTL.
```

Cert/configs are hostname-based and survive forever — only DNS follows the IP.

### Optional: automate the DNS update (Cloudflare example)

If `vmtb.in` lives on Cloudflare, drop this on the VM as
`/usr/local/bin/update-dns.sh` (chmod +x) plus a systemd on-boot unit, and DNS
syncs itself every start:

```bash
#!/usr/bin/env bash
ZONE_ID=YOUR_CF_ZONE_ID
RECORD_ID=YOUR_CF_RECORD_ID          # the meet.vmtb.in A record
API_TOKEN=YOUR_CF_TOKEN_WITH_DNS_EDIT
IP=$(curl -s -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip')
curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  --data "{\"type\":\"A\",\"name\":\"meet.vmtb.in\",\"content\":\"$IP\",\"ttl\":300}"
```

Other providers have equivalent APIs — ask and we'll wire yours.

## Rollback

Nothing external depended on the sslip name except the loader env var — flip
`VITE_JITSI_DOMAIN` back and redeploy if you ever abandon the domain (the
sslip install itself is gone once purged; §6.4 rebuilds it if truly needed).
