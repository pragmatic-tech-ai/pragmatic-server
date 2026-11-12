import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OciRegistryClient, type OciFetch, type RegistryCredential } from '../oci-registry-client.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { ReleaseCatalog } from './release-catalog.js'
import { ReleasePoll } from './release-poll.js'
import { ReleaseRefresher } from './release-refresher.js'
import { ReleaseRegistry } from './release-registry.js'
import { ReleaseTrustKeyInvalidError, ReleaseTrustKeys } from './release-trust-keys.js'

/** A release setting is unusable. The sentence names only the variable: never its value or a file's contents. */
export class ReleaseConfigError extends Error
{
    private static readonly ErrorName = 'ReleaseConfigError'

    public constructor(message: string)
    {
        super(message)
        this.name = ReleaseConfigError.ErrorName
    }
}

/** The platform-admin release services: the single-flight refresher, and its poll unless the poll is off. */
export interface IReleaseServices
{
    Refresher: ReleaseRefresher
    Poll: ReleasePoll | undefined
}

/**
 * Reads the release settings from the environment and composes the catalogue over them. No credential file means no
 * catalogue (the refresh route then answers 409). Every refusal is a sentence naming the variable alone.
 */
export class ReleaseCatalogConfig
{
    public static readonly CredentialFileEnvVar = 'PRAGMATIC_RELEASE_CREDENTIAL_FILE'
    public static readonly RegistryEnvVar = 'PRAGMATIC_RELEASE_REGISTRY'
    public static readonly NamespaceEnvVar = 'PRAGMATIC_RELEASE_NAMESPACE'
    public static readonly TrustDirEnvVar = 'PRAGMATIC_RELEASE_TRUST_DIR'
    public static readonly PollSecondsEnvVar = 'PRAGMATIC_RELEASE_POLL_SECONDS'
    public static readonly DefaultPollSeconds = 300
    /** The trust directory under the repository root (the image places it beside the compiled control plane the same way). */
    public static readonly TrustDirName = 'release-keys'
    /** setInterval holds at most 2^31-1 ms; anything longer would fire at once. */
    private static readonly MaxPollSeconds = 2147483
    private static readonly MsPerSecond = 1000
    private static readonly WholeNumber = /^[0-9]+$/
    private static readonly HttpsProtocol = 'https:'
    private static readonly HttpProtocol = 'http:'
    /** The only hosts a plain-http registry may name: the credential never leaves the machine in clear. */
    private static readonly LoopbackHosts: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])
    private static readonly Utf8 = 'utf8'
    private static readonly BadPollMessage = ReleaseCatalogConfig.PollSecondsEnvVar + ' must be a whole number of seconds from 0 to '
        + String(ReleaseCatalogConfig.MaxPollSeconds) + ' (0 turns the poll off)'
    private static readonly BadCredentialMessage = ReleaseCatalogConfig.CredentialFileEnvVar + ' must name a readable JSON file holding { "username": "...", "token": "..." }'
    private static readonly BadRegistryMessage = ReleaseCatalogConfig.RegistryEnvVar + ' must be an absolute https URL (http only for a loopback registry)'
    private static readonly BadTrustDirMessage = ReleaseCatalogConfig.TrustDirEnvVar + ' must name a readable directory of release public keys'

    /** Composes the release services, or undefined when no credential file is configured. The poll interval is always validated. */
    public static Compose(env: NodeJS.ProcessEnv, repoRoot: string, deployments: PlatformDeploymentRegistry, fetchFn?: OciFetch): IReleaseServices | undefined
    {
        const C = ReleaseCatalogConfig
        const pollSeconds = C.PollSecondsOf(env)
        const credential = C.CredentialOf(env)
        if (credential === undefined)
        {
            return undefined
        }
        const registry = new OciRegistryClient(C.RegistryOf(env), fetchFn, credential)
        const catalog = new ReleaseCatalog(registry, C.ValueOr(env, C.NamespaceEnvVar, ReleaseRegistry.DefaultNamespace), C.TrustOf(env, repoRoot), deployments)
        const refresher = new ReleaseRefresher(catalog)
        const poll = pollSeconds === 0 ? undefined : new ReleasePoll(refresher, pollSeconds * C.MsPerSecond)
        return { Refresher: refresher, Poll: poll }
    }

    /** The poll interval in seconds: 300 when unset or blank, 0 when off; anything but a whole number in range is refused. */
    public static PollSecondsOf(env: NodeJS.ProcessEnv): number
    {
        const C = ReleaseCatalogConfig
        const raw = env[C.PollSecondsEnvVar]
        if (raw === undefined || raw === '')
        {
            return C.DefaultPollSeconds
        }
        const seconds = Number(raw)
        if (!C.WholeNumber.test(raw) || seconds > C.MaxPollSeconds)
        {
            throw new ReleaseConfigError(C.BadPollMessage)
        }
        return seconds
    }

    /** The registry credential from the JSON file the variable names; undefined when the variable is unset or blank. */
    public static CredentialOf(env: NodeJS.ProcessEnv): RegistryCredential | undefined
    {
        const C = ReleaseCatalogConfig
        const file = env[C.CredentialFileEnvVar]
        if (file === undefined || file === '')
        {
            return undefined
        }
        let parsed: unknown
        try
        {
            parsed = JSON.parse(readFileSync(file, C.Utf8))
        }
        catch
        {
            // Neither the read error (it names the path) nor the parse error (it can quote the file) is passed on.
            throw new ReleaseConfigError(C.BadCredentialMessage)
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        {
            throw new ReleaseConfigError(C.BadCredentialMessage)
        }
        const { username, token } = parsed as Record<string, unknown>
        if (typeof username !== 'string' || username === '' || typeof token !== 'string' || token === '')
        {
            throw new ReleaseConfigError(C.BadCredentialMessage)
        }
        return { username, token }
    }

    private static RegistryOf(env: NodeJS.ProcessEnv): string
    {
        const C = ReleaseCatalogConfig
        const raw = C.ValueOr(env, C.RegistryEnvVar, ReleaseRegistry.DefaultBaseUrl)
        let url: URL
        try
        {
            url = new URL(raw)
        }
        catch
        {
            throw new ReleaseConfigError(C.BadRegistryMessage)
        }
        if (url.protocol === C.HttpsProtocol || (url.protocol === C.HttpProtocol && C.LoopbackHosts.has(url.hostname)))
        {
            return raw
        }
        throw new ReleaseConfigError(C.BadRegistryMessage)
    }

    private static TrustOf(env: NodeJS.ProcessEnv, repoRoot: string): ReleaseTrustKeys
    {
        const C = ReleaseCatalogConfig
        const dir = C.ValueOr(env, C.TrustDirEnvVar, join(repoRoot, C.TrustDirName))
        try
        {
            return ReleaseTrustKeys.FromDirectory(dir)
        }
        catch (err)
        {
            // An invalid key file names its key id only; an unreadable directory is refused without its path.
            if (err instanceof ReleaseTrustKeyInvalidError)
            {
                throw err
            }
            throw new ReleaseConfigError(C.BadTrustDirMessage)
        }
    }

    private static ValueOr(env: NodeJS.ProcessEnv, name: string, fallback: string): string
    {
        const raw = env[name]
        return raw === undefined || raw === '' ? fallback : raw
    }
}
