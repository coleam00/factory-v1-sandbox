# Shelf sandbox deployment

This document authorizes only the local acceptance deployment on port 4197, in
`C:/Users/colem/OpenSource/v1test-runtime/deployment`. It does not authorize any
production service, remote host, cloud target, or database migration.

Run the deployment workflow on the hidden MCFactory desktop through the existing
runtime launcher. The deployment command must inherit that desktop.

For the exact requested full commit SHA, execute:

```powershell
powershell.exe -NoProfile -File C:/Users/colem/OpenSource/v1test-runtime/deploy-shelf.ps1 -Revision <requested-full-sha>
```

The script fetches sandbox main, checks that it contains the requested revision,
creates a detached release checkout, installs locked dependencies, and starts Shelf
with APP_REVISION taken from that checkout's actual HEAD. It uses port 4197 and a
separate persistent sandbox database. It refuses to replace an existing deployment.

Wait up to 30 seconds for this health check, polling at one-second intervals:

```powershell
bun .archon/workflows/factory/deploy/scripts/read-health.ts http://localhost:4197/health
```

The reader accepts only an HTTP 200 JSON response containing exactly `status: "ok"`
and a lowercase full commit or `null` revision. Read the deployed revision from its
JSON output and require an exact full-SHA match to the requested commit. A process ID
or successful start command alone does not establish health or deployed identity.

Also verify the normal app is served:

```powershell
(Invoke-WebRequest -UseBasicParsing http://localhost:4197/).StatusCode
```

Record these responses and the non-secret deployment record at
`C:/Users/colem/OpenSource/v1test-runtime/deployment/running.json` as evidence.
On failure, report it. Do not change the requested revision, substitute another
port, overwrite an existing deployment, or stop any process by name.
