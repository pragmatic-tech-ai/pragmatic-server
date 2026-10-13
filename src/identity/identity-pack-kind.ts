export enum IdentityPackKind
{
    Entra,
    Google,
    Local,
    GenericOidc,
}

/** Maps the stored IdentityConfig.PackId string to an IdentityPackKind, fail-closed on anything unknown. */
export class IdentityPackKinds
{
    private static readonly EntraId = 'entra'
    private static readonly GoogleId = 'google'
    private static readonly LocalId = 'local'
    private static readonly GenericOidcId = 'generic-oidc'
    private static readonly ServerPackId = 'server-pack'
    private static readonly UnknownPackError = 'unknown identity pack: '

    private static readonly ById: ReadonlyMap<string, IdentityPackKind> = new Map<string, IdentityPackKind>([
        [IdentityPackKinds.EntraId, IdentityPackKind.Entra],
        [IdentityPackKinds.GoogleId, IdentityPackKind.Google],
        [IdentityPackKinds.LocalId, IdentityPackKind.Local],
        [IdentityPackKinds.GenericOidcId, IdentityPackKind.GenericOidc],
        [IdentityPackKinds.ServerPackId, IdentityPackKind.Local],
    ])

    public static FromPackId(packId: string): IdentityPackKind
    {
        const kind = IdentityPackKinds.ById.get(packId)
        if (kind === undefined)
        {
            throw new Error(IdentityPackKinds.UnknownPackError + packId)
        }
        return kind
    }
}
