import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { FileTenantProvisioning } from '../../config/file-tenant-provisioning.js'

class Artifacts
{
    private static Root(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    }

    public static Compose(): unknown
    {
        return parse(readFileSync(join(Artifacts.Root(), 'docker-compose.yml'), 'utf8'))
    }

    public static TenantsExample(): string
    {
        return readFileSync(join(Artifacts.Root(), 'docker', 'tenants.example.json'), 'utf8')
    }
}

test('docker-compose is valid YAML with a pragmatic-server service', () =>
{
    const doc = Artifacts.Compose() as { services?: Record<string, unknown> }
    assert.ok(doc.services !== undefined)
    assert.ok('pragmatic-server' in doc.services)
})

test('the compose service builds from the parent context with the docker/Dockerfile', () =>
{
    const doc = Artifacts.Compose() as { services: { ['pragmatic-server']: { build: { context: string; dockerfile: string } } } }
    const build = doc.services['pragmatic-server'].build
    assert.equal(build.context, '..')
    assert.match(build.dockerfile, /docker\/Dockerfile/)
})

test('the example tenants file parses through FileTenantProvisioning', () =>
{
    const provisioning = FileTenantProvisioning.FromText(Artifacts.TenantsExample())
    assert.ok(provisioning.OptionsFor('acme') !== null)
})
