import type { IPrincipalFacts } from '@pragmatic-tech-ai/todl/engine'
import type { Principal } from '@pragmatic-tech-ai/todl-identity'

/** The identity principal as TODL policies read it: `groups` is the principal's groups, any other fact one of its claims. */
export class PrincipalFacts implements IPrincipalFacts
{
    private static readonly GroupsFact = 'groups'

    public readonly Id: string

    public constructor(private readonly principal: Principal)
    {
        this.Id = principal.Id
    }

    public Get(name: string): ReturnType<IPrincipalFacts['Get']>
    {
        return name === PrincipalFacts.GroupsFact ? this.principal.Groups : this.principal.Claims.get(name)
    }
}
