# vMTB Deployment Guide — everything from scratch

This is the **only** document you need to take an empty cloud account to a
fully working platform: GCP backend, Jitsi VM, Render app, Vercel frontend,
CI/CD buttons in GitHub, then a real end-to-end test.

Follow top to bottom. Steps marked **(one-time)** never need repeating.
If you already did part of §2 (e.g. bucket/Pub/Sub), just skip those blocks.

Total time estimate: **half a day** (most of it waiting on builds/quota/DNS).

---

## 0. What you are building

| Component | Where | URL |
|---|---|---|
| `main/` app | Render Static Site (**new**, §7.1) | `https://vmtb-main.onrender.com` |
| `jitsi-frontend/` | Vercel (**new**, §7.2) | `https://<you>.vercel.app` |
| `stt-service` (GPU Whisper) | Cloud Run, `asia-southeast1` | assigned by Cloud Run |
| `opus-transcriber-proxy` | Cloud Run, `asia-southeast1` | assigned by Cloud Run |
| `transcript-worker` | Cloud Run, `asia-southeast1` | assigned by Cloud Run |
| `jitsi-activation-backend` | Cloud Run, `asia-southeast1` | assigned by Cloud Run |
| `jitsi-vm` (JVB/Prosody/Jicofo) | Compute Engine, `asia-south1-c` (**new**, §6) | `https://<VM_IP>` (custom domain later, §6.7) |
| Transcript artifacts | GCS `gs://vmtb-transcripts` | internal |
| Minutes-of-Meeting LLM | Mistral API | external |

Everything Cloud Run is **scale-to-zero** (no idle cost). The VM and the warm
GPU only bill while a meeting is active (see §9).

### CI/CD model

Every deployable unit has its own **manual button** in GitHub → Actions
(`workflow_dispatch`) — nothing deploys on every commit unless you also keep
the Vercel/Render git-integration enabled (optional):

| Button (workflow) | Deploys | Mechanism |
|---|---|---|
| Deploy stt-service | Cloud Run GPU | Cloud Build → Cloud Run |
| Deploy opus-transcriber-proxy | Cloud Run | Cloud Build → Cloud Run |
| Deploy transcript-worker | Cloud Run | Cloud Build → Cloud Run (+ repairs Pub/Sub wiring) |
| Deploy jitsi-activation-backend | Cloud Run | Cloud Build → Cloud Run |
| Deploy jitsi-frontend (Vercel) | Vercel prod | Vercel CLI (`vercel deploy --prod`) |
| Deploy main app (Render) | Render static site | Render Deploy Hook |

### How every URL connects (master wiring table)

| # | From → To | Value | Set where | When |
|---|---|---|---|---|
| 1 | main app → jitsi-frontend | `VITE_SERVER_LOADER_URL=<vercel-url>` | Render env vars | §7.3 (manual!) |
| 2 | jitsi-frontend → activation backend | `VITE_JITSI_BACKEND_URL=<ACT_URL>` | Vercel env vars | §7.2 (manual!) |
| 3 | jitsi-frontend → main app | `VITE_MAIN_APP_URL=<render-url>` | Vercel env vars | §7.2 (manual!) |
| 4 | activation backend → Jitsi VM | name `jitsi-vm`, zone `asia-south1-c` | baked into workflow | automatic |
| 5 | activation backend → STT/proxy | service names (Cloud Run API) | baked into workflow | automatic |
| 6 | proxy → STT | `STT_WS_URL` fetched at deploy time | proxy workflow | automatic |
| 7 | Pub/Sub → worker | push subscription w/ token | worker workflow | automatic |
| 8 | worker → GCS/Supabase/Mistral | secrets | Secret Manager | §2.4, §5 |
| 9 | **Jicofo (VM) → proxy** | `wss://<PROXY_URL>/transcribe?...` | `jicofo.conf` on VM | §6.5 (manual!) |
| 10 | browsers → VM | the VM's raw IP (self-signed cert) | nothing to set — IP is the URL | §6.2 |

Manual links: #1, #2, #3, #9. Everything else self-wires during deploys.
(DNS/domain linking is deliberately deferred to §6.7.)

---

## 1. Prerequisites

- GCP project with billing enabled (✅ you have this). Collect:
  ```bash
  gcloud auth login && gcloud config set project YOUR_PROJECT_ID
  gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)'
  ```
- Owner/editor rights on the GCP project (for one-time IAM setup).
- Your GitHub repo pushed and Actions enabled, e.g. `harishbabu2007/vMTB-Veritas`.
- A [Vercel](https://vercel.com) account (sign in with GitHub).
- A [Render](https://render.com) account (sign in with GitHub).
- A [Mistral](https://console.mistral.ai/) account (free tier OK).
- Supabase project URL, anon key and **service role key**.
- DNS access for `vmtb.in` — **not needed initially** (raw VM IP); required
  later per §6.7.

---

## 2. One-time GCP setup

Replace `YOUR_PROJECT_ID`, `YOUR_PROJECT_NUMBER`, `YOUR_GH_USER` everywhere.

### 2.1 Enable APIs

```bash
gcloud services enable \
  run.googleapis.com compute.googleapis.com artifactregistry.googleapis.com \
  pubsub.googleapis.com storage.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com
```

### 2.2 Artifact Registry, bucket, Pub/Sub topic *(skip what you already made)*

```bash
gcloud artifacts repositories create vmtb-services \
  --repository-format=docker --location=asia-southeast1

gcloud storage buckets create gs://vmtb-transcripts \
  --location=asia-southeast1 --uniform-bucket-level-access   # ✅ if already created

gcloud pubsub topics create meeting-transcripts              # ✅ if already created
```

(The push subscription is created automatically by the transcript-worker
workflow — no manual step.)

### 2.3 Service accounts & permissions

```bash
PROJECT_ID=YOUR_PROJECT_ID

gcloud iam service-accounts create vmtb-services   --display-name="vMTB transcription services"
gcloud iam service-accounts create vmtb-activator  --display-name="vMTB meeting activator"
gcloud iam service-accounts create vmtb-deployer   --display-name="vMTB CI deployer"

# runtime SA: invoke services, write artifacts, read secrets, publish events
for ROLE in roles/run.invoker roles/storage.objectAdmin roles/secretmanager.secretAccessor roles/pubsub.publisher; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done

# activator SA: control the VM + wake/sleep Cloud Run services
for ROLE in roles/compute.instanceAdmin.v1 roles/run.developer roles/run.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-activator@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done
gcloud iam service-accounts add-iam-policy-binding \
  "vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" \
  --member="serviceAccount:vmtb-activator@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# deployer SA: what GitHub Actions may do
for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.writer \
            roles/cloudbuild.builds.builder roles/storage.objectAdmin roles/secretmanager.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-deployer@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done
```

### 2.4 Secrets (Secret Manager)

```bash
printf '%s' 'https://YOUR-PROJECT.supabase.co' | \
  gcloud secrets create supabase-url --data-file=- --replication-policy=automatic
printf '%s' 'PASTE_SERVICE_ROLE_KEY' | \
  gcloud secrets create supabase-service-role-key --data-file=- --replication-policy=automatic
openssl rand -hex 24 | \
  gcloud secrets create pubsub-push-token --data-file=- --replication-policy=automatic
# llm-api-key is filled with the real Mistral key in §5; placeholder until then:
printf '%s' 'placeholder' | \
  gcloud secrets create llm-api-key --data-file=- --replication-policy=automatic

for SECRET in supabase-url supabase-service-role-key llm-api-key pubsub-push-token; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

### 2.5 GPU quota (request early — approval can take days)

Console → **IAM & Admin → Quotas & System Limits** → filter `NVIDIA_L4_GPUS`,
region `asia-southeast1` → **Edit** → request **1**.
Without this the stt-service deploy fails.

### 2.6 GitHub Actions authentication for GCP (Workload Identity Federation)

No keys stored in GitHub — OIDC token exchange:

```bash
PROJECT_NUMBER=YOUR_PROJECT_NUMBER
GH_REPO="YOUR_GH_USER/vMTB-Veritas"

gcloud iam workload-identity-pools create github-pool \
  --location=global --display-name="GitHub Actions pool"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global --workload-identity-pool=github-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${GH_REPO}'"

gcloud iam service-accounts add-iam-policy-binding \
  "vmtb-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GH_REPO}"
```

### 2.7 All GitHub repository secrets (do this once)

GitHub → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value | From |
|---|---|---|
| `GCP_PROJECT_ID` | your project id | §2 |
| `GCP_WIF_PROVIDER` | `projects/YOUR_PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider` | §2.6 |
| `GCP_DEPLOY_SA` | `vmtb-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com` | §2.3 |
| `RENDER_DEPLOY_HOOK` | Render deploy-hook URL | §7.1 step 5 |
| `VERCEL_TOKEN` | Vercel personal access token | §7.2 step 4 |
| `VERCEL_ORG_ID` | Vercel org/team id | §7.2 step 4 |
| `VERCEL_PROJECT_ID` | Vercel project id | §7.2 step 4 |

(GCP secrets can be added now; the Render/Vercel ones after §7 creates those
projects.)

---

## 3. Supabase schema (one-time)

Supabase Dashboard → **SQL Editor** → paste all of
`main/supabase/migrations/20260820_meeting_transcripts.sql` → **Run**.
Creates `meeting_transcripts`, `meeting_transcript_segments`, the state RPCs,
RLS policies and realtime publication.

---

## 4. Deploy the four backend services (GitHub buttons)

GitHub → **Actions** tab → pick a workflow → **Run workflow** → keep defaults.
Deploy strictly in this order:

1. **Deploy stt-service** — first build takes ~15–25 min (CUDA wheels +
   Whisper `medium` model baked into the image).
2. **Deploy opus-transcriber-proxy** — auto-fetches the STT URL.
3. **Deploy transcript-worker** — wires secrets + creates the Pub/Sub push
   subscription automatically.
4. **Deploy jitsi-activation-backend**.

Then collect the URLs you'll need later:

```bash
gcloud run services list --project YOUR_PROJECT_ID
PROXY_URL=$(gcloud run services describe opus-transcriber-proxy \
  --project YOUR_PROJECT_ID --region asia-southeast1 --format 'value(status.url)')
ACT_URL=$(gcloud run services describe jitsi-activation-backend \
  --project YOUR_PROJECT_ID --region asia-southeast1 --format 'value(status.url)')
echo "PROXY=$PROXY_URL"; echo "ACT=$ACT_URL"
```

> **Write down `PROXY_URL`** — needed in §6.5 (Jicofo config).
> **Write down `ACT_URL`** — needed in §7 (frontends).

---

## 5. Mistral setup (Minutes-of-Meeting)

1. <https://console.mistral.ai/> → **API Keys** → *Create new key*.
2. Store it (replaces the placeholder from §2.4):
   ```bash
   printf '%s' 'YOUR_REAL_MISTRAL_KEY' | \
     gcloud secrets versions add llm-api-key --data-file=-
   ```
3. Redeploy **transcript-worker** via its Action button so the running
   container picks up the new secret version.
4. Config already set in the workflow: `LLM_BASE_URL=https://api.mistral.ai/v1`,
   `LLM_MODEL=mistral-small-latest`. Transient 429/5xx errors are retried
   automatically (`transcript-worker/src/llm.ts`).

Quick sanity check of your key:

```bash
curl https://api.mistral.ai/v1/chat/completions \
  -H "Authorization: Bearer $MISTRAL_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"mistral-small-latest","response_format":{"type":"json_object"},
       "messages":[{"role":"user","content":"Return {\"summary\":\"ok\"}"}]}'
```

---

## 6. Jitsi VM from scratch (raw IP for now, domain later)

This creates the VM that runs JVB (media), Prosody (XMPP), Jicofo (conference
logic) and nginx. Nothing else in the pipeline works without it.

### 6.1 Firewall rules (one-time)

```bash
gcloud compute firewall-rules create allow-jitsi-http \
  --allow=tcp:80 --source-ranges=0.0.0.0/0
gcloud compute firewall-rules create allow-jitsi-https \
  --allow=tcp:443 --source-ranges=0.0.0.0/0
gcloud compute firewall-rules create allow-jitsi-media \
  --allow=udp:10000 --source-ranges=0.0.0.0/0
```

(SSH/tcp:22 is already open via the default network's `default-allow-ssh`.)

### 6.2 Create the VM

```bash
gcloud compute instances create jitsi-vm \
  --zone=asia-south1-c \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB
```

`e2-standard-4` (4 vCPU / 16 GB) comfortably hosts small tumor-board meetings.
For pure cost saving with ≤5 participants you can drop to `e2-standard-2`.

Note the VM's external IP — it is your meeting URL for now:

```bash
gcloud compute instances describe jitsi-vm \
  --zone=asia-south1-c --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
```

### 6.3 DNS — skipped for now

We install Jitsi against the **raw VM IP** with a self-signed certificate, so
no DNS record is needed yet. When you're happy with the app, follow §6.7 to
switch to `meet.vmtb.in` properly.

### 6.4 Install Jitsi Meet on the VM

```bash
gcloud compute ssh jitsi-vm --zone=asia-south1-c
```

Then on the VM (replace `<VM_IP>` with the external IP from §6.2):

```bash
sudo apt update && sudo apt upgrade -y

curl https://download.jitsi.org/jitsi-key.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/jitsi-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/jitsi-keyring.gpg] https://download.jitsi.org/ stable/" | \
  sudo tee /etc/apt/sources.list.d/jitsi-stable.list
sudo apt update
sudo apt install -y jitsi-meet
```

During installation it prompts twice:
- **FQDN**: type the VM's external IP (e.g. `35.200.123.45`)
- **Certificate**: choose *"Generate a new self-signed certificate"* — fine
  for testing; browsers will show a one-time warning you accept.

Open `https://<VM_IP>` in a browser, click through the certificate warning
(Chrome: *Advanced → Proceed anyway*), and you should see the Jitsi welcome
page. Meetings already work at this point; transcription comes next.

> Accepting the warning once per browser is required **before** starting
> meetings from the app, because the meeting is embedded from this same IP.

### 6.5 Wire transcription to your proxy ← **the important part**

Four edits on the VM. Replace `<PROXY_URL>` with the value saved in §4
(e.g. `https://opus-transcriber-proxy-xxxxx-ey.a.run.app`).

**(a) Force-enable transcription on every room (Prosody module)**

```bash
sudo tee /usr/share/jitsi-meet/prosody-plugins/mod_force_async_transcription.lua > /dev/null <<'EOF'
-- Forces asyncTranscription=true on every room's metadata.
local util = module:require 'util';
local is_healthcheck_room = util.is_healthcheck_room;

module:hook('muc-room-created', function(event)
    local room = event.room;
    if is_healthcheck_room(room.jid) then return; end
    if not room.jitsiMetadata then room.jitsiMetadata = {}; end
    room.jitsiMetadata.asyncTranscription = true;
    module:log('info', 'Forced asyncTranscription=true for %s', room.jid);
end, -2); -- after mod_room_metadata_component (-1)
EOF
```

**(b) Enable the module on the conference component**

Edit `/etc/prosody/conf.avail/<VM_IP>.cfg.lua` (the file is named after the
FQDN you entered, i.e. the IP). Find the block starting with
`Component "conference.<VM_IP>" "muc"` and make sure its `modules_enabled`
list contains both entries:

```lua
Component "conference.<VM_IP>" "muc"
    ...
    modules_enabled = {
        "muc_meeting_id";           -- usually already present
        "force_async_transcription"; -- ADD THIS LINE
        ...
    }
```

**(c) Point Jicofo at the proxy**

Edit `/etc/jicofo/jicofo.conf` — add a `transcription` block inside the
top-level `jicofo { ... }` section:

```
jicofo {
  // ... existing config stays ...

  transcription {
    url-template = "wss://<PROXY_URL>/transcribe?sessionId={{MEETING_ID}}&sendBack=true"
    ping {
      enabled = true
      interval = 10 seconds
      timeout = 3 seconds
    }
  }
}
```

**(d) Enable the toggle in the client**

Edit `/etc/jitsi/meet/<VM_IP>-config.js` and add:

```js
transcription: {
    enabled: true,
},
```

**(e) Restart and verify**

```bash
sudo systemctl restart prosody jicofo
sudo systemctl status prosody jicofo nginx   # all should be active
```

Reference: <https://jitsi.github.io/handbook/docs/devops-guide/transcription/>

### 6.6 Check the activation backend can control this VM

From your laptop:

```bash
ACT_URL=<your activation backend URL>
curl -s "$ACT_URL/status" | python3 -m json.tool
# expect: jvb TERMINATED, stt cold, proxy cold

curl -s -X POST "$ACT_URL/start-jitsi"
# repeat every few seconds until ALL components say "ready"
# then tear back down:
curl -s -X POST "$ACT_URL/stop-jitsi"
```

If `jvb` shows `error`, re-check §2.3 IAM bindings and the activation
backend's Cloud Run logs.

### 6.7 Later: switching to `meet.vmtb.in` (custom domain)

Do this only after the app works to your satisfaction. Summary:

1. Add the DNS A record `meet → <VM_IP>` at your DNS provider and wait for
   propagation (`dig +short meet.vmtb.in`).
2. On the VM:
   ```bash
   sudo hostnamectl set-hostname meet.vmtb.in
   echo "127.0.0.1 meet.vmtb.in" | sudo tee -a /etc/hosts
   sudo /usr/share/jitsi-meet/scripts/install-letsencrypt-cert.sh
   ```
   If the cert script complains about the old self-signed config, re-run
   `sudo apt install -y jitsi-meet` and answer the FQDN prompt with
   `meet.vmtb.in` — it regenerates nginx/prosody/jicofo config for the new
   name (your §6.5 edits must then be re-applied to the *new* file names:
   `/etc/prosody/conf.avail/meet.vmtb.in.cfg.lua`,
   `/etc/jitsi/meet/meet.vmtb.in-config.js`).
3. Update `VITE_JITSI_DOMAIN=meet.vmtb.in` on Vercel (§7.2) and redeploy.
4. Ask me when you get here — we'll do it together.

---

## 7. Frontends from scratch (Render + Vercel)

Both are static Vite builds. **Order matters** because their URLs point at
each other: create Render first (its URL exists immediately), then Vercel,
then loop back to Render once with the Vercel URL.

### 7.1 Create the main app on Render

1. <https://dashboard.render.com> → **New +** → **Static Site** → connect
   your GitHub repo (grant access when prompted).
2. Settings:
   - **Name**: `vmtb-main` → URL becomes `https://vmtb-main.onrender.com`
   - **Root Directory**: `main`
   - **Build Command**: `npm ci && npm run build`
   - **Publish Directory**: `dist`
     *(if the first deploy fails complaining about a missing `dist`, change
     this to `main/dist`)*
3. **Environment Variables** (Add more → each row):
   - `VITE_SUPABASE_URL` = your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = anon key
   - `VITE_JITSI_BACKEND_URL` = `<ACT_URL>` from §4
   - `VITE_SERVER_LOADER_URL` = *(leave empty for now — filled in §7.3)*
4. **SPA routing (required!)**: scroll to *Redirects/Rewrites* and add:
   - Rule: `/*` → Rewrite → `/index.html`
   Without this, refreshing any page other than home shows 404.
5. Click **Create Static Site**. Wait for the first deploy to finish.
6. Grab the deploy hook: service page → **Settings** → **Deploy Hook** →
   copy the URL → add it as GitHub secret `RENDER_DEPLOY_HOOK` (§2.7).

> Note the site URL `https://vmtb-main.onrender.com` — needed in §7.2.

### 7.2 Create jitsi-frontend on Vercel

1. <https://vercel.com/new> → **Import** your GitHub repo.
2. Configure:
   - **Framework Preset**: Vite
   - **Root Directory**: `jitsi-frontend` (Edit → select)
   - Build command / output auto-detect from Vite (`npm run build` / `dist`)
3. **Environment Variables** (Production):
   - `VITE_JITSI_BACKEND_URL` = `<ACT_URL>` from §4
   - `VITE_JITSI_DOMAIN` = `<VM_IP>` from §6.2 (switch to `meet.vmtb.in`
     later per §6.7)
   - `VITE_MAIN_APP_URL` = `https://vmtb-main.onrender.com` (from §7.1)
   - `VITE_SUPABASE_URL` = your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = anon key
4. Click **Deploy**. When done, note your production URL
   (e.g. `https://vmtb-jitsi.vercel.app` — visible at the top of the project).
5. Get the CI/CD credentials:
   - **Org ID + Project ID**: project → *Settings* → *General* →
     "Vercel Organization ID" and "Vercel Project ID"
     (or run `npx vercel link` inside `jitsi-frontend/` locally and open
     `.vercel/project.json`)
   - **Token**: <https://vercel.com/account/settings/tokens> → *Create*
6. Add three GitHub secrets (§2.7): `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
   `VERCEL_PROJECT_ID`.

From now on, **Actions → Deploy jitsi-frontend (Vercel)** rebuilds and ships
it. (Vercel's git-integration also auto-deploys on push; disable it under
Settings → Git if you want button-only deploys.)

### 7.3 Loop back: point the main app at the loader

Render dashboard → `vmtb-main` → **Environment**:

- Set `VITE_SERVER_LOADER_URL` = your Vercel production URL from §7.2

Then trigger **Actions → Deploy main app (Render)** (env var changes only
apply after a redeploy).

### 7.4 Verify the frontends

- Open the Render URL → log in → you should see your cases/MTBs.
- Open the Vercel URL directly with no params → you should see the friendly
  error page ("No room name provided…") — that proves it loads.

---

## 8. End-to-end test

Do this exactly once, in order, and note anything that breaks.

1. **Cold state**
   `curl -s $ACT_URL/status | python3 -m json.tool`
   → jvb `TERMINATED`, stt `cold`, proxy `cold`.
2. **Accept the VM's self-signed cert once** — open `https://<VM_IP>` in the
   browser you'll test from and click through the warning (*Advanced →
   Proceed anyway*). Without this, the embedded meeting iframe fails silently.
3. **Start a meeting** — main app → MTB → *Meeting* → *Start Meeting*.
   It opens the Vercel loader, which polls `/start-jitsi`; expect **1–3 min**
   (VM boot + GPU alloc + model load) before the room opens.
4. **Talk** — join from a second device/tab if possible. With
   `force_async_transcription` installed, JVB should connect to the proxy
   automatically. Captions appear because `sendBack=true`.
   Check: proxy logs (Cloud Run → opus-transcriber-proxy → Logs) show
   `transcription session opened`.
5. **Segments land** — Supabase → Table Editor →
   `meeting_transcript_segments`: FINAL rows appear within seconds of speech.
6. **End the meeting** — leave/end for everyone. Within ~1 min:
   - `meeting_transcripts.status` → `COMPLETED`
   - `gs://vmtb-transcripts/meetings/<meeting_id>/transcript/transcript-v1.{json,txt}` exist
   - `minutes_of_meeting` column filled with Mistral JSON
     (summary / decisions / action_items).
7. **Tear down**
   `curl -X POST $ACT_URL/stop-jitsi` then confirm `/status` shows all
   stopped/cold. **Never skip this** — the warm GPU bills ~$0.80/hr.

Pipeline smoke test without a real meeting (dummy provider, no GPU):

```bash
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("wss://PROXY_URL/transcribe?sessionId=smoke-room&provider=dummy");
ws.on("open", () => ws.send(JSON.stringify({event:"ping",id:1})));
ws.on("message", (m) => console.log(m.toString()));
'
```

---

## 9. Keeping costs near zero between meetings

- All Cloud Run services run `--min-instances 0` → free while idle.
- Woken GPU ≈ **$0.70–1.00/hr**; VM ≈ e2-standard-4 hourly rate while RUNNING.
- Always stop after testing: `curl -X POST $ACT_URL/stop-jitsi`.
- Safety net — auto-stop every night at midnight IST:
  ```bash
  gcloud scheduler jobs create http vmtb-nightly-stop \
    --location=asia-south1 \
    --schedule="30 18 * * *" --time-zone="Asia/Kolkata" \
    --uri="$ACT_URL/stop-jitsi" --http-method=POST
  ```
  (enable Cloud Scheduler API if prompted)
- Render static sites and Vercel hobby projects are free at this scale.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| STT deploy fails: GPU quota error | §2.5 quota not granted yet, or wrong region |
| Meeting stuck on loader ("Server starting…") | `curl $ACT_URL/status` → see which component isn't ready; check that service's Cloud Run logs |
| `/start-jitsi` components show `error` | IAM bindings from §2.3 missing; check activation backend logs |
| Proxy logs: STT connect failures (403) | `STT_USE_ID_TOKEN=true` missing on proxy, or `vmtb-services` lacks `roles/run.invoker` |
| No captions / nothing in proxy logs | §6.5 wiring wrong: jicofo.conf template, prosody module not loaded (`systemctl status prosody`), or client toggle off |
| Segments never appear in Supabase | proxy secrets wrong (`supabase-url` / `supabase-service-role-key`); check proxy logs for store errors |
| Worker never runs; status stuck PENDING | push subscription broken — rerun the transcript-worker workflow (it repairs it) |
| Meeting FAILED with LLM error | bad/expired Mistral key → fix `llm-api-key` secret, redeploy worker |
| WebSocket drops at exactly 60 min | Cloud Run hard cap; proxy/STT reconnect automatically — acceptable for MVP |
| CORS error in browser console | add frontend origin to `CORS_ORIGINS` env of activation backend, redeploy |
| Meeting iframe blank / external_api.js fails to load | the self-signed cert wasn't accepted in that browser yet — visit `https://<VM_IP>` directly and proceed past the warning (§8 step 2) |
| Render site 404s on refresh / deep links | missing SPA rewrite rule `/* → /index.html` (§7.1 step 4) |
| Frontend shows old backend URLs after env change | `VITE_*` vars bake at build time — trigger the deploy button again |
| Vercel workflow fails auth | wrong/expired `VERCEL_TOKEN`, or org/project ids swapped |
| Render hook returns non-200 | `RENDER_DEPLOY_HOOK` secret stale — re-copy from Render settings |
| Let's Encrypt fails later (§6.7) | DNS not propagated yet, or port 80 blocked (§6.1) |
