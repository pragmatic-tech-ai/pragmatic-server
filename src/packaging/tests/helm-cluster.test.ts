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
