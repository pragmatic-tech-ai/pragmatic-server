import { WikiOriginKind } from '@pragmatic-tech-ai/todl'
import type { WikiOrigin } from '@pragmatic-tech-ai/todl'
import { WikiOriginWire } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { WikiOriginDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IModelOrigins } from './model-projection.js'

/** The open solution's members as the origin mapper reads them: a member id and the storage it owns. */
export interface IWikiOriginMember
{
    readonly Ref: { readonly path: string }
    readonly Storage?: IStorage
}

/**
 * Maps the engine's per-node WikiOrigin onto the wire: an open-project origin names the solution member that owns its
 * storage (matched by the storage's stable Root, not object identity; the wire cannot carry a storage); a package origin carries its id and version. An open-project origin whose
 * storage root is no member of the solution has no wire form and is left out (recorded in {@link Dropped}, so the host can report
 * a server-side drop; a client that sees no origin for a node then knows the server withheld it). Nodes are mapped lazily, one
 * page item at a time, so a page costs its own size, not the whole graph.
 */
export class WikiOriginWireMapper implements IModelOrigins
{
    private readonly memberOf = new Map<string, string>()
    private readonly dropped = new Set<string>()

    public constructor(members: readonly IWikiOriginMember[], private readonly originOf?: ReadonlyMap<string, WikiOrigin>)
    {
        for (const member of members)
        {
            if (member.Storage !== undefined)
            {
                this.memberOf.set(member.Storage.Root, member.Ref.path)
            }
        }
    }

    /** The ids of nodes whose origin had no wire form, as seen so far. */
    public get Dropped(): ReadonlySet<string>
    {
        return this.dropped
    }

    public OfNode(id: string): WikiOriginDto | undefined
    {
        const origin = this.originOf?.get(id)
        if (origin === undefined)
        {
            return undefined
        }
        const dto = this.Of(origin)
        if (dto === undefined)
        {
            this.dropped.add(id)
        }
        return dto
    }

    public Of(origin: WikiOrigin): WikiOriginDto | undefined
    {
        if (origin.kind === WikiOriginKind.Package)
        {
            return { kind: WikiOriginWire.Package, id: origin.id, version: origin.version }
        }
        const memberId = this.memberOf.get(origin.storage.Root)
        return memberId === undefined ? undefined : { kind: WikiOriginWire.OpenProject, memberId }
    }
}
