import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OciRegistryClient } from '../../oci-registry-client.js'
import type { OciFetch } from '../../oci-registry-client.js'
import { FakeOciRegistry } from '../../tests/fake-oci-registry.js'
import { RolloutFixture } from '../../tests/rollout-fixture.js'
import type { PlatformDeploymentRegistry } from '../../platform-deployment-registry.js'
import type { PlatformDirectory } from '../../platform-directory.js'
import type { HiveOrchestratorFactory } from '../../hive-orchestrator-factory.js'
import { ReleaseState } from '../../manifest-record.js'
import { Channel } from '../../channel.js'
import { ReleaseRegistryUnavailableError } from '../../rollout-errors.js'
import { ReleaseCatalog } from '../release-catalog.js'
import { ReleaseDescriptorCodec, type ReleaseDescriptor } from '../release-descriptor.js'
import { ReleasePublisher } from '../release-publisher.js'
import { ReleaseSignature } from '../release-signature.js'
import { ReleaseApp, ReleaseApps, ReleaseTag } from '../release-tag.js'
import { ReleaseTrustKeys } from '../release-trust-keys.js'

class SigningKey
{
    public readonly Private: string
    public readonly Public: string

    public constructor(public readonly Id: string)
    {
        const pair = generateKeyPairSync('ed25519')
        this.Private = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        this.Public = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }
}

class CatalogFixture
{
    public static readonly Namespace = 'pragmatic-tech-ai'
    public static readonly V1 = '1.4.0'
    public static readonly V2 = '1.5.0'
    public static readonly Unseeded = '9.9.9'
    public static readonly Early = '1.6.0-early.2'
    public static readonly TrustedId = 'release-2026'
    public static readonly RogueId = 'rogue-key'
    public static readonly ServerCommit = 'a'.repeat(40)
    public static readonly SiblingCommit = 'b'.repeat(40)
    public static readonly SiblingRepo = 'todl'
    public static readonly ManifestType = 'application/vnd.oci.image.manifest.v1+json'
    public static readonly BuiltAt = '2026-11-12T10:00:00.000Z'
    public static readonly User = 'release-reader'
    public static readonly Token = 'ghp_catalog_secret_token'
    public static readonly WrongToken = 'ghp_wrong_secret_token'
    public static readonly ImageHost = 'ghcr.io/'
    public static readonly DigestSeparator = '@'
    public static readonly KeyFileSuffix = '.pub.pem'
    public static readonly ImageContentPrefix = 'image '
    public static readonly ContentSeparator = ' '
    public static readonly PathSeparator = '/'
    public static readonly TempPrefix = 'release-catalog-'
    public static readonly KeysDir = 'keys'
    public static readonly LocalImage = 'registry/pragmatic-server:1.4.0'
    public static readonly RegistryText = 'registry-supplied text'
    public static readonly SomeDigest = 'sha256:' + 'a'.repeat(64)
    public static readonly BadManifest = 'descriptor artifact invalid: not a single-layer manifest'
    public static readonly LayerMismatch = 'descriptor artifact invalid: layer bytes do not match the manifest digest'
    public static readonly BadAnnotations = 'descriptor artifact invalid: manifest annotations are not strings'
    public static readonly OtherHost = 'registry.example:5000'
    public static readonly Rebuilt = 'rebuilt'
    public static readonly Unreachable = 'connect ECONNREFUSED '

    public readonly Registry = new FakeOciRegistry()
    public readonly Rogue = new SigningKey(CatalogFixture.RogueId)
    /** When set, the catalogue's fetch throws for any URL containing it (simulating a registry that drops mid-refresh). */
    public FailOn: string | undefined
    /** When set, awaited before every catalogue request (to change platform state while a refresh is in flight). */
    public BeforeRequest: ((url: string) => Promise<void>) | undefined

    private constructor(public readonly Deployments: PlatformDeploymentRegistry, public readonly Trusted: SigningKey, private readonly trust: ReleaseTrustKeys)
    {
    }

    /** Trusts exactly one key (written as `<id>.pub.pem`) over a real deployment registry in a temp directory. */
    public static async Run(body: (fx: CatalogFixture) => Promise<void>): Promise<void>
    {
        const S = CatalogFixture
        const dir = await mkdtemp(join(tmpdir(), S.TempPrefix))
        try
        {
            const keysDir = join(dir, S.KeysDir)
            const trusted = new SigningKey(S.TrustedId)
            await mkdir(keysDir)
            await writeFile(join(keysDir, trusted.Id + S.KeyFileSuffix), trusted.Public)
            const directory = { GetHive: () => undefined, List: () => [] } as unknown as PlatformDirectory
            const deployments = await RolloutFixture.Create(dir, directory, {} as HiveOrchestratorFactory)
            await body(new CatalogFixture(deployments, trusted, ReleaseTrustKeys.FromDirectory(keysDir)))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static Repo(app: string): string
    {
        return CatalogFixture.Namespace + CatalogFixture.PathSeparator + app
    }

    public static DescriptorRepo(): string
    {
        return CatalogFixture.Repo(ReleasePublisher.DescriptorRepository)
    }

    public static ImageBytes(app: string, version: string): Uint8Array
    {
        return new TextEncoder().encode(CatalogFixture.ImageContentPrefix + app + CatalogFixture.ContentSeparator + version)
    }

    public Client(credential?: { username: string; token: string }): OciRegistryClient
    {
        const inner = this.Registry.Fetch
        const fetchFn: OciFetch = async (url, init) =>
        {
            if (this.FailOn !== undefined && url.includes(this.FailOn))
            {
                throw new Error(CatalogFixture.Unreachable + CatalogFixture.Token)
            }
            await this.BeforeRequest?.(url)
            return inner(url, init)
        }
        return new OciRegistryClient(this.Registry.Origin, fetchFn, credential)
    }

    public Catalog(credential?: { username: string; token: string }, imageHost?: string): ReleaseCatalog
    {
        return new ReleaseCatalog(this.Client(credential), CatalogFixture.Namespace, this.trust, this.Deployments, imageHost)
    }

    public SeedImages(version: string): void
    {
        for (const app of ReleaseApps.All)
        {
            this.Registry.PutManifest(CatalogFixture.Repo(app), version, CatalogFixture.ImageBytes(app, version), CatalogFixture.ManifestType)
        }
    }

    /** Publishes through the real ReleasePublisher, so the catalogue reads exactly what the release workflow writes. */
    public async Publish(version: string, key: SigningKey = this.Trusted): Promise<{ descriptor: ReleaseDescriptor; descriptorDigest: string }>
    {
        this.SeedImages(version)
        const publisher = new ReleasePublisher(this.Client(), CatalogFixture.Namespace, () => new Date(CatalogFixture.BuiltAt))
        return publisher.Publish({
            tag: ReleaseTag.FromVersion(version),
            serverCommit: CatalogFixture.ServerCommit,
            siblingCommits: { [CatalogFixture.SiblingRepo]: CatalogFixture.SiblingCommit },
            signingKeyId: key.Id,
            privateKeyPem: key.Private,
            trustedPublicKeyPem: key.Public,
        })
    }

    /** Pushes a hand-made descriptor the way the publisher does (signature over the layer digest), for shapes the publisher refuses to produce. */
    public async PushDescriptor(tag: string, bytes: Uint8Array, key: SigningKey = this.Trusted): Promise<void>
    {
        const S = ReleasePublisher
        await this.PushArtifact(tag, bytes, {
            [S.SignatureAnnotation]: ReleaseSignature.Sign(OciRegistryClient.DigestOf(bytes), key.Private),
            [S.KeyAnnotation]: key.Id,
        })
    }

    /** Pushes descriptor bytes under the given annotations exactly (to drop or forge one). */
    public async PushArtifact(tag: string, bytes: Uint8Array, annotations: Record<string, string>): Promise<void>
    {
        const S = ReleasePublisher
        await this.Client().PushArtifact(CatalogFixture.DescriptorRepo(), tag, S.ArtifactType, S.LayerMediaType, bytes, annotations)
    }

    /** Stores a raw (possibly malformed) manifest under a descriptor tag. */
    public PutRawDescriptorManifest(tag: string, manifest: unknown): void
    {
        this.Registry.PutManifest(CatalogFixture.DescriptorRepo(), tag, new TextEncoder().encode(JSON.stringify(manifest)), CatalogFixture.ManifestType)
    }

    /** A correctly signed descriptor for the version (images seeded), before any test mutation. */
    public Descriptor(version: string, key: SigningKey = this.Trusted): ReleaseDescriptor
    {
        this.SeedImages(version)
        const images = {} as ReleaseDescriptor['images']
        for (const app of ReleaseApps.All)
        {
            const digest = FakeOciRegistry.DigestOf(CatalogFixture.ImageBytes(app, version))
            images[app] = { repository: CatalogFixture.Repo(app), digest, signature: ReleaseSignature.Sign(digest, key.Private) }
        }
        return {
            schema: 1,
            version,
            channel: ReleaseTag.FromVersion(version).Channel,
            serverCommit: CatalogFixture.ServerCommit,
            siblingCommits: {},
            builtAt: CatalogFixture.BuiltAt,
            signingKeyId: key.Id,
            images,
        }
    }

    public Release(version: string)
    {
        return this.Deployments.AllManifests().find(m => m.id === version)
    }

    public Reason(version: string): string | undefined
    {
        return this.Release(version)?.release?.rejectedReason
    }
}

describe('ReleaseCatalog.Refresh', () =>
{
    it('imports a verified release with every field from the descriptor, and a second refresh is unchanged', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const { descriptor } = await fx.Publish(CatalogFixture.V1)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [CatalogFixture.V1], rejected: [], unchanged: 0, shadowed: [] })
            const envServer = descriptor.images[ReleaseApp.EnvServer].digest
            const images = Object.fromEntries(ReleaseApps.All.map(app => [app, { repository: CatalogFixture.Repo(app), digest: descriptor.images[app].digest }]))
            assert.deepEqual(fx.Release(CatalogFixture.V1), {
                id: CatalogFixture.V1,
                channel: Channel.Stable,
                image: CatalogFixture.ImageHost + CatalogFixture.Repo(ReleaseApp.EnvServer) + CatalogFixture.DigestSeparator + envServer,
                digest: envServer,
                signed: true,
                publishedAt: CatalogFixture.BuiltAt,
                release: {
                    state: ReleaseState.Verified,
                    serverCommit: CatalogFixture.ServerCommit,
                    siblingCommits: { [CatalogFixture.SiblingRepo]: CatalogFixture.SiblingCommit },
                    builtAt: CatalogFixture.BuiltAt,
                    signingKeyId: CatalogFixture.TrustedId,
                    images,
                },
            })
            const again = await fx.Catalog().Refresh()
            assert.deepEqual(again, { imported: [], rejected: [], unchanged: 1, shadowed: [] })
            assert.equal(fx.Deployments.AllManifests().length, 1)
        })
    })

    it('takes the channel from the descriptor: an early-access tag imports on the early channel', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.Early)
            await fx.Catalog().Refresh()
            assert.equal(fx.Release(CatalogFixture.Early)!.channel, Channel.EarlyAccess)
            assert.equal(fx.Release(CatalogFixture.Early)!.release!.state, ReleaseState.Verified)
        })
    })

    it('rejects a release whose registry image digest differs from the descriptor, naming the app', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1)
            fx.Registry.PutManifest(CatalogFixture.Repo(ReleaseApp.EnvGateway), CatalogFixture.V1, new TextEncoder().encode('rebuilt'), CatalogFixture.ManifestType)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [], rejected: [CatalogFixture.V1], unchanged: 0, shadowed: [] })
            const record = fx.Release(CatalogFixture.V1)!
            assert.equal(record.release!.state, ReleaseState.Rejected)
            assert.equal(record.release!.rejectedReason, 'image digest mismatch: pragmatic-env-gateway')
            assert.equal(record.signed, false)
        })
    })

    it('rejects a release whose image is absent from the registry under the version tag, naming the app', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const descriptor = { ...fx.Descriptor(CatalogFixture.V1), version: CatalogFixture.Unseeded }
            await fx.PushDescriptor(CatalogFixture.Unseeded, ReleaseDescriptorCodec.Encode(descriptor))
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [], rejected: [CatalogFixture.Unseeded], unchanged: 0, shadowed: [] })
            assert.equal(fx.Reason(CatalogFixture.Unseeded), 'image missing: pragmatic-platform-admin')
        })
    })

    it('rejects an image whose signature does not verify, naming the app', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const descriptor = fx.Descriptor(CatalogFixture.V1)
            const agent = descriptor.images[ReleaseApp.HiveAgent]
            descriptor.images[ReleaseApp.HiveAgent] = { ...agent, signature: ReleaseSignature.Sign(agent.digest, fx.Rogue.Private) }
            await fx.PushDescriptor(CatalogFixture.V1, ReleaseDescriptorCodec.Encode(descriptor))
            await fx.Catalog().Refresh()
            assert.equal(fx.Reason(CatalogFixture.V1), 'image signature invalid: pragmatic-hive-agent')
        })
    })

    it('rejects an image recorded under a repository other than <namespace>/<app>, naming the app', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const descriptor = fx.Descriptor(CatalogFixture.V1)
            descriptor.images[ReleaseApp.UiUnpack] = { ...descriptor.images[ReleaseApp.UiUnpack], repository: 'elsewhere/pragmatic-ui-unpack' }
            await fx.PushDescriptor(CatalogFixture.V1, ReleaseDescriptorCodec.Encode(descriptor))
            await fx.Catalog().Refresh()
            assert.equal(fx.Reason(CatalogFixture.V1), 'image repository mismatch: pragmatic-ui-unpack')
        })
    })

    it('rejects a descriptor signed by an untrusted key, naming the key id', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1, fx.Rogue)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result.rejected, [CatalogFixture.V1])
            assert.equal(fx.Reason(CatalogFixture.V1), 'untrusted signing key: ' + CatalogFixture.RogueId)
        })
    })

    it('rejects a descriptor whose untrusted key id is not a plain identifier, without echoing the registry text', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const odd = new SigningKey('<b>evil key</b>')
            await fx.PushDescriptor(CatalogFixture.V1, ReleaseDescriptorCodec.Encode(fx.Descriptor(CatalogFixture.V1, odd)), odd)
            await fx.Catalog().Refresh()
            const reason = fx.Reason(CatalogFixture.V1)!
            assert.equal(reason, 'untrusted signing key')
            assert.ok(!reason.includes('evil'))
        })
    })

    it('rejects a descriptor with no signing key annotation', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const bytes = ReleaseDescriptorCodec.Encode(fx.Descriptor(CatalogFixture.V1))
            await fx.PushArtifact(CatalogFixture.V1, bytes, { [ReleasePublisher.SignatureAnnotation]: ReleaseSignature.Sign(OciRegistryClient.DigestOf(bytes), fx.Trusted.Private) })
            await fx.Catalog().Refresh()
            assert.equal(fx.Reason(CatalogFixture.V1), 'signing key missing')
        })
    })

    it('rejects a descriptor whose signingKeyId differs from the key that signed it, naming the signing key', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const descriptor = { ...fx.Descriptor(CatalogFixture.V1), signingKeyId: CatalogFixture.RogueId }
            await fx.PushDescriptor(CatalogFixture.V1, ReleaseDescriptorCodec.Encode(descriptor))
            await fx.Catalog().Refresh()
            assert.equal(fx.Reason(CatalogFixture.V1), 'signing key mismatch: ' + CatalogFixture.TrustedId)
        })
    })

    it('rejects a descriptor whose signature does not cover its layer, naming the key id and no signature bytes', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const bytes = ReleaseDescriptorCodec.Encode(fx.Descriptor(CatalogFixture.V1))
            const forged = ReleaseSignature.Sign(OciRegistryClient.DigestOf(new TextEncoder().encode('other')), fx.Trusted.Private)
            await fx.PushArtifact(CatalogFixture.V1, bytes, {
                [ReleasePublisher.SignatureAnnotation]: forged,
                [ReleasePublisher.KeyAnnotation]: CatalogFixture.TrustedId,
            })
            await fx.Catalog().Refresh()
            const reason = fx.Reason(CatalogFixture.V1)!
            assert.equal(reason, 'descriptor signature invalid: ' + CatalogFixture.TrustedId)
            assert.ok(!reason.includes(forged))
        })
    })

    it('rejects altered descriptor layer bytes with a fixed sentence', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1)
            fx.Registry.TamperBlobs(true)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [], rejected: [CatalogFixture.V1], unchanged: 0, shadowed: [] })
            assert.equal(fx.Reason(CatalogFixture.V1), CatalogFixture.LayerMismatch)
        })
    })

    it('rejects a descriptor whose annotations are not strings with its own fixed sentence, never the registry text', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const leak = CatalogFixture.RegistryText
            fx.PutRawDescriptorManifest(CatalogFixture.V1, { schemaVersion: 2, layers: [{ digest: CatalogFixture.SomeDigest }], annotations: { [ReleasePublisher.KeyAnnotation]: [leak] } })
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [], rejected: [CatalogFixture.V1], unchanged: 0, shadowed: [] })
            assert.equal(fx.Reason(CatalogFixture.V1), CatalogFixture.BadAnnotations)
            assert.ok(!fx.Reason(CatalogFixture.V1)?.includes(leak))
        })
    })

    it('records the by-digest image under the configured registry host, not always ghcr.io', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const { descriptor } = await fx.Publish(CatalogFixture.V1)
            await fx.Catalog(undefined, CatalogFixture.OtherHost).Refresh()
            const server = descriptor.images[ReleaseApp.EnvServer]
            assert.equal(fx.Release(CatalogFixture.V1)?.image, CatalogFixture.OtherHost + CatalogFixture.PathSeparator + server.repository + CatalogFixture.DigestSeparator + server.digest)
        })
    })

    it('re-inspects a rejected version on every refresh and replaces it once it verifies, counting it imported', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1)
            const gateway = CatalogFixture.Repo(ReleaseApp.EnvGateway)
            const original = CatalogFixture.ImageBytes(ReleaseApp.EnvGateway, CatalogFixture.V1)
            fx.Registry.PutManifest(gateway, CatalogFixture.V1, new TextEncoder().encode(CatalogFixture.Rebuilt), CatalogFixture.ManifestType)
            assert.deepEqual(await fx.Catalog().Refresh(), { imported: [], rejected: [CatalogFixture.V1], unchanged: 0, shadowed: [] })
            // Still failing: the rejected record stays as it is and counts unchanged.
            assert.deepEqual(await fx.Catalog().Refresh(), { imported: [], rejected: [], unchanged: 1, shadowed: [] })
            assert.equal(fx.Release(CatalogFixture.V1)?.release?.state, ReleaseState.Rejected)
            // The tag points at the signed image again: the next refresh imports the verified record in its place.
            fx.Registry.PutManifest(gateway, CatalogFixture.V1, original, CatalogFixture.ManifestType)
            assert.deepEqual(await fx.Catalog().Refresh(), { imported: [CatalogFixture.V1], rejected: [], unchanged: 0, shadowed: [] })
            assert.equal(fx.Release(CatalogFixture.V1)?.release?.state, ReleaseState.Verified)
            assert.equal(fx.Reason(CatalogFixture.V1), undefined)
            assert.equal(fx.Deployments.AllManifests().length, 1)
            assert.deepEqual(await fx.Catalog().Refresh(), { imported: [], rejected: [], unchanged: 1, shadowed: [] })
        })
    })

    it('never re-inspects a verified version: only rejected ones are retried', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1)
            await fx.Catalog().Refresh()
            const before = fx.Registry.Requests.length
            assert.deepEqual(await fx.Catalog().Refresh(), { imported: [], rejected: [], unchanged: 1, shadowed: [] })
            const pulls = fx.Registry.Requests.slice(before).filter(r => r.url.includes('/manifests/') || r.url.includes('/blobs/'))
            assert.deepEqual(pulls, [])
        })
    })

    it('rejects malformed descriptor artifacts (sha512 layer digest, null manifest, null layer) and still imports the good version', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const sha512 = '0.0.1'
            const nullManifest = '0.0.2'
            const nullLayer = '0.0.3'
            fx.PutRawDescriptorManifest(sha512, { schemaVersion: 2, layers: [{ digest: 'sha512:' + 'a'.repeat(128) }] })
            fx.PutRawDescriptorManifest(nullManifest, null)
            fx.PutRawDescriptorManifest(nullLayer, { schemaVersion: 2, layers: [null] })
            await fx.Publish(CatalogFixture.V1)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [CatalogFixture.V1], rejected: [sha512, nullManifest, nullLayer], unchanged: 0, shadowed: [] })
            for (const version of [sha512, nullManifest, nullLayer])
            {
                assert.equal(fx.Reason(version), CatalogFixture.BadManifest)
            }
        })
    })

    it('rejects a descriptor that does not decode, with the codec reason', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.PushDescriptor(CatalogFixture.V1, new TextEncoder().encode('{"schema":2}'))
            await fx.Catalog().Refresh()
            assert.equal(fx.Reason(CatalogFixture.V1), 'descriptor invalid: schema must be 1')
        })
    })

    it('rejects a descriptor whose version or channel disagrees with its tag', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const descriptor = fx.Descriptor(CatalogFixture.V1)
            await fx.PushDescriptor(CatalogFixture.V2, ReleaseDescriptorCodec.Encode(descriptor))
            await fx.PushDescriptor(CatalogFixture.V1, ReleaseDescriptorCodec.Encode({ ...descriptor, channel: Channel.EarlyAccess }))
            await fx.Catalog().Refresh()
            assert.equal(fx.Reason(CatalogFixture.V2), 'descriptor version mismatch')
            assert.equal(fx.Reason(CatalogFixture.V1), 'descriptor channel mismatch')
        })
    })

    it('ignores tags that are not release versions, and an absent descriptor repository lists nothing', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            assert.deepEqual(await fx.Catalog().Refresh(), { imported: [], rejected: [], unchanged: 0, shadowed: [] })
            await fx.Publish(CatalogFixture.V1)
            fx.Registry.SetTags(CatalogFixture.DescriptorRepo(), ['latest', CatalogFixture.V1, 'release-notes'])
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [CatalogFixture.V1], rejected: [], unchanged: 0, shadowed: [] })
            assert.deepEqual(fx.Deployments.AllManifests().map(m => m.id), [CatalogFixture.V1])
        })
    })

    it('skips a listed version whose descriptor has vanished (404) before the pull', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            fx.Registry.SetTags(CatalogFixture.DescriptorRepo(), [CatalogFixture.V1])
            assert.deepEqual(await fx.Catalog().Refresh(), { imported: [], rejected: [], unchanged: 0, shadowed: [] })
            assert.deepEqual(fx.Deployments.AllManifests(), [])
        })
    })

    it('reports a registry release hidden by a locally published manifest of the same id as shadowed, and leaves the local record', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Deployments.Publish(CatalogFixture.V1, CatalogFixture.LocalImage)
            await fx.Publish(CatalogFixture.V1)
            await fx.Publish(CatalogFixture.V2)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [CatalogFixture.V2], rejected: [], unchanged: 0, shadowed: [CatalogFixture.V1] })
            const local = fx.Release(CatalogFixture.V1)!
            assert.equal(local.image, CatalogFixture.LocalImage)
            assert.equal(local.release, undefined)
        })
    })

    it('counts a version recorded by someone else during the refresh as unchanged and imports the rest', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1)
            await fx.Publish(CatalogFixture.V2)
            let raced = false
            fx.BeforeRequest = async url =>
            {
                if (!raced && url.includes('/manifests/' + CatalogFixture.V2))
                {
                    raced = true
                    await fx.Deployments.Publish(CatalogFixture.V1, CatalogFixture.LocalImage)
                }
            }
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [CatalogFixture.V2], rejected: [], unchanged: 1, shadowed: [] })
            assert.equal(fx.Release(CatalogFixture.V1)!.image, CatalogFixture.LocalImage)
        })
    })

    it('throws ReleaseRegistryUnavailableError and imports nothing when the registry drops mid-refresh', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1)
            await fx.Publish(CatalogFixture.V2)
            fx.FailOn = '/manifests/' + CatalogFixture.V2
            await assert.rejects(fx.Catalog().Refresh(), (err: Error) =>
                err instanceof ReleaseRegistryUnavailableError && !err.message.includes(CatalogFixture.Token) && !err.message.includes(CatalogFixture.Unreachable.trim()))
            assert.deepEqual(fx.Deployments.AllManifests(), [])
        })
    })

    it('throws ReleaseRegistryUnavailableError without the token when the credential is refused', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1)
            fx.Registry.RequireBearer(CatalogFixture.User, CatalogFixture.Token)
            await assert.rejects(fx.Catalog({ username: CatalogFixture.User, token: CatalogFixture.WrongToken }).Refresh(), (err: Error) =>
                err instanceof ReleaseRegistryUnavailableError && !err.message.includes(CatalogFixture.WrongToken) && !err.message.includes(CatalogFixture.Token))
            assert.deepEqual(fx.Deployments.AllManifests(), [])
            const result = await fx.Catalog({ username: CatalogFixture.User, token: CatalogFixture.Token }).Refresh()
            assert.deepEqual(result.imported, [CatalogFixture.V1])
        })
    })
})
