import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IInstanceFilter } from '@pragmatic-tech-ai/todl'
import { AllowAllInstanceFilter } from '@pragmatic-tech-ai/todl-identity-engine'
import { AllowAllFieldReadMask } from './cypher/field-read-mask.js'
import type { IFieldReadMask } from './cypher/field-read-mask.js'
import type { TenantReadAuthorization } from './cypher/read-filter-source.js'

/** Per-request read authorization for connector rows: the access-depth row filter plus the field-read mask. */
export interface IConnectorReadAuthorization
{
    /** AccessDepthInstanceFilter(Read); allow-all when no identity. */
    Filter: IInstanceFilter
    /** Masks secured fields; allow-all when no identity or none secured. */
    FieldMask: IFieldReadMask
    /** True only when backed by a real identity subsystem; the principal digest is folded into cursor fingerprints only then. */
    IdentityBacked: boolean
}

export class ConnectorReadAuthorizations
{
    /** No identity subsystem: nothing is filtered or masked. */
    public static AllowAll(): IConnectorReadAuthorization
    {
        return { Filter: new AllowAllInstanceFilter(), FieldMask: AllowAllFieldReadMask.Instance, IdentityBacked: false }
    }

    public static async From(auth: TenantReadAuthorization, context: AccessContext): Promise<IConnectorReadAuthorization>
    {
        return { Filter: await auth.ReadFilterFor(context), FieldMask: await auth.FieldReadMaskFor(context), IdentityBacked: true }
    }
}
