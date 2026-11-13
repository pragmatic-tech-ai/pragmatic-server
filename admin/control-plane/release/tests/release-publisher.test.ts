import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OciRegistryClient } from '../../oci-registry-client.js'
import { FakeOciRegistry } from '../../tests/fake-oci-registry.js'
import { ImportWalker } from '../../tests/import-walker.js'
import { ReleaseDescriptorCodec } from '../release-descriptor.js'
import { ReleasePublishCli } from '../release-publish-cli.js'
import { ReleaseImageMissingError, ReleasePublisher, ReleaseSigningKeyMismatchError, ReleaseVersionExistsError } from '../release-publisher.js'
import { ReleaseSignature } from '../release-signature.js'
import { ReleaseApp, ReleaseApps, ReleaseTag, ReleaseTagInvalidError } from '../release-tag.js'
import { ReleaseTrustKeys } from '../release-trust-keys.js'

class KeyPair
{
    public readonly Private: string
    public readonly Public: string

    public constructor()
    {
        const pair = generateKeyPairSync('ed25519')
        this.Private = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        this.Public = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }
}

class PublisherFixture
{
    public static readonly Namespace = 'pragmatic-tech-ai'
    public static readonly Version = '1.4.0'
    public static readonly TagRef = 'refs/tags/release/1.4.0'
    public static readonly BadTagRef = 'release/1.4'
    public static readonly KeyId = 'release-2026'
    public static readonly Token = 'ghp_super_secret_token'
    public static readonly User = 'release-bot'
    public static readonly ServerCommit = 'a'.repeat(40)
    public static readonly SiblingCommit = 'b'.repeat(40)
    public static readonly SiblingRepo = 'todl'
    public static readonly ManifestType = 'application/vnd.oci.image.manifest.v1+json'
    public static readonly BuiltAt = '2026-11-12T10:00:00.000Z'
    public static readonly DescriptorPath = '/manifests/' + PublisherFixture.Version
    public static readonly ImagePrefix = 'image '
    public static readonly Pem = /-----BEGIN/
    public static readonly MethodHead = 'HEAD'
    public static readonly MethodPut = 'PUT'
    public static readonly PathSeparator = '/'

    public readonly Registry = new FakeOciRegistry()
    public readonly Key = new KeyPair()
    /** The public key the publisher trusts; another pair's to simulate a mismatched signing secret. */
    public Trusted: string

    public constructor()
    {
        this.Trusted = this.Key.Public
    }

    public static Repo(app: string): string
    {
        return PublisherFixture.Namespace + PublisherFixture.PathSeparator + app
    }

    public SeedImages(skip?: ReleaseApp): void
    {
        for (const app of ReleaseApps.All)
        {
            if (app !== skip)
            {
                const bytes = new TextEncoder().encode(PublisherFixture.ImagePrefix + app)
                this.Registry.PutManifest(PublisherFixture.Repo(app), PublisherFixture.Version, bytes, PublisherFixture.ManifestType)
            }
        }
    }

    public Publisher(): ReleasePublisher
    {
        const client = new OciRegistryClient(this.Registry.Origin, this.Registry.Fetch)
        return new ReleasePublisher(client, PublisherFixture.Namespace, () => new Date(PublisherFixture.BuiltAt))
    }

    public Input()
    {
        return {
            tag: ReleaseTag.Parse(PublisherFixture.TagRef),
            serverCommit: PublisherFixture.ServerCommit,
            siblingCommits: { [PublisherFixture.SiblingRepo]: PublisherFixture.SiblingCommit },
            signingKeyId: PublisherFixture.KeyId,
            privateKeyPem: this.Key.Private,
            trustedPublicKeyPem: this.Trusted,
        }
    }

    /** True when the registry saw only reads: nothing was uploaded or tagged. */
    public get PushedNothing(): boolean
    {
        return this.Registry.Requests.every(r => r.method === PublisherFixture.MethodHead)
    }
}

class CliFixture
{
    public static readonly Check = 'check'
    public static readonly Publish = 'publish'
    public static readonly Bogus = 'bogus'
    public static readonly FlagTag = '--tag'
    public static readonly FlagServerCommit = '--server-commit'
    public static readonly FlagSiblingsFile = '--siblings-file'
    public static readonly FlagKeyId = '--key-id'
    public static readonly FlagTrustDir = '--trust-dir'
    public static readonly FlagBogus = '--bogus'
    public static readonly BogusValue = 'x'
    public static readonly KeyFileName = 'key.pem'
    public static readonly SiblingsFileName = 'siblings.json'
    public static readonly TrustDirName = 'trust'
    public static readonly MissingName = 'nope'
    public static readonly TempPrefix = 'release-cli-'
    public static readonly KeyFileVar = 'RELEASE_SIGNING_KEY_FILE'
    public static readonly TokenVar = 'RELEASE_REGISTRY_TOKEN'
    public static readonly NoOsError = 'ENOENT'
    public static readonly HexSentence = '40-hex'
    public static readonly GhcrPrefix = 'https://ghcr.io/v2/'
    public static readonly TrustedKeyPath = 'release-keys/' + PublisherFixture.KeyId + '.pub.pem'

    public readonly Dir = mkdtempSync(join(tmpdir(), CliFixture.TempPrefix))
    public readonly Lines: string[] = []
    public readonly Errors: string[] = []
    public readonly Env: NodeJS.ProcessEnv

    public constructor(public readonly Base: PublisherFixture)
    {
        const keyFile = join(this.Dir, CliFixture.KeyFileName)
        writeFileSync(keyFile, Base.Key.Private)
        writeFileSync(this.SiblingsFile, JSON.stringify({ [PublisherFixture.SiblingRepo]: PublisherFixture.SiblingCommit }))
        mkdirSync(this.TrustDir)
        this.Trust(Base.Trusted)
        this.Env = {
            RELEASE_SIGNING_KEY_FILE: keyFile,
            RELEASE_REGISTRY_USER: PublisherFixture.User,
            RELEASE_REGISTRY_TOKEN: PublisherFixture.Token,
            RELEASE_REGISTRY: Base.Registry.Origin,
            RELEASE_NAMESPACE: PublisherFixture.Namespace,
        }
    }

    public get SiblingsFile(): string
    {
        return join(this.Dir, CliFixture.SiblingsFileName)
    }

    public get TrustDir(): string
    {
        return join(this.Dir, CliFixture.TrustDirName)
    }

    public get Missing(): string
    {
        return join(this.Dir, CliFixture.MissingName)
    }

    /** Writes `<trust dir>/<key id>.pub.pem`. */
    public Trust(publicKeyPem: string): void
    {
        writeFileSync(join(this.TrustDir, PublisherFixture.KeyId + ReleaseTrustKeys.Suffix), publicKeyPem)
    }

    public CheckArgs(ref: string = PublisherFixture.TagRef): string[]
    {
        return [CliFixture.Check, CliFixture.FlagTag, ref]
    }

    public PublishArgs(): string[]
    {
        const C = CliFixture
        return [C.Publish, C.FlagTag, PublisherFixture.TagRef, C.FlagServerCommit, PublisherFixture.ServerCommit,
            C.FlagSiblingsFile, this.SiblingsFile, C.FlagKeyId, PublisherFixture.KeyId, C.FlagTrustDir, this.TrustDir]
    }

    /** The publish arguments with one option's value replaced. */
    public PublishArgsWith(flag: string, value: string): string[]
    {
        const args = this.PublishArgs()
        args[args.indexOf(flag) + 1] = value
        return args
    }

    public Run(...argv: string[]): Promise<number>
    {
        const output = { Out: (line: string) => { this.Lines.push(line) }, Err: (line: string) => { this.Errors.push(line) } }
        return ReleasePublishCli.Run(argv, this.Env, output, this.Base.Registry.Fetch)
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }

    public static async With(base: PublisherFixture, body: (cli: CliFixture) => Promise<void>): Promise<void>
    {
        const cli = new CliFixture(base)
        try
        {
            await body(cli)
        }
        finally
        {
            cli.Dispose()
        }
    }
}

class Probe
{
    /** Source text naming x1..x6 every way a module can be imported; kept in a .txt fixture so no walk of this file sees it. */
    public static readonly ImportsFile = 'fixtures/import-probe.txt'
    public static readonly Expected: readonly string[] = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6']
    public static readonly CliBin = '../../bin/pragmatic-release-publish.ts'
    public static readonly RepoRoot = '../../../..'
    public static readonly ShippedKey = 'release-2026-11'
}

describe('ReleasePublisher', () =>
{
    it('publishes a signed descriptor last, after every image is verified present', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        const { descriptor, descriptorDigest } = await f.Publisher().Publish(f.Input())
        assert.equal(descriptor.builtAt, PublisherFixture.BuiltAt)
        const client = new OciRegistryClient(f.Registry.Origin, f.Registry.Fetch)
        const pulled = await client.PullArtifactLayer(PublisherFixture.Repo(ReleasePublisher.DescriptorRepository), PublisherFixture.Version)
        const decoded = ReleaseDescriptorCodec.Decode(pulled.layer)
        assert.deepEqual(decoded, descriptor)
        assert.equal(decoded.signingKeyId, PublisherFixture.KeyId)
        for (const app of ReleaseApps.All)
        {
            const image = decoded.images[app]
            assert.equal(image.repository, PublisherFixture.Repo(app))
            assert.equal(image.digest, FakeOciRegistry.DigestOf(new TextEncoder().encode(PublisherFixture.ImagePrefix + app)))
            assert.ok(ReleaseSignature.Verifies(image.digest, image.signature, f.Key.Public))
        }
        assert.equal(pulled.layerDigest, descriptorDigest)
        assert.equal(pulled.layerDigest, OciRegistryClient.DigestOf(ReleaseDescriptorCodec.Encode(decoded)))
        assert.ok(ReleaseSignature.Verifies(pulled.layerDigest, pulled.annotations[ReleasePublisher.SignatureAnnotation], f.Key.Public))
        assert.equal(pulled.annotations[ReleasePublisher.KeyAnnotation], PublisherFixture.KeyId)
    })

    it('makes the descriptor manifest push the last registry request', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        await f.Publisher().Publish(f.Input())
        const last = f.Registry.Requests[f.Registry.Requests.length - 1]
        assert.equal(last.method, PublisherFixture.MethodPut)
        assert.ok(last.url.endsWith(PublisherFixture.PathSeparator + ReleasePublisher.DescriptorRepository + PublisherFixture.DescriptorPath))
    })

    it('refuses to publish when an image tag is missing and pushes nothing', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages(ReleaseApp.UiUnpack)
        await assert.rejects(() => f.Publisher().Publish(f.Input()), (err: unknown) =>
        {
            assert.ok(err instanceof ReleaseImageMissingError)
            assert.equal(err.App, ReleaseApp.UiUnpack)
            assert.equal(err.Version, PublisherFixture.Version)
            return true
        })
        assert.ok(f.PushedNothing)
    })

    it('refuses to publish, pushing nothing, when the signing key does not match the trusted public key', async () =>
    {
        const f = new PublisherFixture()
        f.Trusted = new KeyPair().Public
        f.SeedImages()
        await assert.rejects(() => f.Publisher().Publish(f.Input()), (err: unknown) =>
        {
            assert.ok(err instanceof ReleaseSigningKeyMismatchError)
            assert.equal(err.message, new ReleaseSigningKeyMismatchError(PublisherFixture.KeyId).message)
            assert.ok(err.message.includes(CliFixture.TrustedKeyPath))
            assert.ok(!PublisherFixture.Pem.test(err.message))
            return true
        })
        assert.ok(f.PushedNothing)
        await f.Publisher().CheckVersionFree(PublisherFixture.Version)
    })

    it('decodes the descriptor before the push: one the catalogue would refuse is never published', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        const input = { ...f.Input(), signingKeyId: '' }
        await assert.rejects(() => f.Publisher().Publish(input), /signingKeyId/)
        assert.ok(f.PushedNothing)
    })

    it('rejects a version whose descriptor tag already exists', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        await f.Publisher().Publish(f.Input())
        await assert.rejects(() => f.Publisher().CheckVersionFree(PublisherFixture.Version), ReleaseVersionExistsError)
        await assert.rejects(() => f.Publisher().Publish(f.Input()), ReleaseVersionExistsError)
    })

    it('accepts a version with no descriptor', async () =>
    {
        await new PublisherFixture().Publisher().CheckVersionFree(PublisherFixture.Version)
    })
})

describe('ReleasePublishCli', () =>
{
    it('check rejects a malformed tag with the ReleaseTagInvalidError sentence and exits 1', async () =>
    {
        await CliFixture.With(new PublisherFixture(), async cli =>
        {
            const code = await cli.Run(...cli.CheckArgs(PublisherFixture.BadTagRef))
            assert.equal(code, 1)
            assert.deepEqual(cli.Errors, [new ReleaseTagInvalidError(PublisherFixture.BadTagRef).message])
            assert.deepEqual(cli.Lines, [])
        })
    })

    it('check succeeds for a free version and fails for a published one', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        await CliFixture.With(f, async cli =>
        {
            assert.equal(await cli.Run(...cli.CheckArgs()), 0)
            await f.Publisher().Publish(f.Input())
            assert.equal(await cli.Run(...cli.CheckArgs()), 1)
            assert.deepEqual(cli.Errors, [new ReleaseVersionExistsError(PublisherFixture.Version).message])
        })
    })

    it('publish prints the version and digests but no key material or token', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        await CliFixture.With(f, async cli =>
        {
            const code = await cli.Run(...cli.PublishArgs())
            assert.equal(code, 0)
            const stdout = cli.Lines.join('\n')
            assert.ok(stdout.includes(PublisherFixture.Version))
            assert.equal(cli.Lines.length, ReleaseApps.All.length + 2)
            assert.ok(!stdout.includes(PublisherFixture.Token))
            assert.ok(!PublisherFixture.Pem.test(stdout))
            assert.ok(!stdout.includes(f.Key.Private.split('\n')[1]))
            assert.deepEqual(cli.Errors, [])
        })
    })

    it('publish refuses a signing key the trusted public key does not verify, and pushes nothing', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        await CliFixture.With(f, async cli =>
        {
            cli.Trust(new KeyPair().Public)
            assert.equal(await cli.Run(...cli.PublishArgs()), 1)
            assert.deepEqual(cli.Errors, [new ReleaseSigningKeyMismatchError(PublisherFixture.KeyId).message])
            assert.deepEqual(cli.Lines, [])
            assert.ok(f.PushedNothing)
        })
    })

    it('publish refuses a key id with no trusted public key, and an unreadable trust directory, before any request', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        await CliFixture.With(f, async cli =>
        {
            assert.equal(await cli.Run(...cli.PublishArgsWith(CliFixture.FlagKeyId, Probe.ShippedKey)), 1)
            assert.ok(cli.Errors.pop()?.includes(Probe.ShippedKey + ReleaseTrustKeys.Suffix))
            assert.equal(await cli.Run(...cli.PublishArgsWith(CliFixture.FlagTrustDir, cli.Missing)), 1)
            const sentence = cli.Errors.pop() ?? ''
            assert.ok(sentence.includes(CliFixture.FlagTrustDir))
            assert.ok(!sentence.includes(CliFixture.NoOsError))
            assert.ok(!sentence.includes(cli.Missing))
            assert.equal(f.Registry.Requests.length, 0)
        })
    })

    it('defaults the trust directory to this checkout\'s release-keys, which holds the shipped key', () =>
    {
        const repo = resolve(dirname(fileURLToPath(import.meta.url)), Probe.RepoRoot)
        assert.equal(ReleasePublishCli.DefaultTrustDir, join(repo, ReleaseTrustKeys.DirName))
        assert.ok(existsSync(join(ReleasePublishCli.DefaultTrustDir, Probe.ShippedKey + ReleaseTrustKeys.Suffix)))
        assert.ok(ReleaseTrustKeys.FromDirectory(ReleasePublishCli.DefaultTrustDir).KeyFor(Probe.ShippedKey) !== undefined)
    })

    it('publish reports a missing image as an error sentence only', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages(ReleaseApp.EnvServer)
        await CliFixture.With(f, async cli =>
        {
            assert.equal(await cli.Run(...cli.PublishArgs()), 1)
            assert.deepEqual(cli.Errors, [new ReleaseImageMissingError(ReleaseApp.EnvServer, PublisherFixture.Version).message])
        })
    })

    it('treats empty optional environment variables as unset', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        await CliFixture.With(f, async cli =>
        {
            cli.Env.RELEASE_NAMESPACE = ''
            cli.Env.RELEASE_REGISTRY = ''
            assert.equal(await cli.Run(...cli.PublishArgs()), 0)
            assert.deepEqual(cli.Errors, [])
            assert.ok(f.Registry.Requests[0].url.startsWith(CliFixture.GhcrPrefix + PublisherFixture.Namespace + PublisherFixture.PathSeparator))
        })
    })

    it('rejects sibling files with bad names (separators, dot segments) or non-sha values with a clear sentence', async () =>
    {
        await CliFixture.With(new PublisherFixture(), async cli =>
        {
            const commit = PublisherFixture.SiblingCommit
            for (const body of [{ 'a/b': commit }, { '.': commit }, { '..': commit }, { todl: 'main' }, { todl: 7 }, ['x']])
            {
                writeFileSync(cli.SiblingsFile, JSON.stringify(body))
                cli.Errors.length = 0
                assert.equal(await cli.Run(...cli.PublishArgs()), 1)
                assert.equal(cli.Errors.length, 1)
                assert.ok(cli.Errors[0].includes(CliFixture.HexSentence), JSON.stringify(body))
            }
        })
    })

    it('names the flag or variable when the siblings or key file is unreadable', async () =>
    {
        await CliFixture.With(new PublisherFixture(), async cli =>
        {
            assert.equal(await cli.Run(...cli.PublishArgsWith(CliFixture.FlagSiblingsFile, cli.Missing)), 1)
            assert.ok(cli.Errors[0].includes(CliFixture.FlagSiblingsFile))
            assert.ok(!cli.Errors[0].includes(CliFixture.NoOsError))
            cli.Errors.length = 0
            cli.Env.RELEASE_SIGNING_KEY_FILE = cli.Missing
            assert.equal(await cli.Run(...cli.PublishArgs()), 1)
            assert.ok(cli.Errors[0].includes(CliFixture.KeyFileVar))
            assert.ok(!cli.Errors[0].includes(CliFixture.NoOsError))
        })
    })

    it('names each missing required flag and environment variable', async () =>
    {
        await CliFixture.With(new PublisherFixture(), async cli =>
        {
            assert.equal(await cli.Run(CliFixture.Publish, CliFixture.FlagTag, PublisherFixture.TagRef), 1)
            assert.equal(cli.Errors.pop(), 'Missing required option: --server-commit')
            delete cli.Env.RELEASE_REGISTRY_TOKEN
            assert.equal(await cli.Run(...cli.CheckArgs()), 1)
            assert.equal(cli.Errors.pop(), 'Missing required environment variable: ' + CliFixture.TokenVar)
            delete cli.Env.RELEASE_SIGNING_KEY_FILE
            assert.equal(await cli.Run(...cli.PublishArgs()), 1)
            assert.equal(cli.Errors.pop(), 'Missing required environment variable: ' + CliFixture.KeyFileVar)
        })
    })

    it('rejects unknown and duplicate flags', async () =>
    {
        await CliFixture.With(new PublisherFixture(), async cli =>
        {
            assert.equal(await cli.Run(...cli.CheckArgs(), CliFixture.FlagBogus, CliFixture.BogusValue), 1)
            assert.equal(cli.Errors.pop(), 'Unknown option: --bogus')
            assert.equal(await cli.Run(...cli.CheckArgs(), CliFixture.FlagTag, PublisherFixture.TagRef), 1)
            assert.equal(cli.Errors.pop(), 'Option given more than once: --tag')
        })
    })

    it('check refuses the publish-only options', async () =>
    {
        await CliFixture.With(new PublisherFixture(), async cli =>
        {
            const publishOnly: [string, string][] = [
                [CliFixture.FlagKeyId, PublisherFixture.KeyId],
                [CliFixture.FlagServerCommit, PublisherFixture.ServerCommit],
                [CliFixture.FlagSiblingsFile, cli.SiblingsFile],
                [CliFixture.FlagTrustDir, cli.TrustDir],
            ]
            for (const [flag, value] of publishOnly)
            {
                assert.equal(await cli.Run(...cli.CheckArgs(), flag, value), 1, flag)
                assert.equal(cli.Errors.pop(), 'Unknown option: ' + flag)
            }
        })
    })

    it('never writes the key PEM or token to stderr on failure paths', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages(ReleaseApp.EnvGateway)
        await CliFixture.With(f, async cli =>
        {
            await cli.Run(...cli.PublishArgs())
            await cli.Run(CliFixture.Publish, CliFixture.FlagTag, PublisherFixture.BadTagRef)
            await cli.Run(CliFixture.Bogus)
            cli.Env.RELEASE_SIGNING_KEY_FILE = cli.Missing
            await cli.Run(...cli.PublishArgs())
            assert.equal(cli.Errors.length, 4)
            const stderr = cli.Errors.join('\n')
            assert.ok(!stderr.includes(PublisherFixture.Token))
            assert.ok(!PublisherFixture.Pem.test(stderr))
            assert.ok(!stderr.includes(f.Key.Private.split('\n')[1]))
        })
    })

    it('imports only node builtins and relative modules, so it runs without npm install', () =>
    {
        const bin = resolve(dirname(fileURLToPath(import.meta.url)), Probe.CliBin)
        assert.ok(ImportWalker.Specifiers(bin).length > 0)
        assert.deepEqual(ImportWalker.Offenders(bin), [])
    })

    it('closure guard sees static, dynamic (quoted and template literal), re-export and require specifiers', () =>
    {
        const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), Probe.ImportsFile), 'utf8')
        assert.deepEqual(ImportWalker.SpecifiersOfText(text), Probe.Expected)
    })
})
