# Platform images: live check

This is the hands-on check for platform images piece 1: one image per app, a signed release published to GHCR by a `release/X.Y.Z` tag, and the control plane importing it. It needs the user, because it creates a credential and pushes to GitHub. Run the steps in order; each states what you should see. Stop at the first step that does not match.

Design: `docs/superpowers/specs/2026-11-09-platform-images-design.md`. Operator details: `admin/README.md`, "Releases from the registry".

## Part 1: local image build (deferred from the image task)

Needs Docker with Buildx and every sibling checked out beside pragmatic-server in the workspace root `architecture-agent/`. The siblings need not be built: the image build stage installs and builds each one itself (and runs the closure check).

1. Write an `.npmrc` outside the repository containing the read-only token (see Part 2, step 1) as `//npm.pkg.github.com/:_authToken=<token>` plus `@pragmatic-tech-ai:registry=https://npm.pkg.github.com`. Expected: the file exists and is not under any git repository.
2. From the workspace root, build all eight images into the local Docker store:

   ```
   NPMRC_FILE=<path-to>/.npmrc VERSION=0.0.0-local SERVER_SHA=local docker buildx bake -f pragmatic-server/docker/docker-bake.hcl --set "*.output=type=docker" --allow=fs.read=<path-to>/.npmrc
   ```

   Expected: the build finishes without error and no token appears in the output.
3. List the images: `docker image ls "ghcr.io/pragmatic-tech-ai/*"`. Expected: eight repositories, `pragmatic-platform-admin`, `pragmatic-platform-edge`, `pragmatic-env-server`, `pragmatic-env-gateway`, `pragmatic-hive-agent`, `pragmatic-tenant-admin`, `pragmatic-tenant-idp` and `pragmatic-ui-unpack`, each tagged `0.0.0-local`.
4. Measure each size with `docker image inspect -f '{{.Size}}' ghcr.io/pragmatic-tech-ai/<app>:0.0.0-local`. Expected: a number of bytes per image; record all eight. `pragmatic-hive-agent` and `pragmatic-ui-unpack` must each be under 300 MB (300000000 bytes).
5. Check that each entry point parses: `docker run --rm --entrypoint node ghcr.io/pragmatic-tech-ai/<app>:0.0.0-local --check <entry>`, with the entry from `docker/images/closure.json`:
   - `pragmatic-platform-admin` and `pragmatic-platform-edge`: `dist-tenant-admin/admin/control-plane/server.js`
   - `pragmatic-env-server`: `dist/bin/pragmatic-serverd.js`
   - `pragmatic-env-gateway`: `dist/bin/pragmatic-gatewayd.js`
   - `pragmatic-hive-agent`: `dist/bin/pragmatic-agentd.js`
   - `pragmatic-tenant-admin`: `dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js`
   - `pragmatic-tenant-idp`: `dist/bin/pragmatic-idpd.js`
   - `pragmatic-ui-unpack`: `dist-ui-unpack/admin/control-plane/bin/pragmatic-ui-unpack.js`

   Expected: no output and exit code 0 for all eight.
6. Start each image with no configuration, for example `timeout 10 docker run --rm ghcr.io/pragmatic-tech-ai/<app>:0.0.0-local` (`timeout` is a POSIX tool: on Windows run this from Git Bash, not PowerShell). Expected: each prints its own configuration or startup error sentence and exits (or is cut off after 10 seconds), and none prints `ERR_MODULE_NOT_FOUND`. Include `pragmatic-hive-agent` and `pragmatic-ui-unpack`. An `ERR_MODULE_NOT_FOUND` means the image's closure in `docker/images/closure.json` is missing a package: fix the closure, not the check.
7. Remove the local images and the `.npmrc` when done. Expected: the `.npmrc` is gone.

## Part 2: first release

1. The user creates the read-only GHCR token: a classic personal access token with only `read:packages`. Write the credential file outside the repository, never committed: `{ "username": "<github user>", "token": "<token>" }`. Expected: the file exists, readable only by the user.
2. The user approves pushing the branch `feat/platform-images` and the first tag. Use a throwaway early-access tag for this first live run, so a mistake can never burn the first stable version (a published version can never be reused): push the branch, then `git tag release/0.0.1-early.1` and `git push origin release/0.0.1-early.1`. Expected: GitHub starts a `release` workflow run for that tag. (The repository secrets `PACKAGES_TOKEN` and `RELEASE_SIGNING_KEY` must already exist; the public half of the signing key is `release-keys/release-2026-11.pub.pem`.) The steps below write the version as `<version>`: `0.0.1-early.1` for this run; cut `release/0.1.0` the same way only once this run is green end to end.
3. Watch the workflow run. Expected: green. The check step reports the version is free, the release toolkit tests pass, the siblings are cloned at their default-branch head (each one's commit is printed in `siblings.json`), the bake (which runs the closure check) pushes eight images, and the publish step prints the published version and descriptor. A signing key that does not match `release-keys/release-2026-11.pub.pem` stops the publish step with "The signing key does not match the trusted public key ..." and pushes no descriptor, so the version stays free. No token or key appears in any log line.
4. Open the GitHub packages for the `pragmatic-tech-ai` organisation. Expected: nine packages, the eight images plus `pragmatic-release`, all public for now (packages pushed from a public repository inherit its visibility; see the design, §2 item 6). `pragmatic-release` has the tag `<version>`; each image has `<version>` and `git-<server sha>`.
5. Start the control plane with the credential file: `PRAGMATIC_RELEASE_CREDENTIAL_FILE=<path> npx tsx admin/control-plane/server.ts` (the registry, namespace, trust directory and poll interval default to ghcr.io, `pragmatic-tech-ai`, `release-keys` and 300 seconds). On a fresh data directory also set `PRAGMATIC_ADMIN_OPERATOR_PASSWORD=<password>` to bootstrap the first operator (it is read on the first run only); without it a fresh control plane refuses to start. Expected: it starts without a configuration error and neither the token nor the password is logged. `/healthz` on the operator host answers 200.
6. As a Full operator, press Refresh in the Releases section of the portal (or `POST /api/releases/refresh`). Expected: the answer lists `<version>` under `imported` with nothing under `rejected`; the portal shows `<version>` as Verified with eight images, each by digest, and the recorded sibling commits.
7. Press Refresh again. Expected: `<version>` is now counted under `unchanged`, nothing imported.
8. Gate `<version>` for a tenant in the portal. Expected: the gating succeeds (a Rejected release is not even offered in the Gate dialog).
9. Select `<version>` for a hive. Expected: refused with the sentence "Release <version> is in the registry but hives cannot run registry releases yet." (hives cannot run registry releases until piece 2). Through the other routes the refusal is generic, so a tenant cannot probe which versions exist: the tenant route answers "Requested version is not available for this hive", the agent route "Version is not adoptable for this hive".
10. Optional negative check: start the control plane with a credential file whose token lacks access, and press Refresh. Expected: 502 with a fixed sentence that does not contain the token.

## If a step fails

A red workflow before the bake changes nothing in the registry; fix it, delete the failed tag and push it again. The check step refuses a version whose descriptor is already published, so never reuse such a version. A release the control plane shows as Rejected failed verification: its descriptor or an image is not signed by a trusted key in `release-keys/`, or an image is not present at its signed digest. Every Refresh re-inspects Rejected versions, so once the cause is fixed (the image tag restored, the key added to `release-keys/`) the next Refresh imports the version as Verified in place of the Rejected record.
