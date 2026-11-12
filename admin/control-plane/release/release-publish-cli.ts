import { readFileSync } from 'node:fs'
import { OciRegistryClient, type OciFetch } from '../oci-registry-client.js'
import { ReleaseDescriptorCodec } from './release-descriptor.js'
import { ReleasePublisher } from './release-publisher.js'
import { ReleaseTag } from './release-tag.js'

export type ReleaseCliOutput = { Out: (line: string) => void; Err: (line: string) => void }

class ReleaseCliUsageError extends Error
{
}

/**
 * `check --tag <ref>` and `publish --tag <ref> --server-commit <sha> --siblings-file <path> --key-id <id>`. Secrets come from
 * the environment (key file path, registry credential); only the version and digests are printed, failures print the error
 * sentence. Imports only node builtins and builtin-only relative modules: the release workflow runs it without npm install.
 */
export class ReleasePublishCli
{
    private static readonly CommandCheck = 'check'
    private static readonly CommandPublish = 'publish'
    private static readonly FlagPrefix = '--'
    private static readonly FlagTag = 'tag'
    private static readonly FlagServerCommit = 'server-commit'
    private static readonly FlagSiblingsFile = 'siblings-file'
    private static readonly FlagKeyId = 'key-id'
    private static readonly EnvKeyFile = 'RELEASE_SIGNING_KEY_FILE'
    private static readonly EnvUser = 'RELEASE_REGISTRY_USER'
    private static readonly EnvToken = 'RELEASE_REGISTRY_TOKEN'
    private static readonly EnvRegistry = 'RELEASE_REGISTRY'
    private static readonly EnvNamespace = 'RELEASE_NAMESPACE'
    private static readonly DefaultRegistry = 'ghcr.io'
    private static readonly DefaultNamespace = 'pragmatic-tech-ai'
    private static readonly SchemeMarker = '://'
    private static readonly HttpsScheme = 'https://'
    private static readonly Utf8 = 'utf8'
    private static readonly OkExitCode = 0
    private static readonly FailExitCode = 1
    private static readonly UsageMessage = 'Usage: pragmatic-release-publish check --tag <ref> | publish --tag <ref> --server-commit <sha> --siblings-file <path> --key-id <id>'
    private static readonly MissingFlagPrefix = 'Missing required option: --'
    private static readonly MissingEnvPrefix = 'Missing required environment variable: '
    private static readonly BadSiblingsMessage = 'The siblings file must be a JSON object mapping repository names to commit shas'
    private static readonly VersionLabel = 'version '
    private static readonly FreeSuffix = ' is free'
    private static readonly PublishedPrefix = 'published '
    private static readonly DescriptorLabel = 'descriptor '
    private static readonly ImageSeparator = ' '

    public static async Run(argv: readonly string[], env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch): Promise<number>
    {
        const S = ReleasePublishCli
        try
        {
            const command = argv[0]
            const flags = S.ParseFlags(argv.slice(1))
            if (command === S.CommandCheck)
            {
                await S.Check(flags, env, output, fetchFn)
            }
            else if (command === S.CommandPublish)
            {
                await S.Publish(flags, env, output, fetchFn)
            }
            else
            {
                throw new ReleaseCliUsageError(S.UsageMessage)
            }
            return S.OkExitCode
        }
        catch (err)
        {
            output.Err(err instanceof Error ? err.message : String(err))
            return S.FailExitCode
        }
    }

    private static async Check(flags: Map<string, string>, env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch): Promise<void>
    {
        const S = ReleasePublishCli
        const tag = ReleaseTag.Parse(S.Flag(flags, S.FlagTag))
        await S.NewPublisher(env, fetchFn).CheckVersionFree(tag.Version)
        output.Out(S.VersionLabel + tag.Version + S.FreeSuffix)
    }

    private static async Publish(flags: Map<string, string>, env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch): Promise<void>
    {
        const S = ReleasePublishCli
        const tag = ReleaseTag.Parse(S.Flag(flags, S.FlagTag))
        const serverCommit = S.Flag(flags, S.FlagServerCommit)
        const siblingCommits = S.ReadSiblings(S.Flag(flags, S.FlagSiblingsFile))
        const signingKeyId = S.Flag(flags, S.FlagKeyId)
        const privateKeyPem = readFileSync(S.Env(env, S.EnvKeyFile), S.Utf8)
        const descriptor = await S.NewPublisher(env, fetchFn).Publish({ tag, serverCommit, siblingCommits, signingKeyId, privateKeyPem })
        output.Out(S.PublishedPrefix + descriptor.version)
        for (const [app, image] of Object.entries(descriptor.images))
        {
            output.Out(app + S.ImageSeparator + image.digest)
        }
        output.Out(S.DescriptorLabel + OciRegistryClient.DigestOf(ReleaseDescriptorCodec.Encode(descriptor)))
    }

    private static NewPublisher(env: NodeJS.ProcessEnv, fetchFn?: OciFetch): ReleasePublisher
    {
        const S = ReleasePublishCli
        const host = env[S.EnvRegistry] ?? S.DefaultRegistry
        const baseUrl = host.includes(S.SchemeMarker) ? host : S.HttpsScheme + host
        const credential = { username: S.Env(env, S.EnvUser), token: S.Env(env, S.EnvToken) }
        const registry = new OciRegistryClient(baseUrl, fetchFn, credential)
        return new ReleasePublisher(registry, env[S.EnvNamespace] ?? S.DefaultNamespace)
    }

    private static ReadSiblings(path: string): Record<string, string>
    {
        const S = ReleasePublishCli
        let parsed: unknown
        try
        {
            parsed = JSON.parse(readFileSync(path, S.Utf8))
        }
        catch
        {
            throw new ReleaseCliUsageError(S.BadSiblingsMessage)
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        {
            throw new ReleaseCliUsageError(S.BadSiblingsMessage)
        }
        return parsed as Record<string, string>
    }

    private static ParseFlags(args: readonly string[]): Map<string, string>
    {
        const S = ReleasePublishCli
        const flags = new Map<string, string>()
        for (let i = 0; i < args.length; i++)
        {
            const arg = args[i]
            if (!arg.startsWith(S.FlagPrefix) || i + 1 >= args.length)
            {
                throw new ReleaseCliUsageError(S.UsageMessage)
            }
            flags.set(arg.slice(S.FlagPrefix.length), args[++i])
        }
        return flags
    }

    private static Flag(flags: Map<string, string>, name: string): string
    {
        const value = flags.get(name)
        if (value === undefined || value.length === 0)
        {
            throw new ReleaseCliUsageError(ReleasePublishCli.MissingFlagPrefix + name)
        }
        return value
    }

    private static Env(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value.length === 0)
        {
            throw new ReleaseCliUsageError(ReleasePublishCli.MissingEnvPrefix + name)
        }
        return value
    }
}
