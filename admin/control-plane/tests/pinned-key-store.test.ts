import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ClientRegistry } from '../client-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { KeyStores } from '../key-stores.js'
import { FileKeyStore, type IKeyStore } from '../key-store.js'
import { PinnedKeyStore } from '../pinned-key-store.js'
import { PlatformDirectory } from '../platform-directory.js'
import { PlatformSigningKey } from '../platform-signing-key.js'
import { TenantRegistry } from '../tenant-registry.js'
import { ControlPlaneServer } from '../server.js'

class PinnedFixture
{
    public static readonly FileEnvVar = 'PRAGMATIC_ADMIN_SIGNING_KEY_FILE'
    public static readonly Ref = 'platform-signing'
    public static readonly Root = mkdtempSync(join(tmpdir(), 'pinned-key-'))

    public static Ed25519(): { privatePem: string, publicPem: string }
    {
        const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
        return { privatePem: pair.privateKey, publicPem: pair.publicKey }
    }

    public static File(content: string): string
    {
        const path = join(mkdtempSync(join(PinnedFixture.Root, 'f-')), 'signing.key')
        writeFileSync(path, content, { mode: 0o600 })
        return path
    }

    public static DataRoot(): string
    {
        const dataRoot = mkdtempSync(join(PinnedFixture.Root, 'data-'))
        mkdirSync(join(dataRoot, 'keys'), { recursive: true })
        return dataRoot
    }
}

class RecordingInner implements IKeyStore
{
    public readonly Asked: string[] = []

    public async PublicKey(ref: string): Promise<string>
    {
        this.Asked.push('pub:' + ref)
        return 'inner-pub'
    }

    public async PrivateKey(ref: string): Promise<string>
    {
        this.Asked.push('key:' + ref)
        return 'inner-key'
    }
}

after(() => rmSync(PinnedFixture.Root, { recursive: true, force: true }))

describe('PinnedKeyStore', () =>
{
    it('serves the pinned private key and its SPKI public key in the .pub format PlatformSigningKey writes', async () =>
    {
        const { privatePem } = PinnedFixture.Ed25519()
        const store = new PinnedKeyStore(PinnedFixture.Ref, privatePem, new RecordingInner())
        assert.equal(await store.PrivateKey(PinnedFixture.Ref), privatePem)
        const keysDir = join(PinnedFixture.DataRoot(), 'keys')
        writeFileSync(join(keysDir, PinnedFixture.Ref + FileKeyStore.PrivateSuffix), privatePem, { mode: 0o600 })
        await PlatformSigningKey.Ensure(keysDir, PinnedFixture.Ref)
        assert.equal(await store.PublicKey(PinnedFixture.Ref), readFileSync(join(keysDir, PinnedFixture.Ref + FileKeyStore.PublicSuffix), 'utf8'))
    })

    it('delegates every other ref', async () =>
    {
        const inner = new RecordingInner()
        const store = new PinnedKeyStore(PinnedFixture.Ref, PinnedFixture.Ed25519().privatePem, inner)
        assert.equal(await store.PublicKey('other'), 'inner-pub')
        assert.equal(await store.PrivateKey('other'), 'inner-key')
        assert.deepEqual(inner.Asked, ['pub:other', 'key:other'])
    })
})

describe('KeyStores.Of', () =>
{
    it('is the data root key store when no signing key file is set', async () =>
    {
        assert.ok(KeyStores.Of(PinnedFixture.DataRoot(), {}) instanceof FileKeyStore)
    })

    it('pins the file\'s key under the configured ref', async () =>
    {
        const { privatePem } = PinnedFixture.Ed25519()
        const store = KeyStores.Of(PinnedFixture.DataRoot(), { [PinnedFixture.FileEnvVar]: PinnedFixture.File(privatePem) })
        assert.equal(await store.PrivateKey(PinnedFixture.Ref), privatePem)
    })

    it('refuses an RSA key or garbage, naming the setting and never the content', () =>
    {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
        for (const content of [rsa, 'GARBAGE-SECRET-MATERIAL'])
        {
            assert.throws(() => KeyStores.Of(PinnedFixture.DataRoot(), { [PinnedFixture.FileEnvVar]: PinnedFixture.File(content) }), (e: Error) =>
            {
                assert.match(e.message, /PRAGMATIC_ADMIN_SIGNING_KEY_FILE/)
                assert.ok(!e.message.includes('GARBAGE-SECRET-MATERIAL'))
                assert.ok(!e.message.includes('PRIVATE KEY'))
                return true
            })
        }
    })

    it('refuses a missing file, naming the setting', () =>
    {
        assert.throws(() => KeyStores.Of(PinnedFixture.DataRoot(), { [PinnedFixture.FileEnvVar]: join(PinnedFixture.Root, 'nope.key') }), /PRAGMATIC_ADMIN_SIGNING_KEY_FILE/)
    })
})

describe('PlatformSigningOf with a signing key file', () =>
{
    it('writes no private key into the data root, publishes the file\'s public key and makes it the trust root', async () =>
    {
        const { privatePem, publicPem } = PinnedFixture.Ed25519()
        const dataRoot = PinnedFixture.DataRoot()
        const env = { [PinnedFixture.FileEnvVar]: PinnedFixture.File(privatePem) }
        const directory = new PlatformDirectory(new ClientRegistry(join(dataRoot, 'clients.json')), new TenantRegistry(join(dataRoot, 'tenants.json')), new HiveRegistry(join(dataRoot, 'hives.json')), { List: () => [] })
        await directory.Load()
        await ControlPlaneServer.PlatformSigningOf(env, dataRoot, directory)
        assert.equal(existsSync(join(dataRoot, 'keys', PinnedFixture.Ref + FileKeyStore.PrivateSuffix)), false)
        assert.equal(readFileSync(join(dataRoot, 'keys', PinnedFixture.Ref + FileKeyStore.PublicSuffix), 'utf8'), publicPem)
    })
})
