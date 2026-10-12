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

test('deployment wires PRAGMATIC_REDIS_URL from a secret ref, never inline', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    assert.match(deployment, /PRAGMATIC_REDIS_URL/)
    assert.match(deployment, /secretKeyRef/)
    assert.doesNotMatch(deployment, /value:\s*["']?redis:\/\//)
})

test('deployment sets PRAGMATIC_REPLICA_ID from the pod name', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    assert.match(deployment, /PRAGMATIC_REPLICA_ID/)
    assert.match(deployment, /fieldPath:\s*metadata\.name/)
})

test('values expose an optional redis block', () =>
{
    const values = Chart.Text('values.yaml')
    assert.match(values, /redis:/)
})

test('NOTES warn that replicaCount > 1 without redis is unsafe', () =>
{
    const notes = Chart.Text(join('templates', 'NOTES.txt'))
    assert.match(notes, /replicaCount/)
    assert.match(notes, /redis/i)
})
