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

## Cluster mode (gateway + worker split)

Set `cluster.enabled=true` to run a worker StatefulSet behind a gateway Deployment. The worker tier REQUIRES Redis (`redis.url` or `redis.existingSecret`) -- the ownership lease keeps one worker per tenant. Supply mTLS material through `cluster.tls.existingSecret` (the operator or cert-manager provides `tls.crt`, `tls.key`, `ca.crt`); nothing is inlined in values or the ConfigMap. `cluster.workerServerName` is the SAN every worker presents, and the gateway validates the worker certificate against it.

Worker storage is ALWAYS persistent -- the StatefulSet uses volumeClaimTemplates -- regardless of the top-level `persistence.enabled`, which only governs the single-Deployment path. To give the gateway its own client certificate, set `cluster.gateway.tls.existingSecret`; it defaults to the shared `cluster.tls.existingSecret`.
