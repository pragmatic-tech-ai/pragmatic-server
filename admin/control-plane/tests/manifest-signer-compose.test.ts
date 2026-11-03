import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ClientRegistry } from '../client-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { TenantRegistry } from '../tenant-registry.js'
import { ImageSigner } from '../image-signer.js'
import { ManifestSigner } from '../manifest-signer.js'
import { PlatformSigningKey, PlatformSigningKeyMissingError } from '../platform-signing-key.js'
import { ControlPlaneServer } from '../server.js'

class SignerComposeFixture
{
    public static readonly KeyRefEnvVar = 'PRAGMATIC_ADMIN_SIGNING_KEY_REF'

    // A directory with one hive that has no trust root, in its own data root.
    public static async Directory(dataRoot: string): Promise<PlatformDirectory>
    {
        const directory = new PlatformDirectory(new ClientRegistry(join(dataRoot, 'clients.json')), new TenantRegistry(join(dataRoot, 'tenants.json')), new HiveRegistry(join(dataRoot, 'hives.json')), { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await directory.CreateTenant({ id: 't1', clientId: 'c1', displayName: 'T1' })
        await directory.CreateHive({ id: 'h1', tenantId: 't1', displayName: 'H1', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach } })
        return directory
    }
}

describe('ControlPlaneServer signing composition', () =>
{
    const root = mkdtempSync(join(tmpdir(), 'signer-compose-'))

    after(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('uses the generated platform key when no signing key ref is configured, or it is blank', () =>
    {
        assert.equal(ControlPlaneServer.SigningKeyRefOf({}), PlatformSigningKey.DefaultRef)
        assert.equal(ControlPlaneServer.SigningKeyRefOf({ [SignerComposeFixture.KeyRefEnvVar]: '' }), PlatformSigningKey.DefaultRef)
        assert.equal(ControlPlaneServer.SigningKeyRefOf({ [SignerComposeFixture.KeyRefEnvVar]: '   ' }), PlatformSigningKey.DefaultRef)
    })

    it('uses an operator-named signing key ref, trimmed, when configured', () =>
    {
        assert.equal(ControlPlaneServer.SigningKeyRefOf({ [SignerComposeFixture.KeyRefEnvVar]: ' platform-release ' }), 'platform-release')
    })

    it('PlatformSigningOf generates the platform key, makes it the trust root of a hive without one, and signs with it', async () =>
    {
        const dataRoot = join(root, 'default')
        mkdirSync(dataRoot)
        const directory = await SignerComposeFixture.Directory(dataRoot)
        const signing = await ControlPlaneServer.PlatformSigningOf({}, dataRoot, directory)
        assert.ok(existsSync(join(dataRoot, 'keys', 'platform-signing.key')))
        assert.equal(directory.GetHive('h1')?.trustRootRef, 'platform-signing')
        assert.equal(signing.PlatformSigner.KeyRef, 'platform-signing')
        assert.equal(signing.PlatformSigner.SignsFor(directory.GetHive('h1')!), true)
        assert.ok(signing.ImageSigner instanceof ImageSigner)
        const again = readFileSync(join(dataRoot, 'keys', 'platform-signing.key'), 'utf8')
        await ControlPlaneServer.PlatformSigningOf({}, dataRoot, directory)
        assert.equal(readFileSync(join(dataRoot, 'keys', 'platform-signing.key'), 'utf8'), again)
    })

    it('PlatformSigningOf refuses to start on an operator-named key that is not in the key store, and changes no hive', async () =>
    {
        const dataRoot = join(root, 'operator')
        mkdirSync(dataRoot)
        const directory = await SignerComposeFixture.Directory(dataRoot)
        await assert.rejects(ControlPlaneServer.PlatformSigningOf({ [SignerComposeFixture.KeyRefEnvVar]: 'typo-key' }, dataRoot, directory), PlatformSigningKeyMissingError)
        assert.equal(directory.GetHive('h1')?.trustRootRef, undefined)
        assert.equal(existsSync(join(dataRoot, 'keys', 'typo-key.key')), false)
    })

    it('always composes a ManifestSigner over the shared image signer', () =>
    {
        const signer = ControlPlaneServer.ManifestSignerOf('platform-release', root, ControlPlaneServer.ImageSignerOf(root))
        assert.ok(signer instanceof ManifestSigner)
        assert.ok(ControlPlaneServer.ImageSignerOf(root) instanceof ImageSigner)
    })
})
