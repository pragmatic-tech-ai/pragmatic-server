# pragmatic-server Helm chart

Deploys the headless pragmatic-server (connectors + identity).

## Install

The master key is required and is supplied at install time. It is never committed to values.yaml.

    helm install pragmatic ./helm/pragmatic-server \
      --set image.repository=<registry>/pragmatic-server \
      --set secrets.masterKeyB64=<base64 master key>

## Upgrade

    helm upgrade pragmatic ./helm/pragmatic-server --reuse-values

Tenants are configured through the `tenants` value (rendered to `tenants.json` in a ConfigMap). `tenants` is the tenant map (the body under the `tenants` key; the chart wraps it), e.g. `tenants: { acme: { displayName: Acme } }`. Put secret references there, never secret values.

Per-tenant secrets (OIDC client secrets, bootstrap-admin passwords) are supplied through a single Kubernetes Secret and mounted at `/run/secrets/provisioned/secrets.json` (the server reads it via `PRAGMATIC_PROVISIONED_SECRETS_FILE` and writes each tenant's named refs into its encrypted store at build time). Provide them chart-managed via `secrets.provisioned` (a map of the ref strings used in `tenants` to their values -- dev convenience only, never commit real values) or out-of-band via `secrets.provisionedExistingSecret` (+ `secrets.provisionedSecretKey`, default `provisioned-secrets.json`). A tenant that names a ref with no matching value fails that tenant closed. Rotating an out-of-band `provisionedExistingSecret` does not automatically roll the pod (the `checksum/secret` annotation covers only the chart-managed Secret); restart the deployment after rotating it. The server reads the file only at tenant build time.

A tenant may declare external connections under `connections` in its `tenants` entry: each connection has `settings` (plain key/value, e.g. host/port/database/user for SQL) and an optional `secretRef` (the password/token, resolved by reference from the provisioned Secret -- never an inline value). A tenant's models reference a connection by id (`datasource ... { connection = "<id>" }`). Every `connections[*].secretRef` must have a matching key in the provisioned Secret (`secrets.provisioned` or `secrets.provisionedExistingSecret`).

## Single replica

`replicaCount` must stay 1 in local (file-backed) mode. Multi-replica needs cloud/shared stores, which are deferred. With persistence enabled the Deployment uses the Recreate strategy because the volume is ReadWriteOnce.

## Ingress and HPA (cloud mode)

Both are off by default.

    helm upgrade pragmatic ./helm/pragmatic-server --reuse-values \
      --set deploymentMode=cloud \
      --set ingress.enabled=true --set ingress.host=pragmatic.example.com \
      --set autoscaling.enabled=true

Enable autoscaling only in cloud/shared-store mode.

## Probes

Liveness uses `/healthz`; readiness uses `/readyz`, which stays false until startup completes.
