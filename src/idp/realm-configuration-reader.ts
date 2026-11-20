import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationValidator, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { AppliedConfigurationCodec, ConfigurationRuntimeReader, ConfigurationStartError, ConfigurationStartReason, RuntimeConfiguration, type SecretStoreDirectory, type SecretValue } from '@pragmatic-tech-ai/pragmatic-configuration';

/** The secrets home a realm's references resolve through (its `realm` and `file` stores). */
export interface IRealmSecretsHome
{
    DirectoryFor(realm: string): Promise<SecretStoreDirectory>;
}

/** One realm's configuration as read at start: the realm, the display name the bootstrap file may give, the settings. */
export class RealmConfiguration
{
    public constructor(
        public readonly RealmId: string,
        public readonly DisplayName: string | undefined,
        public readonly Configuration: RuntimeConfiguration)
    {
        Object.freeze(this);
    }
}

/** Two configuration files name the same realm. */
export class DuplicateRealmConfigurationError extends Error
{
    private static readonly ErrorName = 'DuplicateRealmConfigurationError';
    private static readonly Prefix = 'two configuration files name the realm ';

    public constructor(realm: string)
    {
        super(DuplicateRealmConfigurationError.Prefix + realm);
        this.name = DuplicateRealmConfigurationError.ErrorName;
    }
}

/**
 * Reads the realms' configurations at start. The configuration directory holds one applied-configuration file per
 * realm (the `pragmatic-config-pragmatic-tenant-idp` ConfigMap of each realm, or several keys of one); each is read
 * through pragmatic-configuration's `ConfigurationRuntimeReader` (component and descriptor digest checked, document
 * validated, secret references resolved through the realm's secrets home), the realm taken from the applied object. The
 * bootstrap realm file is the platform's path (no tenant admin console authors the central realm): `{ realm,
 * displayName, configuration }`, the document validated against this container's own descriptor. Nothing is logged;
 * errors never carry a secret value.
 */
export class RealmConfigurationReader
{
    private static readonly JsonSuffix = '.json';
    private static readonly NotFound = 'ENOENT';
    private static readonly Utf8 = 'utf8';
    private static readonly RealmField = 'realm';
    private static readonly DisplayNameField = 'displayName';
    private static readonly ConfigurationField = 'configuration';
    private static readonly BootstrapVersion = 0;
    private static readonly WhereSeparator = '.';
    private static readonly NoRealm = '';
    private static readonly ErrorSeparator = '; ';
    private static readonly MalformedBootstrap = 'the bootstrap realm file must be { realm, displayName?, configuration }: ';
    private static readonly InvalidBootstrap = 'the bootstrap realm configuration does not validate: ';
    private static readonly UnreadableBootstrap = 'cannot read the bootstrap realm file ';

    public constructor(private readonly descriptor: ComponentDescriptor, private readonly secrets: IRealmSecretsHome)
    {
    }

    /** Every realm configuration in `directory` (none when it does not exist), in file-name order. */
    public async ReadDirectory(directory: string): Promise<readonly RealmConfiguration[]>
    {
        let names: string[];
        try
        {
            names = (await readdir(directory, { withFileTypes: true }))
                .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(RealmConfigurationReader.JsonSuffix))
                .map(entry => entry.name)
                .sort();
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === RealmConfigurationReader.NotFound)
            {
                return [];
            }
            throw err;
        }
        const realms: RealmConfiguration[] = [];
        for (const name of names)
        {
            realms.push(await this.ReadApplied(join(directory, name)));
        }
        return RealmConfigurationReader.Unique(realms);
    }

    /** One applied-configuration file. */
    public async ReadApplied(path: string): Promise<RealmConfiguration>
    {
        let realm: string;
        try
        {
            realm = AppliedConfigurationCodec.Decode(await readFile(path, RealmConfigurationReader.Utf8)).Realm;
        }
        catch
        {
            // The reader reports the file's fault (missing, unreadable, malformed) in its own words.
            realm = RealmConfigurationReader.NoRealm;
        }
        const reader = new ConfigurationRuntimeReader(this.descriptor, await this.secrets.DirectoryFor(realm));
        return new RealmConfiguration(realm, undefined, await reader.Read(path));
    }

    /** The bootstrap realm file. */
    public async ReadBootstrap(path: string): Promise<RealmConfiguration>
    {
        const R = RealmConfigurationReader;
        let parsed: unknown;
        try
        {
            parsed = JSON.parse(await readFile(path, R.Utf8));
        }
        catch (err)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.Unreadable, R.UnreadableBootstrap + path + R.ErrorSeparator + String((err as NodeJS.ErrnoException).code ?? (err as Error).name));
        }
        const fields = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
        const realm = fields?.[R.RealmField];
        const displayName = fields?.[R.DisplayNameField];
        if (fields === undefined || typeof realm !== 'string' || realm === R.NoRealm || (displayName !== undefined && typeof displayName !== 'string'))
        {
            throw new ConfigurationStartError(ConfigurationStartReason.Malformed, R.MalformedBootstrap + path);
        }
        const validation = new ConfigurationValidator(this.descriptor).Validate(fields[R.ConfigurationField]);
        if (validation.Configuration === undefined)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.Invalid, R.InvalidBootstrap + validation.Errors.map(error => error.toString()).join(R.ErrorSeparator));
        }
        const directory = await this.secrets.DirectoryFor(realm);
        const secrets = new Map<string, SecretValue>();
        for (const secret of validation.Configuration.SecretReferences())
        {
            const where = secret.Option + R.WhereSeparator + secret.Setting;
            secrets.set(RuntimeConfiguration.SecretKey(secret.Option, secret.Setting), await directory.Resolve(secret.Reference, where));
        }
        const configuration = new RuntimeConfiguration(R.BootstrapVersion, this.descriptor.Version, this.descriptor.ContentDigest(), validation.Configuration, secrets);
        return new RealmConfiguration(realm, displayName === R.NoRealm ? undefined : displayName, configuration);
    }

    /** The realms of `configurations`, refusing one named twice. */
    public static Unique(configurations: readonly RealmConfiguration[]): readonly RealmConfiguration[]
    {
        const seen = new Set<string>();
        for (const configuration of configurations)
        {
            if (seen.has(configuration.RealmId))
            {
                throw new DuplicateRealmConfigurationError(configuration.RealmId);
            }
            seen.add(configuration.RealmId);
        }
        return configurations;
    }
}
