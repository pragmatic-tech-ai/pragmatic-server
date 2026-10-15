import { DataSourceKind } from '@pragmatic-tech-ai/todl'

/** Per-tenant connectors governance: which adapter kinds a tenant may use, whether inline connections are
 *  forbidden (catalog-only), and whether a model may name its own provider package. Carries kind names +
 *  booleans only — never a connection value or secret. */
export class ConnectorsPolicy
{
    public constructor(
        public readonly AdapterAllowlist: readonly DataSourceKind[],
        public readonly CatalogOnly: boolean,
        public readonly AllowProviderOverride: boolean,
        public readonly ProviderAllowlist: readonly string[],
    )
    {
    }

    /** Permissive default: all bundled kinds allowed, inline connections permitted, no provider override.
     *  Absence of an explicit policy behaves exactly as pre-6C. */
    public static Default(): ConnectorsPolicy
    {
        return new ConnectorsPolicy([DataSourceKind.Sql, DataSourceKind.Rest, DataSourceKind.Cypher, DataSourceKind.Document, DataSourceKind.Builtin], false, false, [])
    }
}
