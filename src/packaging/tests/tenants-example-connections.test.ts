import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

class Repo
{
    private static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

    public static Text(relative: string): string
    {
        return readFileSync(join(Repo.Root, relative), 'utf8')
    }
}

test('the tenants example declares a connection with a secret ref, no inline password', () =>
{
    const text = Repo.Text(join('docker', 'tenants.example.json'))
    const parsed = JSON.parse(text) as { tenants: Record<string, { connections?: Record<string, { settings: Record<string, string>; secretRef?: string }> }> }
    const crm = parsed.tenants.acme?.connections?.crm
    assert.ok(crm !== undefined)
    assert.ok(typeof crm.secretRef === 'string' && crm.secretRef.length > 0)
    assert.equal(crm.settings.password, undefined)
    for (const key of Object.keys(crm.settings))
    {
        assert.doesNotMatch(key, /pass|secret|token/i)
    }
})

test('the chart README documents file-declared connections and their secretRef', () =>
{
    const readme = Repo.Text(join('helm', 'pragmatic-server', 'README.md'))
    assert.match(readme, /connections/)
    assert.match(readme, /secretRef/)
})
