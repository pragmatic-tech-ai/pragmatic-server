import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'

/** Stable, secret-free digest of a principal's authorization identity (principal id, tenant, sorted groups and per-resource role grants).
 *  Claims and credentials are deliberately excluded: only identifiers the evaluator keys on are used. */
export class ConnectorPrincipalDigest
{
    /** Per-grant tuple [subject, role, resource kind, resource tenant, resource path]; JSON-encoded so no delimiter in an id can alias two grants. */
    private static GrantKey(grant: AccessContext['Grants'][number]): string
    {
        return JSON.stringify([grant.Subject, String(grant.Role), String(grant.Resource.Kind), grant.Resource.TenantId, [...grant.Resource.Path]])
    }

    public static Of(context: AccessContext): string
    {
        const groups = [...context.Principal.Groups].sort()
        const grants = context.Grants.map(g => ConnectorPrincipalDigest.GrantKey(g)).sort()
        return JSON.stringify([context.Principal.Id, context.Principal.TenantId, groups, grants])
    }
}
