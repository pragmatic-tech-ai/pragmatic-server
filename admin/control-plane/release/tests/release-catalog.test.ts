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

    public readonly Registry = new FakeOciRegistry()
    public readonly Rogue = new SigningKey(CatalogFixture.RogueId)
    /** When set, the catalogue's fetch throws for any URL containing it (simulating a registry that drops mid-refresh). */
    public FailOn: string | undefined

    private constructor(public readonly Deployments: PlatformDeploymentRegistry, public readonly Trusted: SigningKey, private readonly trust: ReleaseTrustKeys)
    {
    }

    /** Trusts exactly one key (written as `<id>.pub.pem`) over a real deployment registry in a temp directory. */
    public static async Run(body: (fx: CatalogFixture) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), 'release-catalog-'))
        try
        {
            const keysDir = join(dir, 'keys')
            const trusted = new SigningKey(CatalogFixture.TrustedId)
            await mkdir(keysDir)
            await writeFile(join(keysDir, trusted.Id + '.pub.pem'), trusted.Public)
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
        return CatalogFixture.Namespace + '/' + app
    }

    public Client(credential?: { username: string; token: string }): OciRegistryClient
    {
        const inner = this.Registry.Fetch
        const fetchFn: OciFetch = async (url, init) =>
        {
            if (this.FailOn !== undefined && url.includes(this.FailOn))
            {
                throw new Error('connect ECONNREFUSED ' + CatalogFixture.Token)
            }
            return inner(url, init)
        }
        return new OciRegistryClient(this.Registry.Origin, fetchFn, credential)
    }

    public Catalog(credential?: { username: string; token: string }): ReleaseCatalog
    {
        return new ReleaseCatalog(this.Client(credential), CatalogFixture.Namespace, this.trust, this.Deployments)
    }

    public SeedImages(version: string): void
    {
        for (const app of ReleaseApps.All)
        {
            this.Registry.PutManifest(CatalogFixture.Repo(app), version, new TextEncoder().encode('image ' + app + ' ' + version), CatalogFixture.ManifestType)
        }
    }

    /** Publishes through the real ReleasePublisher, so the catalogue reads exactly what the release workflow writes. */
    public async Publish(version: string, key: SigningKey = this.Trusted): Promise<{ descriptor: ReleaseDescriptor; descriptorDigest: string }>
    {
        this.SeedImages(version)
        const publisher = new ReleasePublisher(this.Client(), CatalogFixture.Namespace, () => new Date(CatalogFixture.BuiltAt))
        return publisher.Publish({
            tag: ReleaseTag.Parse('release/' + version),
            serverCommit: CatalogFixture.ServerCommit,
            siblingCommits: { [CatalogFixture.SiblingRepo]: CatalogFixture.SiblingCommit },
            signingKeyId: key.Id,
            privateKeyPem: key.Private,
        })
    }

    /** Pushes a hand-made descriptor the way the publisher does (signature over the layer digest), for shapes the publisher refuses to produce. */
    public async PushDescriptor(tag: string, bytes: Uint8Array, key: SigningKey = this.Trusted): Promise<void>
    {
        const S = ReleasePublisher
        const signature = ReleaseSignature.Sign(OciRegistryClient.DigestOf(bytes), key.Private)
        await this.Client().PushArtifact(CatalogFixture.Repo(S.DescriptorRepository), tag, S.ArtifactType, S.LayerMediaType, bytes, {
            [S.SignatureAnnotation]: signature,
            [S.KeyAnnotation]: key.Id,
        })
    }

    /** A correctly signed descriptor for the version (images seeded), before any test mutation. */
    public Descriptor(version: string, key: SigningKey = this.Trusted): ReleaseDescriptor
    {
        this.SeedImages(version)
        const images = {} as ReleaseDescriptor['images']
        for (const app of ReleaseApps.All)
        {
            const digest = FakeOciRegistry.DigestOf(new TextEncoder().encode('image ' + app + ' ' + version))
            images[app] = { repository: CatalogFixture.Repo(app), digest, signature: ReleaseSignature.Sign(digest, key.Private) }
        }
        return {
            schema: 1,
            version,
            channel: ReleaseTag.Parse('release/' + version).Channel,
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
}

describe('ReleaseCatalog.Refresh', () =>
{
    it('imports a verified release with every field from the descriptor, and a second refresh is unchanged', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const { descriptor } = await fx.Publish(CatalogFixture.V1)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [CatalogFixture.V1], rejected: [], unchanged: 0 })
            const envServer = descriptor.images[ReleaseApp.EnvServer].digest
            const images = Object.fromEntries(ReleaseApps.All.map(app => [app, { repository: CatalogFixture.Repo(app), digest: descriptor.images[app].digest }]))
            assert.deepEqual(fx.Release(CatalogFixture.V1), {
                id: CatalogFixture.V1,
                channel: Channel.Stable,
                image: CatalogFixture.ImageHost + CatalogFixture.Repo(ReleaseApp.EnvServer) + '@' + envServer,
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
            assert.deepEqual(again, { imported: [], rejected: [], unchanged: 1 })
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
            assert.deepEqual(result, { imported: [], rejected: [CatalogFixture.V1], unchanged: 0 })
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
            const unseeded = '9.9.9'
            const descriptor = { ...fx.Descriptor(CatalogFixture.V1), version: unseeded }
            await fx.PushDescriptor(unseeded, ReleaseDescriptorCodec.Encode(descriptor))
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [], rejected: [unseeded], unchanged: 0 })
            assert.equal(fx.Release(unseeded)!.release!.rejectedReason, 'image missing: pragmatic-platform-admin')
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
            const reason = fx.Release(CatalogFixture.V1)!.release!.rejectedReason!
            assert.equal(reason, 'image signature invalid: pragmatic-hive-agent')
        })
    })

    it('rejects a descriptor signed by an untrusted key, naming the key id', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1, fx.Rogue)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result.rejected, [CatalogFixture.V1])
            assert.equal(fx.Release(CatalogFixture.V1)!.release!.rejectedReason, 'untrusted signing key: rogue-key')
        })
    })

    it('rejects a descriptor whose signature does not cover its layer, naming the key id and no signature bytes', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            const bytes = ReleaseDescriptorCodec.Encode(fx.Descriptor(CatalogFixture.V1))
            const S = ReleasePublisher
            const forged = ReleaseSignature.Sign(OciRegistryClient.DigestOf(new TextEncoder().encode('other')), fx.Trusted.Private)
            await fx.Client().PushArtifact(CatalogFixture.Repo(S.DescriptorRepository), CatalogFixture.V1, S.ArtifactType, S.LayerMediaType, bytes, {
                [S.SignatureAnnotation]: forged,
                [S.KeyAnnotation]: CatalogFixture.TrustedId,
            })
            await fx.Catalog().Refresh()
            const reason = fx.Release(CatalogFixture.V1)!.release!.rejectedReason!
            assert.equal(reason, 'descriptor signature invalid: release-2026')
            assert.ok(!reason.includes(forged))
        })
    })

    it('rejects altered descriptor layer bytes without echoing them', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.Publish(CatalogFixture.V1)
            fx.Registry.TamperBlobs(true)
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [], rejected: [CatalogFixture.V1], unchanged: 0 })
            const reason = fx.Release(CatalogFixture.V1)!.release!.rejectedReason!
            assert.equal(reason, 'descriptor artifact invalid: The OCI layer bytes do not match the digest in the manifest')
        })
    })

    it('rejects a descriptor that does not decode, with the codec reason', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            await fx.PushDescriptor(CatalogFixture.V1, new TextEncoder().encode('{"schema":2}'))
            await fx.Catalog().Refresh()
            assert.equal(fx.Release(CatalogFixture.V1)!.release!.rejectedReason, 'descriptor invalid: schema must be 1')
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
            assert.equal(fx.Release(CatalogFixture.V2)!.release!.rejectedReason, 'descriptor version mismatch')
            assert.equal(fx.Release(CatalogFixture.V1)!.release!.rejectedReason, 'descriptor channel mismatch')
        })
    })

    it('ignores tags that are not release versions, and an absent descriptor repository lists nothing', async () =>
    {
        await CatalogFixture.Run(async fx =>
        {
            assert.deepEqual(await fx.Catalog().Refresh(), { imported: [], rejected: [], unchanged: 0 })
            await fx.Publish(CatalogFixture.V1)
            const repo = CatalogFixture.Repo(ReleasePublisher.DescriptorRepository)
            fx.Registry.SetTags(repo, ['latest', CatalogFixture.V1, 'release-notes'])
            const result = await fx.Catalog().Refresh()
            assert.deepEqual(result, { imported: [CatalogFixture.V1], rejected: [], unchanged: 0 })
            assert.deepEqual(fx.Deployments.AllManifests().map(m => m.id), [CatalogFixture.V1])
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
                err instanceof ReleaseRegistryUnavailableError && !err.message.includes(CatalogFixture.Token) && !err.message.includes('ECONNREFUSED'))
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
