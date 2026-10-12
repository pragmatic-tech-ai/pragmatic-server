import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

class Chart
{
    public static Dir(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'helm', 'pragmatic-server')
    }

    public static HelmOnPath(): boolean
    {
        return spawnSync('helm', ['version'], { shell: true }).status === 0
    }
}

test('Chart.yaml exists with the chart name', () =>
{
    const text = readFileSync(join(Chart.Dir(), 'Chart.yaml'), 'utf8')
    assert.match(text, /name:\s*pragmatic-server/)
})

test('values default replicaCount is 1 (single-replica-safe for local mode)', () =>
{
    const text = readFileSync(join(Chart.Dir(), 'values.yaml'), 'utf8')
    assert.match(text, /replicaCount:\s*1/)
})

test('configmap wraps tenants under the tenants key', () =>
{
    const text = readFileSync(join(Chart.Dir(), 'templates', 'configmap.yaml'), 'utf8')
    assert.ok(text.includes('dict "tenants"'))
})

test('deployment pins a numeric runAsUser', () =>
{
    const text = readFileSync(join(Chart.Dir(), 'templates', 'deployment.yaml'), 'utf8')
    assert.ok(text.includes('runAsUser: 10001'))
})

test('helm template renders without error when helm is available', { skip: Chart.HelmOnPath() ? false : 'helm not on PATH' }, () =>
{
    const result = spawnSync('helm', ['template', Chart.Dir()], { shell: true, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /kind:\s*Deployment/)
    assert.match(result.stdout, /\/readyz/)
})
