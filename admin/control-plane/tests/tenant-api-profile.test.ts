import { strict as assert } from 'node:assert'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import { SeededTenantDirectory } from '../tenant-api/seeded-tenant-directory.js'
import { TenantAdminCapabilities } from '../tenant-api/tenant-admin-capabilities.js'
import type { TenantProfileDto } from '../tenant-api/tenant-profile-dto.js'
import { HiveBackend, InfraMode, type HiveRecord, type TenantRecord } from '../platform-records.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

class ResRecorder
{
    public status = 0
    public body = ''

    public setHeader(): void
    {
    }

    public writeHead(status: number): this
    {
        this.status = status
        return this
    }

    public end(body?: string): void
    {
        this.body = body ?? ''
    }
}

class Fx
{
    public static readonly IdpBaseUrl = 'https://idp.example.test'
    public static readonly IdpCaRefSentinel = 'secret-ref://ca-SENTINEL-9f3a'
    public static readonly IdpTokenRefSentinel = 'secret-ref://token-SENTINEL-7c1b'

    public static Tenant(extra: Partial<TenantRecord>): TenantRecord
    {
        return { id: 't1', clientId: 'c1', displayName: 'Tenant One', createdAt: '2026-01-01T00:00:00Z', ...extra }
    }

    public static Hive(): HiveRecord
    {
        return {
            id: 'h1', tenantId: 't1', displayName: 'Hive One', createdAt: '2026-01-01T00:00:00Z',
            cluster: { backend: HiveBackend.Local, infra: InfraMode.Attach }, registry: { host: 'r' }
        } as unknown as HiveRecord
    }

    public static Session(principalId: string, email?: string): TenantSession
    {
        return { id: 'secret-bearer', tenantId: 't1', principalId, email, expiresAt: '2099-01-01T00:00:00Z' }
    }

    public static async Get(tenant: TenantRecord, organisation: string | undefined, session: TenantSession, hives: readonly HiveRecord[] = [Fx.Hive()]): Promise<{ res: ResRecorder; dto: TenantProfileDto }>
    {
        const directory = new SeededTenantDirectory({ tenant, hives, organisation })
        const unused = undefined as never
        const endpoint = new TenantApiEndpoint(unused, directory, unused, unused, unused)
        const res = new ResRecorder()
        const handled = await endpoint.Handle({ method: 'GET' } as unknown as IncomingMessage, res as unknown as ServerResponse, '/tenant-api/profile', session)
        assert.equal(handled, true)
        return { res, dto: JSON.parse(res.body) as TenantProfileDto }
    }
}

describe('GET /tenant-api/profile', () =>
{
    it('returns the owner profile with organisation, hive and no token', async () =>
    {
        const { res, dto } = await Fx.Get(Fx.Tenant({ ownerPrincipalId: 'p1', ownerEmail: 'o@x.io' }), 'Acme', Fx.Session('p1', 'o@x.io'))
        assert.equal(res.status, 200)
        assert.equal(dto.tenant.displayName, 'Tenant One')
        assert.equal(dto.tenant.organisation, 'Acme')
        assert.deepEqual(dto.hive, { id: 'h1', displayName: 'Hive One' })
        assert.equal(dto.roleLabel, TenantAdminCapabilities.OwnerRoleLabel)
        assert.deepEqual(dto.capabilities, { envs: true, adopt: true, access: true, settings: true })
        assert.equal(dto.email, 'o@x.io')
        assert.equal(dto.ownerContact, 'o@x.io')
        assert.equal(res.body.includes('secret-bearer'), false)
    })

    it('omits organisation, email and ownerContact when unknown', async () =>
    {
        const { dto } = await Fx.Get(Fx.Tenant({}), undefined, Fx.Session('p1'))
        assert.equal('organisation' in dto.tenant, false)
        assert.equal('email' in dto, false)
        assert.equal('ownerContact' in dto, false)
    })

    it('returns the environment-admin capabilities for a non-owner', async () =>
    {
        const { dto } = await Fx.Get(Fx.Tenant({ ownerPrincipalId: 'p1', ownerEmail: 'o@x.io' }), undefined, Fx.Session('p2'))
        assert.equal(dto.roleLabel, TenantAdminCapabilities.AdminRoleLabel)
        assert.deepEqual(dto.capabilities, { envs: true, adopt: true, access: false, settings: false })
        assert.equal(dto.ownerContact, 'o@x.io')
    })

    it('omits hive when the tenant has no seeded hive', async () =>
    {
        const { dto } = await Fx.Get(Fx.Tenant({}), undefined, Fx.Session('p1'), [])
        assert.equal('hive' in dto, false)
    })

    it('exposes the IdP base URL and configured flags, never the raw refs', async () =>
    {
        const { res, dto } = await Fx.Get(Fx.Tenant({ idpBaseUrl: Fx.IdpBaseUrl, idpCaRef: Fx.IdpCaRefSentinel, idpAdminTokenRef: Fx.IdpTokenRefSentinel }), undefined, Fx.Session('p1'))
        assert.equal(dto.idp?.baseUrl, Fx.IdpBaseUrl)
        assert.equal(dto.idp?.signingCaConfigured, true)
        assert.equal(dto.idp?.adminTokenConfigured, true)
        assert.equal(res.body.includes(Fx.IdpCaRefSentinel), false)
        assert.equal(res.body.includes(Fx.IdpTokenRefSentinel), false)
        assert.equal(JSON.stringify(dto).includes(Fx.IdpCaRefSentinel), false)
        assert.equal(JSON.stringify(dto).includes(Fx.IdpTokenRefSentinel), false)
    })

    it('omits idp when the tenant has no IdP coordinates', async () =>
    {
        const { dto } = await Fx.Get(Fx.Tenant({}), undefined, Fx.Session('p1'))
        assert.equal(dto.idp, undefined)
        assert.equal('idp' in dto, false)
    })

    it('reports only the base URL with both flags false when no refs are set', async () =>
    {
        const { dto } = await Fx.Get(Fx.Tenant({ idpBaseUrl: Fx.IdpBaseUrl }), undefined, Fx.Session('p1'))
        assert.equal(dto.idp?.baseUrl, Fx.IdpBaseUrl)
        assert.equal(dto.idp?.signingCaConfigured, false)
        assert.equal(dto.idp?.adminTokenConfigured, false)
    })

    it('omits baseUrl but reports flags when only refs are set', async () =>
    {
        const { dto } = await Fx.Get(Fx.Tenant({ idpCaRef: Fx.IdpCaRefSentinel }), undefined, Fx.Session('p1'))
        assert.equal('baseUrl' in (dto.idp ?? {}), false)
        assert.equal(dto.idp?.signingCaConfigured, true)
        assert.equal(dto.idp?.adminTokenConfigured, false)
    })
})
