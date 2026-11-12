import type { IPrincipalFacts } from '@pragmatic-tech-ai/todl/engine'
import type { Principal } from '@pragmatic-tech-ai/todl-identity'
import type { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'

/**
 * The acting principal as placement stamps it (contract C3): its id and its home business unit, taken from the
 * environment setting's placement (`TenantSecurityModel.PlacementOf`; an unplaced principal sits at the root).
 */
export class PrincipalFacts implements IPrincipalFacts
{
    private static readonly NoText = ''

    /** No acting principal (no identity subsystem, or a purpose that stamps nothing). */
    public static readonly None = new PrincipalFacts(PrincipalFacts.NoText, PrincipalFacts.NoText)

    private constructor(public readonly Id: string, public readonly HomeBusinessUnitId: string)
    {
    }

    public static For(principal: Principal, model: TenantSecurityModel): PrincipalFacts
    {
        return new PrincipalFacts(principal.Id, model.PlacementOf(principal).HomeBusinessUnitId)
    }
}
