# Manual served-app smoke: watch the browser console

## What this is for

A manual smoke puts the **served runtime app** in front of you in a real
browser with DevTools open, so you can watch its console the way a real user's
browser would see it. It is how we caught the NaN flood: the served app builds
its visual tree, and any mural/rendering regression shows up as a torrent of
console errors there long before it shows up anywhere else.

The bar is **zero** served-app console errors on a healthy app. For reference,
the bug we fixed on 2026-10-21 looked like this in the console:

- ~8,600 `<svg>` / geometry errors complaining about `NaN` width/height/path
  values (the eager-`Thickness`-token-tuple bug);
- one `GET …/favicon.ico 404`;
- (Electron renderer only, not the browser) six `file://…/assets/fonts/*.woff2 404`.

All three are gone now. If any of them reappears, something regressed.

There are two ways to run the smoke. **Path A** is the fastest and reproduces
exactly what we analyzed — reach for it first. **Path B** is the fully hand-driven
version; use it when you want the app to stay up so you can edit, rebuild and
reload while watching the console.

---

## Path A — drive the automated harness and read what it captures (recommended)

The gated live-loop e2e already stands up the whole author→promote→publish→serve
loop, opens a **real (headed) chromium** window on your second monitor, points it
at the served app, and dumps the served-app console to a file. You do not have to
reproduce any of that by hand — you run it and read the capture.

### One-time prerequisites

Same as the live-loop runbook (`2026-10-20-runtime-live-loop-runbook.md`):

1. Docker running (`docker info`).
2. Build the server image, from the workspace root `architecture-agent/`:

   ```
   DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path>/.npmrc -t pragmatic-server:dev .
   ```

   `<path>` is the directory holding a private `.npmrc` with a `read:packages`
   token (refresh with `gh auth token` if it expired). Rebuild this image whenever
   you change **pragmatic-server** source — the e2e runs the server from the image,
   not from your working tree.
3. `npx playwright install chromium`.
4. Build Plexus so `apps/plexus/out/main/index.js` exists (`npm run build` in
   `apps/plexus`), after rebuilding any sibling `dist` it consumes.

### Run it

From `apps/plexus` in the Plexus repo (Git Bash form):

```
SP_RUNTIME_LOOP_E2E=1 SP_E2E_WINDOW_ORIGIN=-2560,0 npx playwright test runtime-live-loop.spec.ts
```

PowerShell: set `$env:SP_RUNTIME_LOOP_E2E = '1'` and
`$env:SP_E2E_WINDOW_ORIGIN = '-2560,0'` first, then run the `npx` line.
`SP_E2E_WINDOW_ORIGIN` is the `x,y` origin of your second monitor — drop it if
you only have one display. Add `SP_SERVER_REPO=<path-to-pragmatic-server>` if the
server repo is not the sibling default.

### Read the capture

The run prints two lines near the end and writes two gitignored files under
`apps/plexus/e2e/.artifacts/`:

- `smoke-browser-console.log` — the **served app's** console + page errors, deduped
  and redacted. This is the one that matters for a served-app smoke.
- `smoke-renderer-console.log` — the Electron renderer's console (the authoring app),
  for completeness.

A healthy run prints `served-app console: 0 records`. Anything above zero is listed
in the file, grouped by message, most-repeated first — that grouping is what turned
8,600 raw records into a short list of distinct causes.

### Watch it live instead (optional)

The chromium window is already headed, so you can watch it during the run, but the
loop is fast and tears everything down at the end. To freeze it on the served page,
add a `await page.pause()` right after the `AssertRenders` call in the capstone
step of `runtime-live-loop.spec.ts`, run with `--headed`, and the Playwright
inspector will hold the browser open with DevTools reachable (F12). Remove the
`pause()` afterwards — don't commit it.

---

## Path B — fully manual: publish once, keep the app up, watch and iterate

Use this when you want to change something, rebuild, reload, and watch the console
react — the app and its server stay up the whole time.

### Prerequisites

The Path A one-time prerequisites, plus build the admin portal once (from the
pragmatic-server repo root):

```
npm --prefix admin/portal install && npm --prefix admin/portal run build
```

### 1. Start the control plane

From the pragmatic-server repo root:

```
PRAGMATIC_ADMIN_OPERATOR_PASSWORD=choose-a-password npx tsx admin/control-plane/server.ts
```

It binds `127.0.0.1:7000`. Open the portal at `http://localhost:7000/` and log in
with `admin@control-plane.test` and the password you set (the password variable is
only needed the first time; it seeds the operator and is ignored afterwards).

### 2. Create a runtime environment

In the portal, create a **demo-contoso** environment. That seeds the Contoso
security model and four demo users, and runs as a `pragmatic-server:dev` container
on an allocated host port. Note the **host port** the portal reports (call it
`PORT`) and the tenant, which is `contoso`. The environment is reachable at
`http://localhost:PORT` and `ws://localhost:PORT/?tenant=contoso`.

A demo-contoso environment starts with an **empty environment graph** — until you
promote/publish into it, the app route has nothing to serve. If you only want to
exercise the *shell* (chrome, theme, fonts, favicon) you can open the login and app
routes now; to see data render you need step 3.

### 3. Publish an app into it from Plexus

Launch the built Plexus app. Open a solution (the Contoso fixture under
`apps/plexus/e2e/fixtures/contoso` is the one the e2e uses), run **Generate UI** for
the entrypoint concept, then run the **Publish-env** command for that project
(the `tenant.publish-env` relay command). It needs the runtime's WebSocket URL
(`ws://localhost:PORT/?tenant=contoso`) and a **deploy token** for the environment —
both come from the control plane when the environment is created. This publish step
is the one the e2e automates end-to-end; doing it by hand is the fiddly part, so if
you only need to *observe* the console, Path A is the surer reproduction.

### 4. Open the served app and sign in

Open the app route in Chrome (or any browser):

```
http://localhost:PORT/app/<tenant>/<appId>/
```

The shell loads **without** auth (so you can watch the rendering/console
immediately); the session is only needed for live data. For the Contoso fixture
the app id is `contoso`.

There is **no login web page** — authentication is a POST JSON API
(`/auth/browser-login?tenant=<tenant>`), not a URL you navigate to (a GET
returns `method not allowed`). To get a session in a plain browser, POST the
credentials from the app page's own origin so the `SameSite=Strict` cookie is
stored. On the app page, open DevTools → Console and run:

```js
fetch('/auth/browser-login?tenant=<tenant>', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: '<reader-email>', password: '<reader-password>' }),
}).then(r => { console.log('login', r.status); if (r.ok) location.reload() })
```

Expect `login 200` and a reload that now shows data. For repeat logins, wrap the
same `fetch` in a `javascript:` **bookmarklet** dragged to the bookmarks bar and
click it while on a `localhost:PORT` page — Chrome strips the `javascript:`
prefix if you paste the URL into the bookmark dialog, so you must *drag* it. Use a
reader account from the demo-contoso seed (the portal lists the seeded users).

### 5. Open DevTools and read the console

Press **F12**, go to **Console**, and reload the app route. On a healthy app the
console is quiet. If errors flood in, sort by collapsing duplicates (Chrome groups
repeats with a count) to find the distinct causes — that is exactly how the NaN
flood collapsed to one root cause.

### 6. Iterate

Change code, rebuild along the propagation path, reload the browser tab:

- **mural** change → build mural `dist` **and** `build:templates`, then copy
  `dist` over `node_modules/@pragmatic-tech-ai/mural/build` in Plexus (mural is a
  copy there), then rebuild Plexus `out/`. The served esbuild bundle reads mural
  `dist`; the 35 `*.template.mu.js` live in mural `build/`.
- **todl** change → build TODL `dist` (todl is symlinked into Plexus).
- **pragmatic-server** change → rebuild the `pragmatic-server:dev` image and
  recreate the environment (the running container is from the old image).
- **Plexus** change → rebuild `out/` and re-publish.

Then reload the browser tab and re-read the console.

---

## Troubleshooting

- **Image missing / Docker down** — see the live-loop runbook; start Docker,
  confirm with `docker info`, rebuild the image with the exact tag
  `pragmatic-server:dev`.
- **App route is blank or "could not load its data"** — nothing was promoted/
  published into the environment graph, or a connector/column is missing. For the
  served Contoso app the graph must hold the promoted packages.
- **Windows open on the wrong monitor (Path A)** — set `SP_E2E_WINDOW_ORIGIN` to
  your second monitor's `x,y` origin.
- **Fonts 404 in the console** — on the served app the woff2s should be 200 (the
  server serves a path only if the app manifest's `ui.assets` lists it). A 404 here
  means the asset was not emitted or not listed; `file://…/assets/fonts/*` 404s are
  a separate Electron-renderer packaging concern, not the served app.
