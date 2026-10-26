import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InjectedIdpService } from '../injected-idp-service.js'

class Names
{
    public static readonly Browser = 'https://idp-acme.tenants.test'
    public static readonly Internal = 'https://idp.svc:8443'
    public static readonly Ca = 'CA-PEM'
    public static readonly Token = 'tok-123'
}

describe('InjectedIdpService', () =>
{
    let dir = ''
    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'injidp-'))
        writeFileSync(join(dir, 'ca.crt'), Names.Ca)
        writeFileSync(join(dir, 'admin-token'), Names.Token + '\n')
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('returns a connection assembled from injected config and mounted files', async () =>
    {
        const svc = new InjectedIdpService({ browserBaseUrl: Names.Browser, baseUrl: Names.Internal, caFile: join(dir, 'ca.crt'), adminTokenFile: join(dir, 'admin-token') })
        const conn = await svc.EnsureForTenant('acme', 'Acme')
        assert.equal(conn.browserBaseUrl, Names.Browser)
        assert.equal(conn.baseUrl, Names.Internal)
        assert.equal(conn.ca.toString(), Names.Ca)
        assert.equal(conn.adminToken, Names.Token)
    })

    it('FromEnv is undefined without the issuer var and built when present', () =>
    {
        assert.equal(InjectedIdpService.FromEnv({}), undefined)
        const svc = InjectedIdpService.FromEnv({
            PRAGMATIC_IDP_BROWSER_BASE_URL: Names.Browser, PRAGMATIC_IDP_BASE_URL: Names.Internal,
            PRAGMATIC_IDP_CA_FILE: join(dir, 'ca.crt'), PRAGMATIC_IDP_ADMIN_TOKEN_FILE: join(dir, 'admin-token'),
        })
        assert.ok(svc instanceof InjectedIdpService)
    })

    it('does not leak file contents in errors', async () =>
    {
        const svc = new InjectedIdpService({ browserBaseUrl: Names.Browser, baseUrl: Names.Internal, caFile: join(dir, 'ca.crt'), adminTokenFile: join(dir, 'missing') })
        await assert.rejects(() => svc.EnsureForTenant('acme', 'Acme'), (e: Error) => !e.message.includes(Names.Token) && !e.message.includes(Names.Ca))
    })
})
