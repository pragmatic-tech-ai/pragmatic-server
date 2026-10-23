# Local dev and demo environments

Two Docker-backed environments for `pragmatic-server`: a development tenant (`dev`, port 8080) and a runtime demo tenant (`demo`, tenant `contoso`, port 8081) running the Northwind sample application with a Power-Platform-style security model.

## One-time image build

Run from the workspace root `architecture-agent/`, which holds all sibling packages:

```
DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path-to>/.npmrc -t pragmatic-server:dev .
```

## Bring-up

Run from the `pragmatic-server` dir:

```
npx tsx environments/seed/seed.ts up dev
npx tsx environments/seed/seed.ts up demo
```

`up` builds the config bundle, seeds the data volume, starts the container, waits for health, and (demo only) creates the demo users. Other commands: `status`, `logs`, `seed-users` (demo only), `build` (prints the image build command).

## Connect

- dev: `ws://localhost:8080/?environment=dev`
- demo: `ws://localhost:8081/?environment=contoso`

## Login

`POST /auth/login?environment=<id>` with `{ "email", "password" }` returns `{ token }`; pass it as `Authorization: Bearer <token>` on the WebSocket upgrade. The admin principal is `admin` / `admin@<tenant>.test`, with the password in the generated `provisioned-secrets.json` under `<tenant>-admin-pw`.

Demo users (password under `<principalId>-pw`): `rep-boston`, `rep-atlanta`, `manager-north` (Editor) and `finance` (Viewer), all `@contoso.test`.

## Teardown

```
npx tsx environments/seed/seed.ts down dev
npx tsx environments/seed/seed.ts down demo
```

## Generated files

`master.key`, `provisioned-secrets.json`, `tenants.json`, and `data/` under each environment dir are generated and gitignored. Copy `demo/seed/provisioned-secrets.example.json` to see the required secret refs; real secrets are generated fresh on first `up`.

## Integration smoke

`npx tsx environments/seed/smoke.ts` (needs Docker and the built image; operator-run, not part of `npx tsx --test`) brings up the demo and checks BU depth, field security, sharing, and assign, printing PASS or FAIL per axis.
