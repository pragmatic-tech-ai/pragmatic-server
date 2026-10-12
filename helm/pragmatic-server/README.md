# pragmatic-server Helm chart

Deploys the headless pragmatic-server (connectors + identity).

## Install

The master key is required and is supplied at install time. It is never committed to values.yaml.

    helm install pragmatic ./helm/pragmatic-server \
      --set image.repository=<registry>/pragmatic-server \
      --set secrets.masterKeyB64=<base64 master key>

## Upgrade

    helm upgrade pragmatic ./helm/pragmatic-server --reuse-values

Tenants are configured through the `tenants` value (rendered to `tenants.json` in a ConfigMap). Put secret references there, never secret values.

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
