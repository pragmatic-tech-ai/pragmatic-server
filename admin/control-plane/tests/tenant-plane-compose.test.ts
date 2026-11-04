import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneServer } from '../server.js'
import { TenantAdminClientRegistry } from '../tenant-auth/tenant-admin-client-record.js'
import { DesktopRelay } from '../tenant-auth/desktop-relay.js'

describe('ControlPlaneServer.ExternalPortWarning', () =>
{
    it('warns once when the tenant listener is not on 80/443 and no external port is set', () =>
    {
        assert.match(ControlPlaneServer.ExternalPortWarning(7002, undefined) ?? '', /PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT/)
        assert.match(ControlPlaneServer.ExternalPortWarning(7002, undefined) ?? '', /without a proxy/)
    })

    it('is silent on 80 / 443 or when an external port is set', () =>
    {
        assert.equal(ControlPlaneServer.ExternalPortWarning(443, undefined), undefined)
        assert.equal(ControlPlaneServer.ExternalPortWarning(80, undefined), undefined)
        assert.equal(ControlPlaneServer.ExternalPortWarning(7002, 7002), undefined)
        assert.equal(ControlPlaneServer.ExternalPortWarning(7002, 443), undefined)
    })
})

describe('ControlPlaneServer.TenantExternalPort', () =>
{
    it('is undefined when unset or blank (no port in the tenant origin, unchanged)', () =>
    {
        assert.equal(ControlPlaneServer.TenantExternalPort(undefined), undefined)
        assert.equal(ControlPlaneServer.TenantExternalPort(''), undefined)
    })

    it('returns a valid port', () =>
    {
        assert.equal(ControlPlaneServer.TenantExternalPort('7002'), 7002)
        assert.equal(ControlPlaneServer.TenantExternalPort('1'), 1)
        assert.equal(ControlPlaneServer.TenantExternalPort('65535'), 65535)
    })

    for (const bad of ['abc', '0', '70000', '1.5', '-1'])
    {
        it(`throws naming the variable for ${bad}`, () =>
        {
            assert.throws(() => ControlPlaneServer.TenantExternalPort(bad), /PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT/)
        })
    }
})

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
    const DefaultMs = 30000
    const DisabledRaw = '0'
    const ValidRaw = '5000'
    const ValidMs = 5000
    const MinBoundaryRaw = '1000'
    const MinBoundaryMs = 1000
    const TooLargeRaw = '99999999999'
    const BelowMinRaw = '007'

    for (const raw of [undefined, '', '-5', 'abc', '1.5', TooLargeRaw, BelowMinRaw])
    {
        it(`falls back to the default for ${JSON.stringify(raw)}`, () =>
        {
            assert.equal(ControlPlaneServer.ParseHealthProbeMs(raw), DefaultMs)
        })
    }

    it('returns 0 (disabled) for zero', () =>
    {
        assert.equal(ControlPlaneServer.ParseHealthProbeMs(DisabledRaw), 0)
    })

    it('returns the integer for a valid in-range value', () =>
    {
        assert.equal(ControlPlaneServer.ParseHealthProbeMs(ValidRaw), ValidMs)
    })

    it('accepts the minimum boundary', () =>
    {
        assert.equal(ControlPlaneServer.ParseHealthProbeMs(MinBoundaryRaw), MinBoundaryMs)
    })
})

describe('ControlPlaneServer.ParseHealthProbeTimeoutMs', () =>
{
    const DefaultMs = 60000
    const DisabledRaw = '0'
    const ValidRaw = '5000'
    const ValidMs = 5000
    const MinBoundaryRaw = '1000'
    const MinBoundaryMs = 1000
    const TooLargeRaw = '99999999999'
    const BelowMinRaw = '007'

    for (const raw of [undefined, '', '-5', 'abc', '1.5', TooLargeRaw, BelowMinRaw])
    {
        it(`falls back to the default for ${JSON.stringify(raw)}`, () =>
        {
            assert.equal(ControlPlaneServer.ParseHealthProbeTimeoutMs(raw), DefaultMs)
        })
    }

    it('returns 0 (disabled) for zero', () =>
    {
        assert.equal(ControlPlaneServer.ParseHealthProbeTimeoutMs(DisabledRaw), 0)
    })

    it('returns the integer for a valid in-range value', () =>
    {
        assert.equal(ControlPlaneServer.ParseHealthProbeTimeoutMs(ValidRaw), ValidMs)
    })

    it('accepts the minimum boundary', () =>
    {
        assert.equal(ControlPlaneServer.ParseHealthProbeTimeoutMs(MinBoundaryRaw), MinBoundaryMs)
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

    it('mounts the desktop surface on the control plane tenant plane, and not on a default BuildTenantPlane', () =>
    {
        const plane = compose({ PRAGMATIC_TENANT_ADMIN_PORT: Port, PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv)
        assert.ok(plane?.desktop !== undefined)
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const registry = new TenantAdminClientRegistry(join(dir, 'tenant-admin-clients.json'))
            const standalone = ControlPlaneServer.BuildTenantPlane(dir, stub, stub, false, stub, stub, stub, stub, randomBytes(32), registry, 168)
            assert.equal(standalone.desktop, undefined)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('mounts the desktop relay only when the relay wiring is supplied', () =>
    {
        const env = { PRAGMATIC_TENANT_ADMIN_PORT: Port, PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv
        assert.equal(compose(env)?.relay, undefined)
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const registry = new TenantAdminClientRegistry(join(dir, 'tenant-admin-clients.json'))
            const wired = ControlPlaneServer.ComposeTenantPlane(env, dir, stub, stub, false, stub, stub, stub, stub, randomBytes(32), registry, 168,
                undefined, undefined, { endpoints: stub, audit: stub })
            assert.ok(wired?.relay instanceof DesktopRelay)
            // Sign-out closes the session's relays: the desktop endpoint holds the same relay as its connections.
            assert.equal((wired?.desktop as unknown as { connections: unknown }).connections, wired?.relay)
            assert.equal(ControlPlaneServer.DesktopAuditFile, 'tenant-desktop-audit.json')
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
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
