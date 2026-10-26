import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvServerSeedSource, EnvServerSecretSet } from '../env-server-seed.js'

class Fixture
{
    public static readonly Env = 'acme'
    public static readonly DbRef = 'env-1/main/password'
    public static readonly DbPassword = 'SENTINEL-DB-PW-9f3a'
    public static readonly AdminPw = 'SENTINEL-ADMIN-PW-77'
    public static readonly MasterKey = Buffer.from('SENTINEL-MASTER-KEY-BYTES-0123456789')
    public static readonly Tenants = '[{"id":"env-1","purpose":"1"}]'

    public static Write(dir: string): void
    {
        writeFileSync(join(dir, 'master.key'), Fixture.MasterKey)
        writeFileSync(join(dir, 'provisioned-secrets.json'), JSON.stringify({ 'env-1-admin-pw': Fixture.AdminPw, [Fixture.DbRef]: Fixture.DbPassword }))
        writeFileSync(join(dir, 'tenants.json'), Fixture.Tenants)
    }
}

describe('EnvServerSeedSource', () =>
{
    let dir = ''
    before(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'env-seed-test-'))
        Fixture.Write(dir)
    })
    after(() => rmSync(dir, { recursive: true, force: true }))

    it('redacts toJSON/toString of the secret set and the source', () =>
    {
        const source = new EnvServerSeedSource(dir, Fixture.Env, Fixture.DbRef)
        const set: EnvServerSecretSet = source.SecretSet()
        for (const text of [JSON.stringify(set), String(set), `${set}`, JSON.stringify(source), String(source)])
        {
            assert.ok(!text.includes('SENTINEL'))
            assert.ok(text.includes('redacted'))
        }
    })

    it('renders Secrets whose data base64-decodes to the bundle bytes', () =>
    {
        const objs = new EnvServerSeedSource(dir, Fixture.Env, Fixture.DbRef).SecretSet().RenderManifest()
        const main = objs.find(o => (o.metadata as { name: string }).name === EnvServerSeedSource.SecretNameOf(Fixture.Env))!
        assert.equal(main.kind, 'Secret')
        assert.equal(main.type, 'Opaque')
        const data = main.data as Record<string, string>
        assert.deepEqual(Buffer.from(data['master.key'], 'base64'), Fixture.MasterKey)
        const prov = JSON.parse(Buffer.from(data['provisioned-secrets.json'], 'base64').toString('utf8'))
        assert.equal(prov[Fixture.DbRef], Fixture.DbPassword)
    })

    it('renders the postgres Secret named by the db ref with the same password', () =>
    {
        const objs = new EnvServerSeedSource(dir, Fixture.Env, Fixture.DbRef).SecretSet().RenderManifest()
        const pg = objs.find(o => (o.metadata as { name: string }).name === Fixture.DbRef)!
        assert.equal(pg.kind, 'Secret')
        assert.equal(Buffer.from((pg.data as Record<string, string>)['password'], 'base64').toString('utf8'), Fixture.DbPassword)
    })

    it('omits the postgres Secret when no db ref is given', () =>
    {
        const objs = new EnvServerSeedSource(dir, Fixture.Env).SecretSet().RenderManifest()
        assert.equal(objs.length, 1)
    })

    it('ConfigMap carries tenants.json as plain data', () =>
    {
        const cm = new EnvServerSeedSource(dir, Fixture.Env, Fixture.DbRef).ConfigMapManifest()
        assert.equal(cm.kind, 'ConfigMap')
        assert.equal((cm.data as Record<string, string>)['tenants.json'], Fixture.Tenants)
        assert.ok(!JSON.stringify(cm).includes('SENTINEL'))
    })

    it('two sources over the same bundle render identical Secrets', () =>
    {
        const a = JSON.stringify(new EnvServerSeedSource(dir, Fixture.Env, Fixture.DbRef).SecretSet().RenderManifest())
        const b = JSON.stringify(new EnvServerSeedSource(dir, Fixture.Env, Fixture.DbRef).SecretSet().RenderManifest())
        assert.equal(a, b)
    })

    it('defensively copies buffers passed to Add', () =>
    {
        const set = new EnvServerSecretSet('ns')
        const buf = Buffer.from('abc')
        set.Add('s', new Map([['k', buf]]))
        buf.fill(0)
        const data = set.RenderManifest()[0].data as Record<string, string>
        assert.equal(Buffer.from(data['k'], 'base64').toString(), 'abc')
    })

    it('does not leak secret bytes in a missing-ref error', () =>
    {
        assert.throws(() => new EnvServerSeedSource(dir, Fixture.Env, 'nope/ref').SecretSet(), (e: Error) => !e.message.includes('SENTINEL'))
    })
})
