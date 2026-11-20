import type { RuntimeConfiguration } from '@pragmatic-tech-ai/pragmatic-configuration';
import { IdpDuration } from './idp-duration.js';
import { RealmSourceKind, TenantIdpOptions as O } from './tenant-idp-options.js';

/** A realm's configuration cannot be used (a value of the wrong shape, or the container's own option in it). */
export class RealmSettingsError extends Error
{
    private static readonly ErrorName = 'RealmSettingsError';
    private static readonly Prefix = 'realm ';
    private static readonly Separator = ': ';

    public constructor(realm: string, detail: string)
    {
        super(RealmSettingsError.Prefix + realm + RealmSettingsError.Separator + detail);
        this.name = RealmSettingsError.ErrorName;
    }
}

/** The realm's token and session lifetimes, in milliseconds. */
export class TokenPolicy
{
    private static readonly MillisPerSecond = 1000;

    public static readonly Default = new TokenPolicy(
        IdpDuration.Millis(O.DefaultIdTokenLifetime),
        IdpDuration.Millis(O.DefaultRefreshTokenIdleLifetime),
        IdpDuration.Millis(O.DefaultRefreshTokenMaxLifetime),
        IdpDuration.Millis(O.DefaultSsoSessionLifetime));

    public constructor(
        public readonly IdTokenMs: number,
        public readonly RefreshIdleMs: number,
        public readonly RefreshMaxMs: number,
        public readonly SsoSessionMs: number)
    {
        Object.freeze(this);
    }

    /** The ID token lifetime in whole seconds (at least one). */
    public get IdTokenSeconds(): number
    {
        return Math.max(1, Math.floor(this.IdTokenMs / TokenPolicy.MillisPerSecond));
    }
}

/** The realm's local-account policy: how many failed sign-ins lock an (account, address) and for how long. */
export class LocalPolicy
{
    public static readonly Default = new LocalPolicy(O.DefaultMaxAttempts, IdpDuration.Millis(O.DefaultLockout));
    /** The cap on failures of one account across every address (bounds distributed guessing). */
    public static readonly AccountCapFactor = 4;

    public constructor(public readonly MaxAttempts: number, public readonly LockoutMs: number)
    {
        Object.freeze(this);
    }
}

/** One upstream OpenID Connect source of the realm (Google, Entra, generic OIDC or Sign in with Pragmatic). */
export class UpstreamSourceSettings
{
    public constructor(
        public readonly Kind: RealmSourceKind,
        public readonly ClientId: string,
        public readonly ClientSecret: string,
        public readonly Issuer: string | undefined,
        public readonly DiscoveryUrl: string | undefined,
        public readonly Scopes: readonly string[] | undefined,
        public readonly GroupsClaim: string | undefined,
        public readonly Label: string | undefined,
        public readonly HostedDomain: string | undefined,
        public readonly EntraTenantId: string | undefined,
        public readonly CaBundleFile: string | undefined)
    {
        Object.freeze(this);
    }

    /** The source id (the option name). */
    public get Id(): string
    {
        return this.Kind;
    }
}

/** The realm's Google Identity Platform source. */
export class IdentityPlatformSourceSettings
{
    public constructor(
        public readonly ProjectId: string,
        public readonly ApiKey: string,
        public readonly Providers: readonly string[],
        public readonly TenantId: string | undefined,
        public readonly MaxAuthAgeSeconds: number,
        public readonly AuthDomain: string | undefined)
    {
        Object.freeze(this);
    }
}

/**
 * What one realm runs on: its token policy and its identity sources, from the realm's configuration (or the defaults:
 * local accounts only, when the realm has none). Secret settings arrive resolved (the configuration reader resolved
 * their references through the realm's secrets home).
 */
export class RealmSettings
{
    private static readonly UpstreamKinds: readonly RealmSourceKind[] = [RealmSourceKind.Google, RealmSourceKind.Entra, RealmSourceKind.Oidc, RealmSourceKind.Pragmatic];
    private static readonly CoreForbidden = 'the core option is the container\'s, not a realm\'s';
    private static readonly MissingValue = 'missing setting ';
    private static readonly Dot = '.';
    private static readonly MillisPerSecond = 1000;

    private constructor(
        public readonly RealmId: string,
        public readonly DisplayName: string,
        public readonly Tokens: TokenPolicy,
        public readonly Local: LocalPolicy | undefined,
        public readonly Upstreams: readonly UpstreamSourceSettings[],
        public readonly IdentityPlatform: IdentityPlatformSourceSettings | undefined)
    {
        Object.freeze(this);
    }

    /** A realm without configuration: local accounts with the default policies. */
    public static Default(realmId: string, displayName: string): RealmSettings
    {
        return new RealmSettings(realmId, displayName, TokenPolicy.Default, LocalPolicy.Default, [], undefined);
    }

    public static From(realmId: string, displayName: string, configuration: RuntimeConfiguration): RealmSettings
    {
        const reader = new RealmSettingsReader(realmId, configuration);
        if (configuration.IsEnabled(O.Core))
        {
            throw new RealmSettingsError(realmId, RealmSettings.CoreForbidden);
        }
        const tokens = configuration.IsEnabled(O.Tokens)
            ? new TokenPolicy(
                reader.Duration(O.Tokens, O.IdTokenLifetime),
                reader.Duration(O.Tokens, O.RefreshTokenIdleLifetime),
                reader.Duration(O.Tokens, O.RefreshTokenMaxLifetime),
                reader.Duration(O.Tokens, O.SsoSessionLifetime))
            : TokenPolicy.Default;
        const local = configuration.IsEnabled(RealmSourceKind.Local)
            ? new LocalPolicy(reader.Integer(RealmSourceKind.Local, O.MaxAttempts), reader.Duration(RealmSourceKind.Local, O.Lockout))
            : undefined;
        const upstreams = RealmSettings.UpstreamKinds
            .filter(kind => configuration.IsEnabled(kind))
            .map(kind => RealmSettings.Upstream(kind, reader));
        const identityPlatform = configuration.IsEnabled(RealmSourceKind.IdentityPlatform)
            ? RealmSettings.IdentityPlatformOf(reader)
            : undefined;
        return new RealmSettings(realmId, displayName, tokens, local, upstreams, identityPlatform);
    }

    /** The ids of the realm's sources (role mappings of any other source grant nothing). */
    public SourceIds(): readonly string[]
    {
        const ids: string[] = [];
        if (this.Local !== undefined)
        {
            ids.push(RealmSourceKind.Local);
        }
        ids.push(...this.Upstreams.map(upstream => upstream.Id));
        if (this.IdentityPlatform !== undefined)
        {
            ids.push(RealmSourceKind.IdentityPlatform);
        }
        return ids;
    }

    public Upstream(id: string): UpstreamSourceSettings | undefined
    {
        return this.Upstreams.find(upstream => upstream.Id === id);
    }

    /** Whether people can create their own account here (the sign-up of `prompt=create`). */
    public get OffersSignUp(): boolean
    {
        return this.IdentityPlatform !== undefined;
    }

    private static Upstream(kind: RealmSourceKind, reader: RealmSettingsReader): UpstreamSourceSettings
    {
        return new UpstreamSourceSettings(
            kind,
            reader.RequiredString(kind, O.ClientId),
            reader.Secret(kind, O.ClientSecret),
            reader.String(kind, O.Issuer),
            reader.String(kind, O.DiscoveryUrl),
            reader.List(kind, O.Scopes),
            reader.String(kind, O.GroupsClaim),
            reader.String(kind, O.Label),
            reader.String(kind, O.HostedDomain),
            reader.String(kind, O.TenantId),
            reader.String(kind, O.CaBundleFile));
    }

    private static IdentityPlatformOf(reader: RealmSettingsReader): IdentityPlatformSourceSettings
    {
        const kind = RealmSourceKind.IdentityPlatform;
        return new IdentityPlatformSourceSettings(
            reader.RequiredString(kind, O.ProjectId),
            reader.Secret(kind, O.ApiKey),
            reader.List(kind, O.Providers) ?? O.DefaultProviders,
            reader.String(kind, O.TenantId),
            Math.max(1, Math.floor(reader.Duration(kind, O.MaxAuthAge) / RealmSettings.MillisPerSecond)),
            reader.String(kind, O.AuthDomain));
    }

    /** `<option>.<setting>`, for errors. */
    public static Where(option: string, setting: string): string
    {
        return option + RealmSettings.Dot + setting;
    }

    public static MissingMessage(option: string, setting: string): string
    {
        return RealmSettings.MissingValue + RealmSettings.Where(option, setting);
    }
}

/** Typed reads of a realm's runtime configuration (the validator already checked the types). */
class RealmSettingsReader
{
    public constructor(private readonly realm: string, private readonly configuration: RuntimeConfiguration)
    {
    }

    public String(option: string, setting: string): string | undefined
    {
        const value = this.configuration.Value(option, setting);
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    }

    public RequiredString(option: string, setting: string): string
    {
        const value = this.String(option, setting);
        if (value === undefined)
        {
            throw new RealmSettingsError(this.realm, RealmSettings.MissingMessage(option, setting));
        }
        return value;
    }

    public Integer(option: string, setting: string): number
    {
        const value = this.configuration.Value(option, setting);
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        {
            throw new RealmSettingsError(this.realm, RealmSettings.MissingMessage(option, setting));
        }
        return value;
    }

    public Duration(option: string, setting: string): number
    {
        return IdpDuration.Millis(this.RequiredString(option, setting));
    }

    public List(option: string, setting: string): readonly string[] | undefined
    {
        const value = this.configuration.Value(option, setting);
        return Array.isArray(value) && value.length > 0 ? [...value] : undefined;
    }

    public Secret(option: string, setting: string): string
    {
        const secret = this.configuration.Secret(option, setting);
        if (secret === undefined)
        {
            throw new RealmSettingsError(this.realm, RealmSettings.MissingMessage(option, setting));
        }
        return secret.Reveal();
    }
}
