import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvServerSeedSource, EnvServerSecretSet, SeedTooLargeError } from '../env-server-seed.js'
import type { IKubectl } from '../kubectl.js'

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

class SeedFixture
{
    public static readonly Id = 'contoso-id'
    public static readonly Name = 'acme'
    public static readonly Files: Record<string, string> = {
        'identity/tenant-config.json': '{"SENTINEL-SEED-A":1}',
        'packages/northwind/0.1.0/model.json': '{"SENTINEL-SEED-B":2}',
        'applications/northwind/application.json': '{"SENTINEL-SEED-C":3}',
    }

    public static WriteTree(bundle: string, id: string, files: Record<string, string>): void
    {
        Fixture.Write(bundle)
        for (const [rel, text] of Object.entries(files))
        {
            const full = join(bundle, 'data', id, ...rel.split('/'))
            mkdirSync(join(full, '..'), { recursive: true })
            writeFileSync(full, text)
        }
    }

    public static SeedOf(set: EnvServerSecretSet): Record<string, string>
    {
        const secret = set.RenderManifest().find(o => (o.metadata as { name: string }).name === EnvServerSeedSource.SeedSecretNameOf(SeedFixture.Name))!
        const data = secret.data as Record<string, string>
        assert.deepEqual(Object.keys(data), ['seed.json'])
        return JSON.parse(Buffer.from(data['seed.json'], 'base64').toString('utf8')) as Record<string, string>
    }
}

describe('EnvServerSeedSource seed-tree projection', () =>
{
    it('projects data/<environmentId> as relpath -> base64, id-rooted (not name-rooted)', () =>
    {
        const bundle = mkdtempSync(join(tmpdir(), 'env-seed-tree-'))
        try
        {
            SeedFixture.WriteTree(bundle, SeedFixture.Id, SeedFixture.Files)
            SeedFixture.WriteTree(bundle, SeedFixture.Name, { 'identity/wrong.json': 'WRONG' })
            const set = new EnvServerSeedSource(bundle, SeedFixture.Name, undefined, SeedFixture.Id).SecretSet()
            const seed = SeedFixture.SeedOf(set)
            assert.deepEqual(Object.keys(seed).sort(), Object.keys(SeedFixture.Files).sort())
            for (const [rel, text] of Object.entries(SeedFixture.Files))
            {
                assert.equal(Buffer.from(seed[rel], 'base64').toString('utf8'), text)
            }
        }
        finally
        {
            rmSync(bundle, { recursive: true, force: true })
        }
    })

    it('skips cleanly when data/<environmentId> is absent', () =>
    {
        const bundle = mkdtempSync(join(tmpdir(), 'env-seed-none-'))
        try
        {
            Fixture.Write(bundle)
            const names = new EnvServerSeedSource(bundle, SeedFixture.Name, undefined, SeedFixture.Id).SecretSet().Names()
            assert.ok(!names.includes(EnvServerSeedSource.SeedSecretNameOf(SeedFixture.Name)))
        }
        finally
        {
            rmSync(bundle, { recursive: true, force: true })
        }
    })

    it('yields no seed Secret for an empty environmentId (does not walk data/)', () =>
    {
        const bundle = mkdtempSync(join(tmpdir(), 'env-seed-emptyid-'))
        try
        {
            SeedFixture.WriteTree(bundle, SeedFixture.Id, SeedFixture.Files)
            const names = new EnvServerSeedSource(bundle, SeedFixture.Name, undefined, '').SecretSet().Names()
            assert.ok(!names.includes(EnvServerSeedSource.SeedSecretNameOf(SeedFixture.Name)))
        }
        finally
        {
            rmSync(bundle, { recursive: true, force: true })
        }
    })

    it('yields no seed Secret for an empty data/<id> directory', () =>
    {
        const bundle = mkdtempSync(join(tmpdir(), 'env-seed-emptydir-'))
        try
        {
            Fixture.Write(bundle)
            mkdirSync(join(bundle, 'data', SeedFixture.Id), { recursive: true })
            const names = new EnvServerSeedSource(bundle, SeedFixture.Name, undefined, SeedFixture.Id).SecretSet().Names()
            assert.ok(!names.includes(EnvServerSeedSource.SeedSecretNameOf(SeedFixture.Name)))
        }
        finally
        {
            rmSync(bundle, { recursive: true, force: true })
        }
    })

    it('never leaks seed bytes through toJSON/toString', () =>
    {
        const bundle = mkdtempSync(join(tmpdir(), 'env-seed-redact-'))
        try
        {
            SeedFixture.WriteTree(bundle, SeedFixture.Id, SeedFixture.Files)
            const set = new EnvServerSeedSource(bundle, SeedFixture.Name, undefined, SeedFixture.Id).SecretSet()
            const rendered = set.RenderManifest().find(o => (o.metadata as { name: string }).name === EnvServerSeedSource.SeedSecretNameOf(SeedFixture.Name))!
            const outer = (rendered.data as Record<string, string>)['seed.json']
            assert.ok(outer.length > 0)
            for (const text of [JSON.stringify(set), String(set), `${set}`])
            {
                assert.ok(!text.includes('SENTINEL'))
                assert.ok(!text.includes(outer))
                assert.ok(!text.includes('{"type":"Buffer"'))
            }
        }
        finally
        {
            rmSync(bundle, { recursive: true, force: true })
        }
    })

    it('throws SeedTooLargeError (without seed bytes) over the ceiling', () =>
    {
        const bundle = mkdtempSync(join(tmpdir(), 'env-seed-big-'))
        try
        {
            SeedFixture.WriteTree(bundle, SeedFixture.Id, { 'packages/big.json': 'SENTINEL' + 'x'.repeat(1100000) })
            assert.throws(
                () => new EnvServerSeedSource(bundle, SeedFixture.Name, undefined, SeedFixture.Id).SecretSet(),
                (e: Error) => e instanceof SeedTooLargeError && !e.message.includes('SENTINEL') && e.actualBytes > e.ceilingBytes && e.ceilingBytes === 1048576 && e.name === 'SeedTooLargeError')
        }
        finally
        {
            rmSync(bundle, { recursive: true, force: true })
        }
    })

    it('ApplyBundle includes the seed Secret in the applied List', async () =>
    {
        const bundle = mkdtempSync(join(tmpdir(), 'env-seed-apply-'))
        try
        {
            SeedFixture.WriteTree(bundle, SeedFixture.Id, SeedFixture.Files)
            let applied = ''
            const kubectl = { Apply: async (json: string) => { applied = json } } as unknown as IKubectl
            await EnvServerSeedSource.ApplyBundle(kubectl, bundle, SeedFixture.Name, SeedFixture.Id)
            const items = (JSON.parse(applied) as { items: { kind: string, metadata: { name: string } }[] }).items
            assert.ok(items.some(i => i.kind === 'Secret' && i.metadata.name === EnvServerSeedSource.SeedSecretNameOf(SeedFixture.Name)))
        }
        finally
        {
            rmSync(bundle, { recursive: true, force: true })
        }
    })
})
