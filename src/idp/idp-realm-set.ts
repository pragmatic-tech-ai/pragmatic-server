import type { IdpRealm } from './idp-realm.js';
import type { RealmConfiguration } from './realm-configuration-reader.js';
import { RealmSettings } from './realm-settings.js';
import type { SqlIdpRealmCatalogue } from './sql-idp-realm-catalogue.js';

/** Thrown when a realm id is reserved or malformed. */
export class ReservedRealmError extends Error
{
    private static readonly MessagePrefix = 'Reserved or invalid realm id: ';
    private static readonly ErrorName = 'ReservedRealmError';
    private static readonly MaxKeyChars = 64;

    public constructor(key: string)
    {
        super(ReservedRealmError.MessagePrefix + JSON.stringify(key.slice(0, ReservedRealmError.MaxKeyChars)));
        this.name = ReservedRealmError.ErrorName;
    }
}

/** Opens a realm from its settings (its issuer, stores and sources). */
export interface IRealmOpener
{
    Open(settings: RealmSettings): Promise<IdpRealm>;
}

/**
 * The realms the service serves, by id: every realm of the catalogue (the admin API created them) and every realm a
 * configuration names (recorded in the catalogue at start). A realm's settings are its configuration's, or the defaults
 * (local accounts only) when it has none. Realm ids follow the configuration scope's rule (letters, digits, `.`, `_`,
 * `-`, starting with a letter or digit), so `_admin` and `_login` can never be realms.
 */
export class IdpRealmSet
{
    private static readonly ValidId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

    private readonly realms = new Map<string, IdpRealm>();
    private readonly pending = new Map<string, Promise<IdpRealm>>();

    private constructor(
        private readonly opener: IRealmOpener,
        private readonly catalogue: SqlIdpRealmCatalogue,
        private readonly configured: ReadonlyMap<string, RealmConfiguration>)
    {
    }

    /** Every catalogued and configured realm, opened. A configured realm is recorded in the catalogue. */
    public static async Open(opener: IRealmOpener, catalogue: SqlIdpRealmCatalogue, configurations: readonly RealmConfiguration[]): Promise<IdpRealmSet>
    {
        const configured = new Map(configurations.map(configuration => [configuration.RealmId, configuration]));
        const set = new IdpRealmSet(opener, catalogue, configured);
        const names = new Map<string, string>();
        for (const entry of await catalogue.Entries())
        {
            names.set(entry.RealmId, entry.DisplayName);
        }
        for (const configuration of configurations)
        {
            if (!IdpRealmSet.IsValidId(configuration.RealmId))
            {
                throw new ReservedRealmError(configuration.RealmId);
            }
            const name = configuration.DisplayName ?? names.get(configuration.RealmId) ?? configuration.RealmId;
            if (names.get(configuration.RealmId) !== name)
            {
                await catalogue.Record(configuration.RealmId, name);
                names.set(configuration.RealmId, name);
            }
        }
        for (const [realmId, displayName] of names)
        {
            set.realms.set(realmId, await opener.Open(set.SettingsOf(realmId, displayName)));
        }
        return set;
    }

    public static IsValidId(id: string): boolean
    {
        return IdpRealmSet.ValidId.test(id);
    }

    public For(realmId: string): IdpRealm | undefined
    {
        return this.realms.get(realmId);
    }

    public All(): readonly IdpRealm[]
    {
        return [...this.realms.values()];
    }

    /** The realm, created (and catalogued) when absent. Idempotent; concurrent calls share one creation. */
    public async EnsureRealm(realmId: string, displayName: string): Promise<IdpRealm>
    {
        if (!IdpRealmSet.IsValidId(realmId))
        {
            throw new ReservedRealmError(realmId);
        }
        const existing = this.realms.get(realmId);
        if (existing !== undefined)
        {
            return existing;
        }
        const inFlight = this.pending.get(realmId);
        if (inFlight !== undefined)
        {
            return inFlight;
        }
        const creation = this.Create(realmId, displayName);
        this.pending.set(realmId, creation);
        try
        {
            return await creation;
        }
        finally
        {
            this.pending.delete(realmId);
        }
    }

    private async Create(realmId: string, displayName: string): Promise<IdpRealm>
    {
        await this.catalogue.Record(realmId, displayName);
        const realm = await this.opener.Open(this.SettingsOf(realmId, displayName));
        this.realms.set(realmId, realm);
        return realm;
    }

    private SettingsOf(realmId: string, displayName: string): RealmSettings
    {
        const configuration = this.configured.get(realmId);
        return configuration === undefined
            ? RealmSettings.Default(realmId, displayName)
            : RealmSettings.From(realmId, displayName, configuration.Configuration);
    }
}
