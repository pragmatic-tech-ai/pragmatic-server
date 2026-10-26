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

describe('UiUnpacker', () =>
{
    let dir: string
    let keysDir: string
    let registry: FakeRegistry
    let storage: NodeFsStorage
    let signer: UiArtifactSigner
    let packed: ReturnType<typeof UiArtifact.Pack>

    const enc = new TextEncoder()

    function Input(over: Partial<UiUnpackInput> = {}): UiUnpackInput
    {
        return { repo: Fx.Repo, artifactTag: Fx.Tag, sigTag: Fx.SigTag, expectedManifestDigest: packed.manifestDigest,
            appName: Fx.App, appVersion: Fx.Version, trustRootRef: Fx.KeyRef, ...over }
    }

    function Unpacker(): UiUnpacker
    {
        return new UiUnpacker(new OciRegistryClient(Fx.Base, registry.Fetch), new UiArtifactVerifier(new FileKeyStore(keysDir)), storage)
    }

    function PublishSignature(signature: string): void
    {
        const layerDigest = registry.PutBlob(enc.encode(signature))
        const manifest = { schemaVersion: 2, config: { mediaType: Fx.SigMediaType, digest: layerDigest, size: 0 },
            layers: [{ mediaType: Fx.SigMediaType, digest: layerDigest, size: signature.length }] }
        registry.manifests.set(`${Fx.Repo}:${Fx.SigTag}`, enc.encode(JSON.stringify(manifest)))
    }

    async function Sign(version: string = Fx.Version): Promise<string>
    {
        return signer.Sign(Fx.App, version, packed.manifestDigest, Fx.KeyRef)
    }

    async function NothingWritten(): Promise<void>
    {
        assert.equal(await storage.Exists(`${Fx.App}/${Fx.Version}`), false)
        assert.equal(await storage.Exists(`${Fx.App}/live`), false)
    }

    async function ReadManifest(): Promise<{ packages: unknown }>
    {
        return JSON.parse(await storage.ReadText(`${Fx.App}/${Fx.Version}/application.json`))
    }

    beforeEach(async () =>
    {
        dir = await mkdtemp(join(tmpdir(), Fx.TempPrefix))
        keysDir = join(dir, 'keys')
        await mkdir(keysDir, { recursive: true })
        const { publicKey, privateKey } = generateKeyPairSync('ed25519')
        await writeFile(join(keysDir, `${Fx.KeyRef}${FileKeyStore.PublicSuffix}`), publicKey.export({ type: 'spki', format: 'pem' }), Fx.Encoding)
        await writeFile(join(keysDir, `${Fx.KeyRef}${FileKeyStore.PrivateSuffix}`), privateKey.export({ type: 'pkcs8', format: 'pem' }), Fx.Encoding)
        signer = new UiArtifactSigner(new FileKeyStore(keysDir))
        storage = new NodeFsStorage(join(dir, 'data'))
        registry = new FakeRegistry()
        packed = UiArtifact.Pack(
            { appName: Fx.App, appVersion: Fx.Version, entry: 'index.html', assets: ['app.js'] },
            [{ path: 'index.html', bytes: enc.encode(Fx.IndexHtml) }, { path: 'assets/app.js', bytes: enc.encode(Fx.AppJs) }],
        )
        registry.manifests.set(`${Fx.Repo}:${Fx.Tag}`, packed.manifestBytes)
        registry.PutBlob(packed.layerBlob)
        registry.PutBlob(packed.configBlob)
        PublishSignature(await Sign())
    })

    afterEach(async () =>
    {
        await rm(dir, { recursive: true, force: true })
    })

    it('pulls, verifies, unpacks the version tree and flips the live pointer', async () =>
    {
        await Unpacker().Reconcile(Input())
        assert.equal(await storage.ReadText(`${Fx.App}/${Fx.Version}/ui/index.html`), Fx.IndexHtml)
        assert.equal(await storage.ReadText(`${Fx.App}/${Fx.Version}/ui/assets/app.js`), Fx.AppJs)
        assert.deepEqual(await ReadManifest(), { name: Fx.App, version: Fx.Version, packages: [], ui: { entry: 'index.html', assets: ['app.js'] } })
        assert.equal(await storage.ReadText(`${Fx.App}/live`), Fx.Version)
    })

    it('a manifest whose digest differs from the expected digest aborts and writes nothing', async () =>
    {
        await assert.rejects(() => Unpacker().Reconcile(Input({ expectedManifestDigest: Fx.ZeroDigest })), UiUnpackError)
        await NothingWritten()
    })

    it('a bad signature aborts and writes nothing', async () =>
    {
        PublishSignature(Buffer.from('not a real signature').toString('base64'))
        await assert.rejects(() => Unpacker().Reconcile(Input()), UiUnpackError)
        await NothingWritten()
    })

    it('a signature over a different appVersion aborts (identity binding)', async () =>
    {
        PublishSignature(await Sign('9.9.9'))
        await assert.rejects(() => Unpacker().Reconcile(Input()), UiUnpackError)
        await NothingWritten()
    })

    it('a missing trust key aborts', async () =>
    {
        await assert.rejects(() => Unpacker().Reconcile(Input({ trustRootRef: 'absent' })), UiUnpackError)
        await NothingWritten()
    })

    it('an already-unpacked current version is a no-op', async () =>
    {
        await Unpacker().Reconcile(Input())
        registry.manifests.clear()
        await Unpacker().Reconcile(Input())
        assert.equal(await storage.ReadText(`${Fx.App}/live`), Fx.Version)
    })

    it('carries packages forward from the live manifest', async () =>
    {
        await storage.WriteText(`${Fx.App}/0.9.0/application.json`, JSON.stringify({ name: Fx.App, version: '0.9.0', packages: [{ id: 'data', version: '2' }] }))
        await storage.WriteText(`${Fx.App}/live`, '0.9.0')
        await Unpacker().Reconcile(Input())
        assert.deepEqual((await ReadManifest()).packages, [{ id: 'data', version: '2' }])
        assert.equal(await storage.ReadText(`${Fx.App}/live`), Fx.Version)
    })

    it('carries packages forward from a legacy application.json', async () =>
    {
        await storage.WriteText(`${Fx.App}/application.json`, JSON.stringify({ name: Fx.App, version: '0', packages: [{ id: 'legacy', version: '1' }] }))
        await Unpacker().Reconcile(Input())
        assert.deepEqual((await ReadManifest()).packages, [{ id: 'legacy', version: '1' }])
    })
})
