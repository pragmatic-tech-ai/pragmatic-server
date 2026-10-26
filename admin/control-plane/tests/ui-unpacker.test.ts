import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { FileKeyStore } from '../key-store.js'
import { OciRegistryClient, type OciFetch } from '../oci-registry-client.js'
import { UiArtifact } from '../ui-artifact.js'
import { UiArtifactSigner, UiArtifactVerifier } from '../ui-artifact-signer.js'
import { UiUnpacker, UiUnpackError, type UiUnpackInput } from '../ui-unpacker.js'

class Fx
{
    public static readonly Repo = 'ui/shop'
    public static readonly Tag = 'v1'
    public static readonly SigTag = 'v1.sig'
    public static readonly App = 'shop'
    public static readonly Version = '1.0.0'
    public static readonly KeyRef = 'trust'
    public static readonly Base = 'http://registry.test'
    public static readonly V2 = '/v2/'
    public static readonly SigMediaType = 'application/vnd.pragmatic.ui.signature.v1'
    public static readonly Encoding = 'utf8'
    public static readonly TempPrefix = 'ui-unpacker-'
    public static readonly IndexHtml = '<html>hi</html>'
    public static readonly AppJs = 'console.log(1)'
    public static readonly ZeroDigest = `sha256:${'0'.repeat(64)}`
    public static readonly ManifestsRe = /^(.*)\/manifests\/(.*)$/
    public static readonly BlobsRe = /^(.*)\/blobs\/(.*)$/
    public static readonly KeysDirName = 'keys'
    public static readonly DataDirName = 'data'
    public static readonly OtherVersion = '9.9.9'
    public static readonly PriorVersion = '0.9.0'
    public static readonly AbsentKeyRef = 'absent'
    public static readonly OctetStream = 'application/octet-stream'
    public static readonly BogusSignature = 'not a real signature'
    public static readonly DataPackage = { id: 'data', version: '2' }
    public static readonly LegacyPackage = { id: 'legacy', version: '1' }
    public static readonly SwappedLayerJson = '{"index.html":"ZXZpbA=="}'
    public static readonly SwappedConfigJson = '{"entry":"x","assets":[]}'
    public static readonly Entry = 'index.html'
    public static readonly EvilPath = '../evil.js'
    public static readonly EvilFile = 'evil.js'
    public static readonly TraversalVersion = '..'
    public static readonly TraversalName = '../x'
    public static readonly LiveFile = 'live'
    public static readonly ManifestFile = 'application.json'
}

/** A canned registry: manifests by `repo:tag`, blobs by digest. */
class FakeRegistry
{
    public readonly manifests = new Map<string, Uint8Array>()
    public readonly blobs = new Map<string, Uint8Array>()

    public Fetch: OciFetch = async (url) =>
    {
        const path = url.slice(Fx.Base.length + Fx.V2.length)
        const m = Fx.ManifestsRe.exec(path)
        const b = Fx.BlobsRe.exec(path)
        const hit = m !== null ? this.manifests.get(`${m[1]}:${m[2]}`) : b !== null ? this.blobs.get(b[2]) : undefined
        return hit === undefined ? new Response(null, { status: 404 }) : new Response(hit as BodyInit, { status: 200 })
    }

    public PutBlob(bytes: Uint8Array): string
    {
        const d = OciRegistryClient.DigestOf(bytes)
        this.blobs.set(d, bytes)
        return d
    }
}

/** Per-test state and helpers for the unpacker tests. */
class Harness
{
    public dir = ''
    public keysDir = ''
    public registry!: FakeRegistry
    public storage!: NodeFsStorage
    public signer!: UiArtifactSigner
    public packed!: ReturnType<typeof UiArtifact.Pack>
    public readonly enc = new TextEncoder()

    public Input(over: Partial<UiUnpackInput> = {}): UiUnpackInput
    {
        return { repo: Fx.Repo, artifactTag: Fx.Tag, sigTag: Fx.SigTag, expectedManifestDigest: this.packed.manifestDigest,
            appName: Fx.App, appVersion: Fx.Version, trustRootRef: Fx.KeyRef, ...over }
    }

    public Unpacker(): UiUnpacker
    {
        return new UiUnpacker(new OciRegistryClient(Fx.Base, this.registry.Fetch), new UiArtifactVerifier(new FileKeyStore(this.keysDir)), this.storage)
    }

    public PublishSignature(signature: string): void
    {
        const layerDigest = this.registry.PutBlob(this.enc.encode(signature))
        const manifest = { schemaVersion: 2, config: { mediaType: Fx.SigMediaType, digest: layerDigest, size: 0 },
            layers: [{ mediaType: Fx.SigMediaType, digest: layerDigest, size: signature.length }] }
        this.registry.manifests.set(`${Fx.Repo}:${Fx.SigTag}`, this.enc.encode(JSON.stringify(manifest)))
    }

    public async Sign(version: string = Fx.Version): Promise<string>
    {
        return this.signer.Sign(Fx.App, version, this.packed.manifestDigest, Fx.KeyRef)
    }

    public async NothingWritten(): Promise<void>
    {
        assert.equal(await this.storage.Exists(`${Fx.App}/${Fx.Version}`), false)
        assert.equal(await this.storage.Exists(`${Fx.App}/${Fx.LiveFile}`), false)
    }

    public async ReadManifest(): Promise<{ packages: unknown }>
    {
        return JSON.parse(await this.storage.ReadText(`${Fx.App}/${Fx.Version}/${Fx.ManifestFile}`))
    }

    public async Setup(): Promise<void>
    {
        this.dir = await mkdtemp(join(tmpdir(), Fx.TempPrefix))
        this.keysDir = join(this.dir, Fx.KeysDirName)
        await mkdir(this.keysDir, { recursive: true })
        const { publicKey, privateKey } = generateKeyPairSync('ed25519')
        await writeFile(join(this.keysDir, `${Fx.KeyRef}${FileKeyStore.PublicSuffix}`), publicKey.export({ type: 'spki', format: 'pem' }), Fx.Encoding)
        await writeFile(join(this.keysDir, `${Fx.KeyRef}${FileKeyStore.PrivateSuffix}`), privateKey.export({ type: 'pkcs8', format: 'pem' }), Fx.Encoding)
        this.signer = new UiArtifactSigner(new FileKeyStore(this.keysDir))
        this.storage = new NodeFsStorage(join(this.dir, Fx.DataDirName))
        this.registry = new FakeRegistry()
        this.packed = UiArtifact.Pack(
            { appName: Fx.App, appVersion: Fx.Version, entry: Fx.Entry, assets: ['app.js'] },
            [{ path: Fx.Entry, bytes: this.enc.encode(Fx.IndexHtml) }, { path: 'assets/app.js', bytes: this.enc.encode(Fx.AppJs) }],
        )
        this.registry.manifests.set(`${Fx.Repo}:${Fx.Tag}`, this.packed.manifestBytes)
        this.registry.PutBlob(this.packed.layerBlob)
        this.registry.PutBlob(this.packed.configBlob)
        this.PublishSignature(await this.Sign())
    }

    public async Teardown(): Promise<void>
    {
        await rm(this.dir, { recursive: true, force: true })
    }
}

describe('UiUnpacker', () =>
{
    const h = new Harness()
    beforeEach(() => h.Setup())
    afterEach(() => h.Teardown())

    it('pulls, verifies, unpacks the version tree and flips the live pointer', async () =>
    {
        await h.Unpacker().Reconcile(h.Input())
        assert.equal(await h.storage.ReadText(`${Fx.App}/${Fx.Version}/ui/index.html`), Fx.IndexHtml)
        assert.equal(await h.storage.ReadText(`${Fx.App}/${Fx.Version}/ui/assets/app.js`), Fx.AppJs)
        assert.deepEqual(await h.ReadManifest(), { name: Fx.App, version: Fx.Version, packages: [], ui: { entry: Fx.Entry, assets: ['app.js'] } })
        assert.equal(await h.storage.ReadText(`${Fx.App}/${Fx.LiveFile}`), Fx.Version)
    })

    it('a manifest whose digest differs from the expected digest aborts and writes nothing', async () =>
    {
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input({ expectedManifestDigest: Fx.ZeroDigest })), UiUnpackError)
        await h.NothingWritten()
    })

    it('a bad signature aborts and writes nothing', async () =>
    {
        h.PublishSignature(Buffer.from(Fx.BogusSignature).toString('base64'))
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input()), UiUnpackError)
        await h.NothingWritten()
    })

    it('a signature over a different appVersion aborts (identity binding)', async () =>
    {
        h.PublishSignature(await h.Sign(Fx.OtherVersion))
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input()), UiUnpackError)
        await h.NothingWritten()
    })

    it('a missing trust key aborts', async () =>
    {
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input({ trustRootRef: Fx.AbsentKeyRef })), UiUnpackError)
        await h.NothingWritten()
    })

    it('an already-unpacked current version is a no-op', async () =>
    {
        await h.Unpacker().Reconcile(h.Input())
        h.registry.manifests.clear()
        await h.Unpacker().Reconcile(h.Input())
        assert.equal(await h.storage.ReadText(`${Fx.App}/${Fx.LiveFile}`), Fx.Version)
    })

    it('carries packages forward from the live manifest', async () =>
    {
        await h.storage.WriteText(`${Fx.App}/0.9.0/${Fx.ManifestFile}`, JSON.stringify({ name: Fx.App, version: Fx.PriorVersion, packages: [Fx.DataPackage] }))
        await h.storage.WriteText(`${Fx.App}/${Fx.LiveFile}`, Fx.PriorVersion)
        await h.Unpacker().Reconcile(h.Input())
        assert.deepEqual((await h.ReadManifest()).packages, [Fx.DataPackage])
        assert.equal(await h.storage.ReadText(`${Fx.App}/${Fx.LiveFile}`), Fx.Version)
    })

    it('carries packages forward from a legacy application.json', async () =>
    {
        await h.storage.WriteText(`${Fx.App}/${Fx.ManifestFile}`, JSON.stringify({ name: Fx.App, version: '0', packages: [Fx.LegacyPackage] }))
        await h.Unpacker().Reconcile(h.Input())
        assert.deepEqual((await h.ReadManifest()).packages, [Fx.LegacyPackage])
    })

    it('a swapped layer blob (manifest signed, bytes different) aborts and writes nothing', async () =>
    {
        const layerDigest = OciRegistryClient.DigestOf(h.packed.layerBlob)
        h.registry.blobs.set(layerDigest, h.enc.encode(Fx.SwappedLayerJson))
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input()), UiUnpackError)
        await h.NothingWritten()
    })

    it('a swapped config blob aborts and writes nothing', async () =>
    {
        h.registry.blobs.set(OciRegistryClient.DigestOf(h.packed.configBlob), h.enc.encode(Fx.SwappedConfigJson))
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input()), UiUnpackError)
        await h.NothingWritten()
    })

    it('a signature layer with the wrong mediaType aborts', async () =>
    {
        const m = JSON.parse(new TextDecoder().decode(h.registry.manifests.get(`${Fx.Repo}:${Fx.SigTag}`)!))
        m.layers[0].mediaType = Fx.OctetStream
        h.registry.manifests.set(`${Fx.Repo}:${Fx.SigTag}`, h.enc.encode(JSON.stringify(m)))
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input()), UiUnpackError)
        await h.NothingWritten()
    })

    it('a layer file path containing .. is rejected and nothing is written', async () =>
    {
        const evil = UiArtifact.Pack(
            { appName: Fx.App, appVersion: Fx.Version, entry: Fx.Entry, assets: [] },
            [{ path: Fx.EvilPath, bytes: h.enc.encode(Fx.AppJs) }],
        )
        h.registry.manifests.set(`${Fx.Repo}:${Fx.Tag}`, evil.manifestBytes)
        h.registry.PutBlob(evil.layerBlob)
        h.registry.PutBlob(evil.configBlob)
        h.PublishSignature(await h.signer.Sign(Fx.App, Fx.Version, evil.manifestDigest, Fx.KeyRef))
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input({ expectedManifestDigest: evil.manifestDigest })), UiUnpackError)
        await h.NothingWritten()
        assert.equal(await h.storage.Exists(Fx.EvilFile), false)
    })

    it('an appVersion with a traversal is rejected and nothing is written', async () =>
    {
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input({ appVersion: Fx.TraversalVersion })), UiUnpackError)
        await assert.rejects(() => h.Unpacker().Reconcile(h.Input({ appName: Fx.TraversalName })), UiUnpackError)
        await h.NothingWritten()
    })
})
