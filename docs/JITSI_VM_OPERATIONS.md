# Jitsi VM Operations

Day-to-day operation of `jitsi-vm` (the Compute Engine instance running
JVB/Prosody/Jicofo/nginx), plus the one-time migration off the raw-IP
sslip.io hostname onto `https://meet.vmtb.in`. See `docs/CLOUD_INVENTORY.md`
for which GCP project this VM lives in (`vmtb-new`, `asia-south1-c`) and its
current machine type/status, and `docs/JITSI_TRANSCRIPTION_CONFIG.md` for
the Prosody/Jicofo config that makes transcription work once the VM is up.

## Why `jitsi-activation-backend` never patches Cloud Run scaling

`jitsi-activation-backend` (`main.py`) starts/stops this VM on demand and
also probes `stt-service`/`opus-transcriber-proxy` to wake them from
scale-to-zero — but it **never writes Cloud Run scaling configuration**.
Straight from the module's own docstring:

> A previous design patched `min_instance_count` 0→1 before a meeting and
> back to 0 afterwards; when the "back to 0" step was forgotten, an idle L4
> GPU stayed resident for days (~₹56/hour). Instead, scale-from-zero is
> driven purely by requests: each poll issues an authenticated health probe,
> and that request itself starts the GPU instance if it is cold. Subsequent
> polls observe readiness, and Cloud Run reaps the instance by itself once
> the meeting's WebSocket closes and traffic stops.

`POST /start-jitsi` is polled by `jitsi-frontend` every few seconds until it
returns `{"status": "already_running"}` (all components ready); it's
idempotent and safe to call repeatedly. For the VM it requires GCP
`RUNNING` **and** a 200 from the public meet origin (`JITSI_PUBLIC_URL`,
default `https://server-vmtb-v2.3billionpairs.com`) — GCP flips to RUNNING
before nginx/prosody finish booting, and joining in that window is what
produced `ERR_CONNECTION_REFUSED` / “disconnected from the meeting”.
`POST /stop-jitsi` only stops the
VM — the Cloud Run services are deliberately left alone, since they're
request-driven and Cloud Run reaps them automatically (the STT service also
closes idle WebSocket sessions itself after `STT_IDLE_TIMEOUT_SECONDS`, so a
crashed client can't hold the GPU indefinitely). `transcript-worker` also
fires `POST {JITSI_ACTIVATOR_URL}/stop-jitsi` automatically after completing
a meeting: within the same delivery it re-checks live-session heartbeats for
up to ~4 minutes (so tab-close ghosts age out) and retries transient stop
failures — the activator returns 5xx if the GCP stop itself fails. Auth is
fail-closed: without a mintable ID token the worker skips the POST entirely,
and a 401/4xx answer is treated as terminal (one attempt, no retry) so a
misconfiguration can never turn into a request loop.

**Idle reaper (`POST /reap-idle`).** The worker's stop is *edge-triggered*:
it only fires after a `meeting.completed` event. Any VM boot without that
event — an abandoned waiting room, a lost Pub/Sub delivery, a worker outage —
used to leak the VM, on and billing, until someone stopped it by hand. The
reaper is the level-triggered backstop: a Cloud Scheduler job calls it every
30 minutes, and it stops the VM only when **every** guard says nobody needs
it (cheap checks first):

1. VM not `RUNNING` → nothing to do;
2. **boot grace** — booted less than `VM_IDLE_MINUTES` ago (default 10) →
   skip, protecting a user still sitting in the waiting room;
3. **recent waiting-room poll** — `/start-jitsi` stamped
   `jitsi_vm_activity.last_start_poll_at` within `VM_IDLE_MINUTES` → skip;
4. **live meeting** — a `meeting_sessions` heartbeat within
   `VM_HEARTBEAT_GRACE_MINUTES` (default 3, same predicate the worker uses)
   → skip.

Only when all four pass does it call GCP stop. Every *unreadable* signal
(Supabase down, GCP read failure) means "unknown", and unknown **never**
stops the VM — fail-safe is skip, not stop. Worst-case idle after the last
sign of life is `VM_IDLE_MINUTES` + the 30-minute tick. One-time setup:

```bash
gcloud scheduler jobs create http vmtb-reap-idle \
  --location=asia-south1 \
  --schedule="*/30 * * * *" \
  --uri="https://<ACT_URL>/reap-idle" --http-method=POST \
  --oidc-service-account-email=vmtb-services@vmtb-new.iam.gserviceaccount.com \
  --oidc-token-audience="https://<ACT_URL>/reap-idle"
```

The audience must equal the backend's `REAPER_AUDIENCE` (default:
`JITSI_ACTIVATOR_URL` + `/reap-idle`), which is deliberately different from
the worker's audience, so a worker/proxy token cannot drive the reaper and
vice versa. Requires the `jitsi_vm_activity` Supabase table (migration
`20261031_jitsi_vm_activity.sql`); until it exists the reaper skips every
tick (fail-safe) and logs why. Self-check: `python
jitsi-activation-backend/check_reap.py`.

**Auth.** All endpoints return 401 without a valid caller (`/` stays open
for health checks):

- `/start-jitsi` and `/status` take the meeting **join ticket** in an
  `X-Join-Ticket` header (jitsi-frontend sends it); the backend looks it up
  in `meeting_join_tickets` and rejects expired ones.
- `/stop-jitsi` and `/reap-idle` take **only** a Google ID token
  (`Authorization: Bearer`), and a join ticket is refused on both, or any
  participant could end everyone's meeting. The worker mints for audience
  `JITSI_ACTIVATOR_URL`; Cloud Scheduler mints for `REAPER_AUDIENCE`
  (default `JITSI_ACTIVATOR_URL` + `/reap-idle`).

Backend config, set on the Cloud Run service: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` (secret ref `supabase-service-role-key`),
`WORKER_SERVICE_ACCOUNT` (`vmtb-services@vmtb-new.iam.gserviceaccount.com`,
the SA transcript-worker runs as) and `JITSI_ACTIVATOR_URL` (the backend's
own run.app URL, same value as on the worker). The reaper adds optional
overrides — `REAPER_SERVICE_ACCOUNT` (defaults to `WORKER_SERVICE_ACCOUNT`),
`REAPER_AUDIENCE`, `VM_IDLE_MINUTES` (10), `VM_HEARTBEAT_GRACE_MINUTES` (3),
`POLL_ACTIVITY_WRITE_INTERVAL_SECONDS` (60) — all defaulted in code, so no
workflow change is required. The deploy workflow now sets
both auth vars on **every** deploy (`WORKER_SERVICE_ACCOUNT` via the deploy
step, `JITSI_ACTIVATOR_URL` via a follow-up update from the service's own
URL), so a manual `gcloud run services update` needs them only on a brand-new
service created outside that workflow; when they're missing the backend logs
one loud `WORKER_SERVICE_ACCOUNT and/or JITSI_ACTIVATOR_URL not set` error
per process and rejects every ID token (401) rather than guessing an
audience. Self-check: `python jitsi-activation-backend/check_auth.py`.

To stop the VM by hand, skip the endpoint:
`gcloud compute instances stop jitsi-vm --zone asia-south1-c --project vmtb-new`.

**Note on Prosody WebSocket diagnostics:** a bare `curl` upgrade to
`/xmpp-websocket` without `Sec-WebSocket-Protocol: xmpp` gets
`501 Not Implemented` from Prosody by design — that is not a server fault.
Use e.g. `curl --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket'
-H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: …'
-H 'Sec-WebSocket-Protocol: xmpp' …/xmpp-websocket` and expect `101`.

If you're ever debugging a suspiciously large GPU bill, confirm no
min-instances config has crept back in:

```bash
gcloud run services describe stt-service --project vmtb-new \
  --region asia-southeast1 --format='value(spec.template.metadata.annotations)'
# run.googleapis.com/minScale must be absent or '0'
```

## Migrating to a custom domain (`https://meet.vmtb.in`)

Do this once the app works to your satisfaction on the raw VM IP.

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

Everything else needs **nothing**: Supabase, proxy/STT/worker, the
activation backend (its CORS default already allows `https://meet.vmtb.in`),
and the Pub/Sub pipeline are all hostname-agnostic for the VM.

> **Stale-reference note:** this section previously said "Render" needs
> nothing either, referring to `jitsi-activation-backend`'s old hosting.
> Per `docs/CLOUD_INVENTORY.md`, that service is now confirmed live on
> Cloud Run in `vmtb-new`/`asia-southeast1`, not Render — the statement
> itself (nothing to change there for a domain switch) still holds, only
> the platform name was stale.

## Part 6 — Life afterwards (stop/start routine)

Shut down when done: `gcloud compute instances stop jitsi-vm --zone=asia-south1-c`
(or let the worker's automatic `/stop-jitsi` do it — it retries within ~4 min
of meeting completion so ghost analytics sessions don't leave the VM billing;
and if both are missed, the idle reaper stops the VM within ~40 min of the
last sign of life).

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
