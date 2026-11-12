import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OciRegistryClient } from '../../oci-registry-client.js'
import { FakeOciRegistry } from '../../tests/fake-oci-registry.js'
import { ReleaseDescriptorCodec } from '../release-descriptor.js'
import { ReleasePublishCli } from '../release-publish-cli.js'
import { ReleaseImageMissingError, ReleasePublisher, ReleaseVersionExistsError } from '../release-publisher.js'
import { ReleaseSignature } from '../release-signature.js'
import { ReleaseApp, ReleaseApps, ReleaseTag, ReleaseTagInvalidError } from '../release-tag.js'

class PublisherFixture
{
    public static readonly Namespace = 'pragmatic-tech-ai'
    public static readonly Version = '1.4.0'
    public static readonly TagRef = 'refs/tags/release/1.4.0'
    public static readonly KeyId = 'release-2026'
    public static readonly Token = 'ghp_super_secret_token'
    public static readonly User = 'release-bot'
    public static readonly ServerCommit = 'a'.repeat(40)
    public static readonly SiblingCommit = 'b'.repeat(40)
    public static readonly SiblingRepo = 'todl'
    public static readonly ManifestType = 'application/vnd.oci.image.manifest.v1+json'
    public static readonly BuiltAt = '2026-11-12T10:00:00.000Z'
    public static readonly DescriptorPath = '/manifests/' + PublisherFixture.Version
    public static readonly Pem = /-----BEGIN/

    public readonly Registry = new FakeOciRegistry()
    public readonly Private: string
    public readonly Public: string

    public constructor()
    {
        const pair = generateKeyPairSync('ed25519')
        this.Private = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        this.Public = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }

    public SeedImages(skip?: ReleaseApp): void
    {
        for (const app of ReleaseApps.All)
        {
            if (app !== skip)
            {
                const bytes = new TextEncoder().encode('image ' + app)
                this.Registry.PutManifest(PublisherFixture.Namespace + '/' + app, PublisherFixture.Version, bytes, PublisherFixture.ManifestType)
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
            privateKeyPem: this.Private,
        }
    }
}

class CliFixture
{
    public readonly Dir = mkdtempSync(join(tmpdir(), 'release-cli-'))
    public readonly Lines: string[] = []
    public readonly Errors: string[] = []
    public readonly Env: NodeJS.ProcessEnv

    public constructor(public readonly Base: PublisherFixture)
    {
        const keyFile = join(this.Dir, 'key.pem')
        writeFileSync(keyFile, Base.Private)
        writeFileSync(this.SiblingsFile, JSON.stringify({ [PublisherFixture.SiblingRepo]: PublisherFixture.SiblingCommit }))
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
        return join(this.Dir, 'siblings.json')
    }

    public PublishArgs(): string[]
    {
        return ['publish', '--tag', PublisherFixture.TagRef, '--server-commit', PublisherFixture.ServerCommit,
            '--siblings-file', this.SiblingsFile, '--key-id', PublisherFixture.KeyId]
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
}

class ImportWalker
{
    private static readonly ImportPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
    private static readonly NodePrefix = 'node:'
    private static readonly RelativePrefix = '.'
    private static readonly JsExtension = /\.js$/
    private static readonly TsExtension = '.ts'

    /** Every module specifier reachable from the file through relative imports. */
    public static Specifiers(entry: string): string[]
    {
        const S = ImportWalker
        const seen = new Set<string>()
        const specifiers: string[] = []
        const queue = [entry]
        while (queue.length > 0)
        {
            const file = queue.pop() as string
            if (seen.has(file))
            {
                continue
            }
            seen.add(file)
            for (const specifier of S.SpecifiersOfText(readFileSync(file, 'utf8')))
            {
                specifiers.push(specifier)
                if (specifier.startsWith(S.RelativePrefix))
                {
                    queue.push(resolve(dirname(file), specifier.replace(S.JsExtension, S.TsExtension)))
                }
            }
        }
        return specifiers
    }

    /** Every module specifier in a source text, static, dynamic, re-exported or required. */
    public static SpecifiersOfText(text: string): string[]
    {
        return [...text.matchAll(ImportWalker.ImportPattern)].map(m => m[1])
    }

    public static IsBuiltinOrRelative(specifier: string): boolean
    {
        return specifier.startsWith(ImportWalker.NodePrefix) || specifier.startsWith(ImportWalker.RelativePrefix)
    }
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
        const pulled = await client.PullArtifactLayer(PublisherFixture.Namespace + '/' + ReleasePublisher.DescriptorRepository, PublisherFixture.Version)
        const decoded = ReleaseDescriptorCodec.Decode(pulled.layer)
        assert.deepEqual(decoded, descriptor)
        assert.equal(decoded.signingKeyId, PublisherFixture.KeyId)
        for (const app of ReleaseApps.All)
        {
            const image = decoded.images[app]
            assert.equal(image.repository, PublisherFixture.Namespace + '/' + app)
            assert.equal(image.digest, FakeOciRegistry.DigestOf(new TextEncoder().encode('image ' + app)))
            assert.ok(ReleaseSignature.Verifies(image.digest, image.signature, f.Public))
        }
        assert.equal(pulled.layerDigest, descriptorDigest)
        assert.equal(pulled.layerDigest, OciRegistryClient.DigestOf(ReleaseDescriptorCodec.Encode(decoded)))
        assert.ok(ReleaseSignature.Verifies(pulled.layerDigest, pulled.annotations[ReleasePublisher.SignatureAnnotation], f.Public))
        assert.equal(pulled.annotations[ReleasePublisher.KeyAnnotation], PublisherFixture.KeyId)
    })

    it('makes the descriptor manifest push the last registry request', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        await f.Publisher().Publish(f.Input())
        const last = f.Registry.Requests[f.Registry.Requests.length - 1]
        assert.equal(last.method, 'PUT')
        assert.ok(last.url.endsWith('/' + ReleasePublisher.DescriptorRepository + PublisherFixture.DescriptorPath))
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
        assert.ok(f.Registry.Requests.every(r => r.method === 'HEAD'))
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
        const cli = new CliFixture(new PublisherFixture())
        try
        {
            const code = await cli.Run('check', '--tag', 'release/1.4')
            assert.equal(code, 1)
            assert.deepEqual(cli.Errors, [new ReleaseTagInvalidError('release/1.4').message])
            assert.deepEqual(cli.Lines, [])
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('check succeeds for a free version and fails for a published one', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        const cli = new CliFixture(f)
        try
        {
            assert.equal(await cli.Run('check', '--tag', PublisherFixture.TagRef), 0)
            await f.Publisher().Publish(f.Input())
            assert.equal(await cli.Run('check', '--tag', PublisherFixture.TagRef), 1)
            assert.deepEqual(cli.Errors, [new ReleaseVersionExistsError(PublisherFixture.Version).message])
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('publish prints the version and digests but no key material or token', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        const cli = new CliFixture(f)
        try
        {
            const code = await cli.Run('publish', '--tag', PublisherFixture.TagRef, '--server-commit', PublisherFixture.ServerCommit,
                '--siblings-file', cli.SiblingsFile, '--key-id', PublisherFixture.KeyId)
            assert.equal(code, 0)
            const stdout = cli.Lines.join('\n')
            assert.ok(stdout.includes(PublisherFixture.Version))
            assert.equal(cli.Lines.length, ReleaseApps.All.length + 2)
            assert.ok(!stdout.includes(PublisherFixture.Token))
            assert.ok(!PublisherFixture.Pem.test(stdout))
            assert.ok(!stdout.includes(f.Private.split('\n')[1]))
            assert.deepEqual(cli.Errors, [])
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('publish reports a missing image as an error sentence only', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages(ReleaseApp.EnvServer)
        const cli = new CliFixture(f)
        try
        {
            const code = await cli.Run('publish', '--tag', PublisherFixture.TagRef, '--server-commit', PublisherFixture.ServerCommit,
                '--siblings-file', cli.SiblingsFile, '--key-id', PublisherFixture.KeyId)
            assert.equal(code, 1)
            assert.deepEqual(cli.Errors, [new ReleaseImageMissingError(ReleaseApp.EnvServer, PublisherFixture.Version).message])
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('treats empty optional environment variables as unset', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages()
        const cli = new CliFixture(f)
        try
        {
            cli.Env.RELEASE_NAMESPACE = ''
            cli.Env.RELEASE_REGISTRY = ''
            assert.equal(await cli.Run(...cli.PublishArgs()), 0)
            assert.deepEqual(cli.Errors, [])
            assert.ok(f.Registry.Requests[0].url.startsWith('https://ghcr.io/v2/' + PublisherFixture.Namespace + '/'))
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('rejects sibling files with bad names or non-sha values with a clear sentence', async () =>
    {
        const cli = new CliFixture(new PublisherFixture())
        try
        {
            for (const body of [{ 'a/b': 'c'.repeat(40) }, { todl: 'main' }, { todl: 7 }, ['x']])
            {
                writeFileSync(cli.SiblingsFile, JSON.stringify(body))
                cli.Errors.length = 0
                assert.equal(await cli.Run(...cli.PublishArgs()), 1)
                assert.equal(cli.Errors.length, 1)
                assert.ok(cli.Errors[0].includes('40-hex'))
            }
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('names the flag or variable when the siblings or key file is unreadable', async () =>
    {
        const cli = new CliFixture(new PublisherFixture())
        try
        {
            const missing = join(cli.Dir, 'nope')
            const args = cli.PublishArgs()
            args[args.indexOf('--siblings-file') + 1] = missing
            assert.equal(await cli.Run(...args), 1)
            assert.ok(cli.Errors[0].includes('--siblings-file'))
            assert.ok(!cli.Errors[0].includes('ENOENT'))
            cli.Errors.length = 0
            cli.Env.RELEASE_SIGNING_KEY_FILE = missing
            assert.equal(await cli.Run(...cli.PublishArgs()), 1)
            assert.ok(cli.Errors[0].includes('RELEASE_SIGNING_KEY_FILE'))
            assert.ok(!cli.Errors[0].includes('ENOENT'))
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('names each missing required flag and environment variable', async () =>
    {
        const cli = new CliFixture(new PublisherFixture())
        try
        {
            assert.equal(await cli.Run('publish', '--tag', PublisherFixture.TagRef), 1)
            assert.equal(cli.Errors.pop(), 'Missing required option: --server-commit')
            delete cli.Env.RELEASE_REGISTRY_TOKEN
            assert.equal(await cli.Run('check', '--tag', PublisherFixture.TagRef), 1)
            assert.equal(cli.Errors.pop(), 'Missing required environment variable: RELEASE_REGISTRY_TOKEN')
            delete cli.Env.RELEASE_SIGNING_KEY_FILE
            assert.equal(await cli.Run(...cli.PublishArgs()), 1)
            assert.equal(cli.Errors.pop(), 'Missing required environment variable: RELEASE_SIGNING_KEY_FILE')
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('rejects unknown and duplicate flags', async () =>
    {
        const cli = new CliFixture(new PublisherFixture())
        try
        {
            assert.equal(await cli.Run('check', '--tag', PublisherFixture.TagRef, '--bogus', 'x'), 1)
            assert.equal(cli.Errors.pop(), 'Unknown option: --bogus')
            assert.equal(await cli.Run('check', '--tag', PublisherFixture.TagRef, '--tag', PublisherFixture.TagRef), 1)
            assert.equal(cli.Errors.pop(), 'Option given more than once: --tag')
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('never writes the key PEM or token to stderr on failure paths', async () =>
    {
        const f = new PublisherFixture()
        f.SeedImages(ReleaseApp.EnvGateway)
        const cli = new CliFixture(f)
        try
        {
            await cli.Run(...cli.PublishArgs())
            await cli.Run('publish', '--tag', 'release/1.4')
            await cli.Run('bogus')
            cli.Env.RELEASE_SIGNING_KEY_FILE = join(cli.Dir, 'nope')
            await cli.Run(...cli.PublishArgs())
            assert.equal(cli.Errors.length, 4)
            const stderr = cli.Errors.join('\n')
            assert.ok(!stderr.includes(PublisherFixture.Token))
            assert.ok(!PublisherFixture.Pem.test(stderr))
            assert.ok(!stderr.includes(f.Private.split('\n')[1]))
        }
        finally
        {
            cli.Dispose()
        }
    })

    it('imports only node builtins and relative modules, so it runs without npm install', () =>
    {
        const bin = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/pragmatic-release-publish.ts')
        const specifiers = ImportWalker.Specifiers(bin)
        assert.ok(specifiers.length > 0)
        const offenders = specifiers.filter(s => !ImportWalker.IsBuiltinOrRelative(s))
        assert.deepEqual(offenders, [])
    })

    it('closure guard sees static, dynamic, re-export and require specifiers', () =>
    {
        const text = "import a from 'x1'\nimport 'x2'\nexport { b } from 'x3'\nconst c = await import('x4')\nconst d = require('x5')"
        assert.deepEqual(ImportWalker.SpecifiersOfText(text), ['x1', 'x2', 'x3', 'x4', 'x5'])
    })
})
