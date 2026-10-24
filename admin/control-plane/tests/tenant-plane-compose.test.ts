import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneServer } from '../server.js'
import { TenantAdminClientRegistry } from '../tenant-auth/tenant-admin-client-record.js'

describe('ControlPlaneServer.ParseSecretTtlHours', () =>
{
    const defaultHours = 168

    for (const raw of [undefined, '', '0', '-3', 'abc', '1.5'])
    {
        it(`falls back to the default for ${JSON.stringify(raw)}`, () =>
        {
            assert.equal(ControlPlaneServer.ParseSecretTtlHours(raw), defaultHours)
        })
    }

    it('returns the integer for valid positive values', () =>
    {
        assert.equal(ControlPlaneServer.ParseSecretTtlHours('24'), 24)
        assert.equal(ControlPlaneServer.ParseSecretTtlHours('720'), 720)
    })
})

describe('ControlPlaneServer.ParseHealthProbeMs', () =>
{
    const defaultMs = 30000
    const DisabledRaw = '0'
    const ValidRaw = '5000'

    for (const raw of [undefined, '', '-5', 'abc', '1.5'])
    {
        it(`falls back to the default for ${JSON.stringify(raw)}`, () =>
        {
            assert.equal(ControlPlaneServer.ParseHealthProbeMs(raw), defaultMs)
        })
    }

    it('returns 0 (disabled) for zero', () =>
    {
        assert.equal(ControlPlaneServer.ParseHealthProbeMs(DisabledRaw), 0)
    })

    it('returns the integer for a valid non-negative value', () =>
    {
        assert.equal(ControlPlaneServer.ParseHealthProbeMs(ValidRaw), 5000)
    })
})

describe('ControlPlaneServer.ComposeTenantPlane', () =>
{
    const BaseDomain = 'admin.example.com'
    const Port = '7100'
    // The deps below are only stored (not called) while composing, so stubs are safe. `never` is assignable to every param.
    const stub = {} as unknown as never

    const compose = (env: NodeJS.ProcessEnv): ReturnType<typeof ControlPlaneServer.ComposeTenantPlane> =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const registry = new TenantAdminClientRegistry(join(dir, 'tenant-admin-clients.json'))
            return ControlPlaneServer.ComposeTenantPlane(env, dir, stub, stub, false, stub, stub, stub, stub, randomBytes(32), registry, 168)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    it('wires the relying-party with the durable secret path when the tenant env is set', () =>
    {
        const plane = compose({ PRAGMATIC_TENANT_ADMIN_PORT: Port, PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv)
        assert.ok(plane !== undefined)
        // Pins the production wiring: a dropped/reordered `durability` arg would silently revert to the legacy path and flip this false.
        assert.equal(plane.isDurable, true)
    })

    it('returns undefined (fail-closed) when the tenant port env is unset', () =>
    {
        assert.equal(compose({ PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv), undefined)
    })

    it('returns undefined (fail-closed) when the base domain env is unset', () =>
    {
        assert.equal(compose({ PRAGMATIC_TENANT_ADMIN_PORT: Port } as NodeJS.ProcessEnv), undefined)
    })
})
