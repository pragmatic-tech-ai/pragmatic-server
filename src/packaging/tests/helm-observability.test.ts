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

    public static Template(path: string): string
    {
        return readFileSync(join(Chart.Dir(), 'templates', path), 'utf8')
    }
}

test('deployment template gates the Stage-C observability + drain wiring', () =>
{
    const text = Chart.Template('deployment.yaml')
    assert.ok(text.includes('.Values.drain.terminationGracePeriodSeconds'))
    assert.ok(text.includes('preStop'))
    assert.ok(text.includes('.Values.observability.metrics.enabled'))
    assert.ok(text.includes('PRAGMATIC_METRICS_PORT'))
    assert.ok(text.includes('PRAGMATIC_OTLP_ENDPOINT'))
    assert.ok(text.includes('PRAGMATIC_DRAIN_TIMEOUT_MS'))
    assert.ok(text.includes('prometheus.io/scrape'))
})

test('gateway + worker templates gate the same Stage-C wiring', () =>
{
    for (const file of ['gateway-deployment.yaml', 'worker-statefulset.yaml'])
    {
        const text = Chart.Template(file)
        assert.ok(text.includes('.Values.drain.terminationGracePeriodSeconds'), file)
        assert.ok(text.includes('preStop'), file)
        assert.ok(text.includes('PRAGMATIC_OTLP_ENDPOINT'), file)
        assert.ok(text.includes('prometheus.io/scrape'), file)
    }
})

test('values.yaml ships observability + drain defaulted off', () =>
{
    const text = readFileSync(join(Chart.Dir(), 'values.yaml'), 'utf8')
    assert.match(text, /observability:/)
    assert.match(text, /enabled:\s*false/)
    assert.match(text, /drain:/)
})

test('a default render contains none of the Stage-C tokens (byte-unchanged when disabled) (Review Focus 4)', { skip: Chart.HelmOnPath() ? false : 'helm not on PATH' }, () =>
{
    const result = spawnSync('helm', ['template', Chart.Dir()], { shell: true, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /terminationGracePeriodSeconds/)
    assert.doesNotMatch(result.stdout, /preStop/)
    assert.doesNotMatch(result.stdout, /PRAGMATIC_METRICS_PORT/)
    assert.doesNotMatch(result.stdout, /PRAGMATIC_OTLP_ENDPOINT/)
    assert.doesNotMatch(result.stdout, /prometheus\.io\/scrape/)
})

test('an opted-in render emits the metrics port, preStop, grace period, annotations and OTLP env', { skip: Chart.HelmOnPath() ? false : 'helm not on PATH' }, () =>
{
    const result = spawnSync('helm', ['template', Chart.Dir(),
        '--set', 'observability.metrics.enabled=true',
        '--set', 'observability.metrics.port=9464',
        '--set', 'observability.otlp.endpoint=http://collector:4318',
        '--set', 'drain.timeoutMs=25000',
        '--set', 'drain.preStopSeconds=5',
        '--set', 'drain.terminationGracePeriodSeconds=35',
    ], { shell: true, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /terminationGracePeriodSeconds:\s*35/)
    assert.match(result.stdout, /preStop/)
    assert.match(result.stdout, /containerPort:\s*9464/)
    assert.match(result.stdout, /PRAGMATIC_METRICS_PORT/)
    assert.match(result.stdout, /PRAGMATIC_OTLP_ENDPOINT/)
    assert.match(result.stdout, /prometheus\.io\/scrape:\s*"true"/)
})
