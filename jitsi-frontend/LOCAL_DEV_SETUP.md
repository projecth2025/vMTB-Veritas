# Local Development Setup - Jitsi Frontend Loader

## 1. Required Environment Variables ✅

All variables are now configured in `.env` for **local development**:

```dotenv
# Backend URL - CHANGE BASED ON YOUR SETUP
VITE_JITSI_BACKEND_URL=http://localhost:8000
# This should match where your Python backend is running

# Jitsi Meeting Server
VITE_JITSI_DOMAIN=meet.vmtb.in
# For local testing, you may need to update this if using a local Jitsi instance

# Main App URL - redirect destination after meeting
VITE_MAIN_APP_URL=http://localhost:5173
# This is the Vite dev server running the main app

# Debug logging
VITE_DEBUG=true
# Set to true to see detailed logs in browser console
```

### Important Notes:
- **`VITE_JITSI_BACKEND_URL`**: Make sure your Python backend is running on `http://localhost:8000` or update this value accordingly
- **`VITE_JITSI_DOMAIN`**: Keep as `meet.vmtb.in` for now (production Jitsi server)
- **`VITE_DEBUG`**: Set to `true` for development to see detailed logs

---

## 2. Server Check Flow Validation ✅

The polling mechanism works in these steps:

### Step-by-Step Flow:

```
1. User clicks "Start Meeting" on main app (localhost:5173)
   ↓
2. Redirects to server loader (localhost:3000)
   ↓
3. MeetingPage.tsx initializes:
   - Gets room name from URL query param (?room=mtb_name)
   - Creates MeetingService instance
   ↓
4. MeetingService.waitForMeetingReady() starts polling:
   - Makes POST request to backend: http://localhost:8000/start-jitsi
   - Polls every 5 seconds for up to 90 seconds (18 attempts)
   ↓
5. State Machine Transitions:
   - WAITING: Initial state
   - WAITING → FIRST_READY: When backend first returns 'already_running'
   - FIRST_READY → OPENED: When backend confirms again (ensures stability)
   ↓
6. On success (OPENED state):
   - Redirects to Jitsi: https://meet.vmtb.in/mtb_name
   ↓
7. User joins meeting
   ↓
8. On exit from meeting:
   - Shows thank you page
   - User clicks "Return to App" → back to localhost:5173
```

### Expected Backend Responses:

Your backend at `/start-jitsi` should return JSON with one of these statuses:

```json
{
  "status": "starting"
}
// Sent while Jitsi server is initializing
```

```json
{
  "status": "already_running"
}
// Sent when Jitsi server is ready to accept connections
```

---

## 3. Debug Logging System ✅

Detailed logs are now added at every step. Open your **Browser DevTools Console** (F12) to see them.

### Log Format:
```
[INIT] Step 1: Get room name from URL
[API] Calling: http://localhost:8000/start-jitsi
[POLL] Attempt 1/18 | Elapsed: 0.0s | State: WAITING
[API] Response status: 200 OK
[API] Response success: { status: "starting" }
[POLL] API Response status: 'starting'
...
```

### What Each Log Prefix Means:

| Prefix | Where | Meaning |
|--------|-------|---------|
| `[INIT]` | MeetingPage.tsx | Initialization flow |
| `[API]` | MeetingService.ts | Backend API calls |
| `[POLL]` | MeetingService.ts | Polling loop status |

### Full Log Example (Success Case):

```
[INIT] ========== MEETING INITIALIZATION START ==========
[INIT] Step 1: Get room name from URL
[INIT] Room name extracted: 'mtb_test'
[INIT] Step 2: Initialize MeetingService
[INIT] Step 3: Wait for backend to be ready (polling)...
[POLL] Attempt 1/18 | Elapsed: 0.0s | State: WAITING
[API] Calling: http://localhost:8000/start-jitsi
[API] Sending POST request...
[API] Response status: 200 OK
[API] Response success: { status: "starting" }
[POLL] API Response status: 'starting'
[POLL] Server starting... 0.1s elapsed
[POLL] Attempt 2/18 | Elapsed: 5.0s | State: WAITING
[API] Calling: http://localhost:8000/start-jitsi
[API] Sending POST request...
[API] Response status: 200 OK
[API] Response success: { status: "already_running" }
[POLL] API Response status: 'already_running'
[POLL] ✓ State transition: WAITING → FIRST_READY (first detection)
[POLL] Attempt 3/18 | Elapsed: 10.0s | State: FIRST_READY
[API] Calling: http://localhost:8000/start-jitsi
[API] Sending POST request...
[API] Response status: 200 OK
[API] Response success: { status: "already_running" }
[POLL] API Response status: 'already_running'
[POLL] ✓✓ State transition: FIRST_READY → OPENED (confirmed running)
[POLL] ✓✓✓ SUCCESS! Server is ready after 10.1s
[INIT] Step 4: Backend confirmed ready, preparing redirect...
[INIT] Step 5: Redirecting to Jitsi: https://meet.vmtb.in/mtb_test
[INIT] ========== MEETING INITIALIZATION COMPLETE ==========
```

### Common Error Log Examples:

**Error: Backend not running**
```
[API] Calling: http://localhost:8000/start-jitsi
[API] Error: Failed to fetch
[API] Unknown error: TypeError: Failed to fetch
```

**Error: Wrong status response**
```
[POLL] API Response status: 'unknown_status'
[POLL] Unknown status: 'unknown_status'
```

**Error: Timeout**
```
[POLL] ❌ TIMEOUT after 90.0s
```

---

## 4. Testing Checklist

When testing locally, verify these in order:

- [ ] Backend running on `http://localhost:8000`
- [ ] Main app running on `http://localhost:5173`
- [ ] Jitsi-frontend running on `http://localhost:3000`
- [ ] Open DevTools Console (F12) to see logs
- [ ] Click "Start Meeting" on an MTB
- [ ] See redirect to `localhost:3000?room=...`
- [ ] See loader and polls in console
- [ ] Backend responds with 'starting' → 'already_running'
- [ ] See redirect to `meet.vmtb.in/...`
- [ ] Jitsi loads and shows meeting
- [ ] Leave meeting
- [ ] See thank you page
- [ ] Click "Return to App" → back to `localhost:5173`

---

## 5. Troubleshooting Guide

### Problem: "No room name provided in URL"
**Cause**: Room name not in URL query params  
**Solution**: URL should be `http://localhost:3000?room=mtb_name`  
**Check**: Click the button from main app, don't manually type the URL

### Problem: "[API] Error: Failed to fetch"
**Cause**: Backend not running or wrong URL  
**Solution**: 
- Verify backend running: `python Backend-jitsi-activation/main.py`
- Check `VITE_JITSI_BACKEND_URL` in `.env` matches your backend port

### Problem: "Server startup timeout (90 seconds)"
**Cause**: Backend not responding with 'already_running' status  
**Solution**:
- Check backend logs
- Verify `/start-jitsi` endpoint exists
- Ensure response has correct JSON format

### Problem: Redirect to Jitsi doesn't load
**Cause**: Jitsi domain or room name incorrect  
**Solution**:
- Check `VITE_JITSI_DOMAIN` in `.env`
- Room name should be alphanumeric with hyphens only

---

## 6. Switching to Production URLs

When ready to deploy, update `.env`:

```dotenv
# Change this from localhost to deployed backend
VITE_JITSI_BACKEND_URL=https://jitsi-activation-backend.onrender.com

# Change from localhost:3000 to production server URL
VITE_MAIN_APP_URL=https://vmtb.in

# Keep Jitsi server as is
VITE_JITSI_DOMAIN=meet.vmtb.in
```

Then rebuild and deploy.
