import { WikiOriginKind } from '@pragmatic-tech-ai/todl'
import type { WikiOrigin } from '@pragmatic-tech-ai/todl'
import { WikiOriginWire } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { WikiOriginDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'

/** The open solution's members as the origin mapper reads them: a member id and the storage it owns. */
export interface IWikiOriginMember
{
    readonly Ref: { readonly path: string }
    readonly Storage?: IStorage
}

/**
 * Maps the engine's per-node WikiOrigin onto the wire: an open-project origin names the solution member that owns its
 * storage (the wire cannot carry a storage); a package origin carries its id and version. An open-project origin whose
 * storage is no member of the solution has no wire form and is left out.
 */
export class WikiOriginWireMapper
{
    private readonly memberOf = new Map<IStorage, string>()

    public constructor(members: readonly IWikiOriginMember[])
    {
        for (const member of members)
        {
            if (member.Storage !== undefined)
            {
                this.memberOf.set(member.Storage, member.Ref.path)
            }
        }
    }

    public Of(origin: WikiOrigin): WikiOriginDto | undefined
    {
        if (origin.kind === WikiOriginKind.Package)
        {
            return { kind: WikiOriginWire.Package, id: origin.id, version: origin.version }
        }
        const memberId = this.memberOf.get(origin.storage)
        return memberId === undefined ? undefined : { kind: WikiOriginWire.OpenProject, memberId }
    }
}
