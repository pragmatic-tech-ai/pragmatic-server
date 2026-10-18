import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IInstanceFilter } from '@pragmatic-tech-ai/todl'
import { AllowAllInstanceFilter } from '@pragmatic-tech-ai/todl-identity-engine'
import { AllowAllFieldReadMask } from './cypher/field-masked-graph-query.js'
import type { IFieldReadMask } from './cypher/field-masked-graph-query.js'
import type { TenantReadAuthorization } from './cypher/read-filter-source.js'

/** Per-request read authorization for connector rows: the access-depth row filter plus the field-read mask. */
export interface IConnectorReadAuthorization
{
    /** AccessDepthInstanceFilter(Read); allow-all when no identity. */
    Filter: IInstanceFilter
    /** Masks secured fields; allow-all when no identity or none secured. */
    FieldMask: IFieldReadMask
}

export class ConnectorReadAuthorizations
{
    /** No identity subsystem: nothing is filtered or masked. */
    public static AllowAll(): IConnectorReadAuthorization
    {
        return { Filter: new AllowAllInstanceFilter(), FieldMask: AllowAllFieldReadMask.Instance }
    }

    public static async From(auth: TenantReadAuthorization, context: AccessContext): Promise<IConnectorReadAuthorization>
    {
        return { Filter: await auth.ReadFilterFor(context), FieldMask: await auth.FieldReadMaskFor(context) }
    }
}

/** Stable, secret-free digest of a principal's authorization identity (principal id, tenant, sorted groups and per-resource role grants).
 *  Claims and credentials are deliberately excluded: only identifiers the evaluator keys on are used. */
export class ConnectorPrincipalDigest
{
    /** Per-grant tuple [role, resource kind, resource tenant, resource path]; JSON-encoded so no delimiter in an id can alias two grants. */
    private static GrantKey(grant: AccessContext['Grants'][number]): string
    {
        return JSON.stringify([String(grant.Role), String(grant.Resource.Kind), grant.Resource.TenantId, [...grant.Resource.Path]])
    }

    public static Of(context: AccessContext): string
    {
        const groups = [...context.Principal.Groups].sort()
        const grants = context.Grants.map(g => ConnectorPrincipalDigest.GrantKey(g)).sort()
        return JSON.stringify([context.Principal.Id, context.Principal.TenantId, groups, grants])
    }
}
