import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { K8sObject } from './k8s-manifest-builder.js'
import type { IKubectl } from './kubectl.js'

interface EnvSecretEntry
{
    name: string
    data: Map<string, Buffer>
}

/** The env server's master/provisioned + postgres Secrets. Bytes live in a #private field; the only exit is RenderManifest(). */
export class EnvServerSecretSet
{
    private static readonly ApiVersion = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly OpaqueType = 'Opaque'
    private static readonly Base64 = 'base64'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly TypeKey = 'type'
    private static readonly DataKey = 'data'
    private static readonly Redacted = '[EnvServerSecretSet: values redacted]'

    #entries: EnvSecretEntry[] = []

    public constructor(private readonly namespace: string)
    {
    }

    public Add(name: string, data: Map<string, Buffer>): void
    {
        // Defensive copy: later caller mutation must not change the secret set's bytes.
        const copy = new Map<string, Buffer>([...data].map(([k, v]) => [k, Buffer.from(v)]))
        this.#entries.push({ name, data: copy })
    }

    public Names(): string[]
    {
        return this.#entries.map(e => e.name)
    }

    /** One v1 Secret object per entry (base64 `data`) in the environment namespace. */
    public RenderManifest(): K8sObject[]
    {
        return this.#entries.map(e => ({
            [EnvServerSecretSet.ApiVersionKey]: EnvServerSecretSet.ApiVersion,
            [EnvServerSecretSet.KindKey]: EnvServerSecretSet.SecretKind,
            [EnvServerSecretSet.MetadataKey]: { [EnvServerSecretSet.NameKey]: e.name, [EnvServerSecretSet.NamespaceKey]: this.namespace },
            [EnvServerSecretSet.TypeKey]: EnvServerSecretSet.OpaqueType,
            [EnvServerSecretSet.DataKey]: Object.fromEntries([...e.data].map(([k, v]) => [k, v.toString(EnvServerSecretSet.Base64)])),
        }))
    }

    public toJSON(): string
    {
        return EnvServerSecretSet.Redacted
    }

    public toString(): string
    {
        return EnvServerSecretSet.Redacted
    }
}

/**
 * Control-plane seed source for an in-cluster environment server: reads a generated boot bundle and yields the non-secret
 * tenants ConfigMap plus a secret-safe Secret set. Secret values exit only via EnvServerSecretSet.RenderManifest().
 * Also the single home of the ConfigMap/Secret name scheme.
 */
export class EnvServerSeedSource
{
    public static readonly Redacted = '[EnvServerSeedSource: values redacted]'
    public static readonly MasterKeyFile = 'master.key'
    public static readonly SecretsFile = 'provisioned-secrets.json'
    public static readonly TenantsFile = 'tenants.json'
    public static readonly SecretNameSuffix = '-env-secrets'
    public static readonly ConfigMapNameSuffix = '-tenants'
    public static readonly PasswordKey = 'password'
    private static readonly ApiVersion = 'v1'
    private static readonly ListKind = 'List'
    private static readonly ItemsKey = 'items'
    private static readonly ConfigMapKind = 'ConfigMap'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly DataKey = 'data'
    private static readonly Utf8 = 'utf8'
    private static readonly MissingRefPrefix = 'provisioned-secrets.json has no entry for db password ref: '

    public constructor(private readonly bundleDir: string, private readonly environmentName: string, private readonly dbPasswordRef?: string)
    {
    }

    /** Name of the master/provisioned Secret: `<env>-env-secrets`. */
    public static SecretNameOf(environmentName: string): string
    {
        return `${environmentName}${EnvServerSeedSource.SecretNameSuffix}`
    }

    /** Name of the tenants ConfigMap: `<env>-tenants`. */
    public static ConfigMapNameOf(environmentName: string): string
    {
        return `${environmentName}${EnvServerSeedSource.ConfigMapNameSuffix}`
    }

    /** Name of the postgres password Secret: the db password ref itself (what DatabaseStatefulSet consumes). */
    public static DbSecretNameOf(dbPasswordRef: string): string
    {
        return dbPasswordRef
    }

    /** The non-secret tenants ConfigMap (data key `tenants.json` = the file text). */
    public ConfigMapManifest(): K8sObject
    {
        return {
            [EnvServerSeedSource.ApiVersionKey]: EnvServerSeedSource.ApiVersion,
            [EnvServerSeedSource.KindKey]: EnvServerSeedSource.ConfigMapKind,
            [EnvServerSeedSource.MetadataKey]: {
                [EnvServerSeedSource.NameKey]: EnvServerSeedSource.ConfigMapNameOf(this.environmentName),
                [EnvServerSeedSource.NamespaceKey]: this.Namespace(),
            },
            [EnvServerSeedSource.DataKey]: { [EnvServerSeedSource.TenantsFile]: this.ReadText(EnvServerSeedSource.TenantsFile) },
        }
    }

    public SecretSet(): EnvServerSecretSet
    {
        const set = new EnvServerSecretSet(this.Namespace())
        const secretsText = this.ReadBytes(EnvServerSeedSource.SecretsFile)
        set.Add(EnvServerSeedSource.SecretNameOf(this.environmentName), new Map([
            [EnvServerSeedSource.MasterKeyFile, this.ReadBytes(EnvServerSeedSource.MasterKeyFile)],
            [EnvServerSeedSource.SecretsFile, secretsText],
        ]))
        if (this.dbPasswordRef !== undefined)
        {
            const secrets = JSON.parse(secretsText.toString(EnvServerSeedSource.Utf8)) as Record<string, string>
            const value = secrets[this.dbPasswordRef]
            if (value === undefined)
            {
                throw new Error(`${EnvServerSeedSource.MissingRefPrefix}${this.dbPasswordRef}`)
            }
            set.Add(EnvServerSeedSource.DbSecretNameOf(this.dbPasswordRef), new Map([
                [EnvServerSeedSource.PasswordKey, Buffer.from(value, EnvServerSeedSource.Utf8)],
            ]))
        }
        return set
    }

    public toJSON(): string
    {
        return EnvServerSeedSource.Redacted
    }

    public toString(): string
    {
        return EnvServerSeedSource.Redacted
    }

    private Namespace(): string
    {
        return K8sManifestBuilder.NamespaceOf(this.environmentName)
    }

    private ReadBytes(file: string): Buffer
    {
        return readFileSync(join(this.bundleDir, file))
    }

    private ReadText(file: string): string
    {
        return this.ReadBytes(file).toString(EnvServerSeedSource.Utf8)
    }

    /**
     * Applies the env-server seed (tenants ConfigMap + master/provisioned Secrets, and the db-password Secret when a
     * ref is given) from a generated bundle as one v1 List. The single home for the seed manifest: InClusterEnvironmentRuntime.BringUp
     * and the gated orchestrator smokes both route through here so a change can never drift between production and the smokes.
     * The applied JSON carries base64 secret values transiently; it is handed only to kubectl and is never logged.
     */
    public static async ApplyBundle(kubectl: IKubectl, bundleDir: string, environmentName: string, dbPasswordRef?: string): Promise<void>
    {
        const seed = new EnvServerSeedSource(bundleDir, environmentName, dbPasswordRef)
        const list = {
            [EnvServerSeedSource.ApiVersionKey]: EnvServerSeedSource.ApiVersion,
            [EnvServerSeedSource.KindKey]: EnvServerSeedSource.ListKind,
            [EnvServerSeedSource.ItemsKey]: [seed.ConfigMapManifest(), ...seed.SecretSet().RenderManifest()],
        }
        await kubectl.Apply(JSON.stringify(list))
    }
}
