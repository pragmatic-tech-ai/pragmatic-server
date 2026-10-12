import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

class Chart
{
    private static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'helm', 'pragmatic-server')

    public static Text(relative: string): string
    {
        return readFileSync(join(Chart.Root, relative), 'utf8')
    }
}

test('values expose a cluster block defaulting to disabled, with an mTLS existingSecret', () =>
{
    const values = Chart.Text('values.yaml')
    assert.match(values, /cluster:/)
    assert.match(values, /enabled:\s*false/)
    assert.match(values, /existingSecret:/)
    assert.match(values, /workerServerName:/)
})

test('a component selector helper exists for the cluster workloads', () =>
{
    const helpers = Chart.Text(join('templates', '_helpers.tpl'))
    assert.match(helpers, /pragmatic-server\.componentSelectorLabels/)
})

test('the single Deployment and Service render only when cluster is disabled', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    const service = Chart.Text(join('templates', 'service.yaml'))
    assert.match(deployment, /if not \.Values\.cluster\.enabled/)
    assert.match(service, /if not \.Values\.cluster\.enabled/)
})

test('the worker StatefulSet renders with component=worker, mTLS mount, advertise, health probes, and the worker daemon', () =>
{
    const ss = Chart.Text(join('templates', 'worker-statefulset.yaml'))
    assert.match(ss, /kind: StatefulSet/)
    assert.match(ss, /app\.kubernetes\.io\/component: worker/)
    assert.match(ss, /dist\/bin\/pragmatic-workerd\.js/)
    assert.match(ss, /PRAGMATIC_TLS_CERT_FILE/)
    assert.match(ss, /PRAGMATIC_TLS_KEY_FILE/)
    assert.match(ss, /PRAGMATIC_TLS_CA_FILE/)
    assert.match(ss, /PRAGMATIC_WORKER_ADVERTISE_HOST/)
    assert.match(ss, /PRAGMATIC_HEALTH_PORT/)
    assert.match(ss, /path: \/readyz/)
    assert.match(ss, /if \.Values\.cluster\.enabled/)
    assert.doesNotMatch(ss, /tls\.key:/)
})

test('the worker Service is headless (clusterIP None) for stable per-pod DNS', () =>
{
    const svc = Chart.Text(join('templates', 'worker-service.yaml'))
    assert.match(svc, /clusterIP: None/)
    assert.match(svc, /app\.kubernetes\.io\/component: worker/)
})

test('the standalone PVC and HPA are also confined to the non-cluster path', () =>
{
    const pvc = Chart.Text(join('templates', 'pvc.yaml'))
    const hpa = Chart.Text(join('templates', 'hpa.yaml'))
    assert.match(pvc, /not \.Values\.cluster\.enabled/)
    assert.match(hpa, /not \.Values\.cluster\.enabled/)
})

test('the gateway Deployment renders with component=gateway, server name, mTLS mount, health, and the gateway daemon', () =>
{
    const dep = Chart.Text(join('templates', 'gateway-deployment.yaml'))
    assert.match(dep, /kind: Deployment/)
    assert.match(dep, /app\.kubernetes\.io\/component: gateway/)
    assert.match(dep, /dist\/bin\/pragmatic-gatewayd\.js/)
    assert.match(dep, /PRAGMATIC_WORKER_SERVERNAME/)
    assert.match(dep, /PRAGMATIC_TLS_CERT_FILE/)
    assert.match(dep, /path: \/readyz/)
    assert.doesNotMatch(dep, /tls\.key:/)
})

test('the ingress targets the gateway service when cluster is enabled', () =>
{
    const ingress = Chart.Text(join('templates', 'ingress.yaml'))
    assert.match(ingress, /cluster\.enabled/)
    assert.match(ingress, /-gateway/)
})

test('the ConfigMap never carries an mTLS value', () =>
{
    const configmap = Chart.Text(join('templates', 'configmap.yaml'))
    assert.doesNotMatch(configmap, /tls\.key/)
    assert.doesNotMatch(configmap, /BEGIN .*PRIVATE KEY/)
})

test('values never inline mTLS material (only an existingSecret ref)', () =>
{
    const values = Chart.Text('values.yaml')
    assert.doesNotMatch(values, /BEGIN .*PRIVATE KEY/)
    assert.doesNotMatch(values, /tls\.key:\s*\S/)
})

test('NOTES warn that cluster mode requires Redis (Review Focus 4)', () =>
{
    const notes = Chart.Text(join('templates', 'NOTES.txt'))
    assert.match(notes, /cluster/i)
    assert.match(notes, /redis/i)
})
