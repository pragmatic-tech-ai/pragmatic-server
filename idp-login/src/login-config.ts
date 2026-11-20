import { IdentityPlatformPageConfig } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client'

// One upstream identity source of the realm (Google, Microsoft, a generic
// OIDC provider, Pragmatic): its button label and the broker login path the
// page appends the authorize request to.
export class LoginSource
{
    public constructor(
        public readonly Id: string,
        public readonly Kind: string,
        public readonly Label: string,
        public readonly Login: string)
    {
    }
}

// What `GET <issuer>/login/config` says the realm's page offers.
export class LoginConfig
{
    private static readonly InvalidMessage = 'invalid sign-in page config'
    private static readonly RealmField = 'realm'
    private static readonly DisplayNameField = 'displayName'
    private static readonly LocalField = 'local'
    private static readonly SourcesField = 'sources'
    private static readonly IdentityPlatformField = 'identityPlatform'
    private static readonly SignUpField = 'signUp'
    private static readonly IdField = 'id'
    private static readonly KindField = 'kind'
    private static readonly LabelField = 'label'
    private static readonly LoginField = 'login'

    public constructor(
        public readonly Realm: string,
        public readonly DisplayName: string,
        public readonly Local: boolean,
        public readonly Sources: readonly LoginSource[],
        public readonly IdentityPlatform: IdentityPlatformPageConfig | null,
        public readonly SignUp: boolean)
    {
    }

    // Parses the config JSON; throws on a malformed one.
    public static FromJson(json: unknown): LoginConfig
    {
        const C = LoginConfig
        if (json === null || typeof json !== 'object' || Array.isArray(json))
        {
            throw new Error(C.InvalidMessage)
        }
        const value = json as Record<string, unknown>
        const sources = value[C.SourcesField] ?? []
        if (!Array.isArray(sources))
        {
            throw new Error(C.InvalidMessage)
        }
        const platform = value[C.IdentityPlatformField] ?? null
        return new LoginConfig(
            C.Text(value[C.RealmField]),
            C.Text(value[C.DisplayNameField]),
            value[C.LocalField] === true,
            sources.map(source => C.Source(source)),
            platform === null ? null : IdentityPlatformPageConfig.FromJson(platform),
            value[C.SignUpField] === true)
    }

    private static Source(json: unknown): LoginSource
    {
        const C = LoginConfig
        if (json === null || typeof json !== 'object')
        {
            throw new Error(C.InvalidMessage)
        }
        const value = json as Record<string, unknown>
        return new LoginSource(C.Text(value[C.IdField]), C.Text(value[C.KindField]), C.Text(value[C.LabelField]), C.Text(value[C.LoginField]))
    }

    private static Text(value: unknown): string
    {
        if (typeof value !== 'string')
        {
            throw new Error(LoginConfig.InvalidMessage)
        }
        return value
    }
}
