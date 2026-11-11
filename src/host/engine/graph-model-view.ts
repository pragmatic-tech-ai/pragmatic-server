import type { ModelViewPageDto, PageParams, ResolvedResourceDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { PagingLimits } from '../../config/paging-limits.js'

/** The page a model/view asks for: the wire paging params and the connection's paging limits. */
export interface IModelViewPage
{
    readonly Params: PageParams
    readonly Limits: PagingLimits
}

/**
 * The `model/view` and `model/resources` endpoints' engine side (ruling S15), one per purpose: dev `DevModelView`
 * (structure from the language service, visibility from the dev engine scope) and runtime `EnvironmentModelView`
 * (projected from the environment engine). The handler has no purpose branch.
 */
export interface IGraphModelView
{
    Page(context: AccessContext, memberId: string | undefined, page: IModelViewPage): Promise<ModelViewPageDto>
    /** True when the graph holds `nodeId` and the caller's scope hides it (false for an unknown id). */
    Hidden(context: AccessContext, nodeId: string): Promise<boolean>
    /** The resources `model/resources` lists for `nodeId` (`[]` for a hidden or unknown node). */
    Resources(context: AccessContext, nodeId: string): Promise<ResolvedResourceDto[]>
}
