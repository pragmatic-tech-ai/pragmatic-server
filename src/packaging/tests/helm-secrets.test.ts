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

test('secret renders the provisioned blob via stringData toJson, never b64enc', () =>
{
    const secret = Chart.Text(join('templates', 'secret.yaml'))
    assert.match(secret, /\.Values\.secrets\.provisioned/)
    assert.match(secret, /toJson/)
    assert.doesNotMatch(secret, /b64enc/)
})

test('deployment mounts the provisioned secret and sets PRAGMATIC_PROVISIONED_SECRETS_FILE', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    assert.match(deployment, /PRAGMATIC_PROVISIONED_SECRETS_FILE/)
    assert.match(deployment, /\/run\/secrets\/provisioned\/secrets\.json/)
    assert.match(deployment, /provisionedExistingSecret/)
})

test('deployment rolls the pod on provisioned-secret rotation via a checksum annotation', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    assert.match(deployment, /checksum\/secret/)
})

test('values expose a provisioned secrets block and drop the reserved stubs', () =>
{
    const values = Chart.Text('values.yaml')
    assert.match(values, /provisioned:\s*\{\}/)
    assert.match(values, /provisionedExistingSecret:/)
    assert.match(values, /provisionedSecretKey:/)
    assert.doesNotMatch(values, /adminPasswords:/)
})

test('the ConfigMap never carries a provisioned secret value', () =>
{
    const configmap = Chart.Text(join('templates', 'configmap.yaml'))
    assert.doesNotMatch(configmap, /secrets\.provisioned/)
})

test('NOTES mention provisioned per-tenant secrets', () =>
{
    const notes = Chart.Text(join('templates', 'NOTES.txt'))
    assert.match(notes, /provisioned/i)
})

test('the provisioned volume/env are gated and the existingSecret overrides the chart Secret name', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    assert.match(deployment, /\{\{- if or \.Values\.secrets\.provisioned \.Values\.secrets\.provisionedExistingSecret \}\}/)
    assert.match(deployment, /secretName: \{\{ \.Values\.secrets\.provisionedExistingSecret \| default/)
})
