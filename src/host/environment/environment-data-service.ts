import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { AppWriteOpDto, AppWriteResultDto, AssignParams, AssignResultDto, ListSharesParams, ListSharesResultDto, ShareParams, ShareResultDto, UnshareParams, UnshareResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/**
 * The runtime record data ops a connection runs on the environment engine (rulings S8, S9, S10): `data/write`, the
 * shares and assign. Each takes the caller's context and the `application/open`-bound app name (which selects
 * nothing, S7). `ServerConnectionHandler.RuntimeAttachArgs` builds it over the server; undefined off a runtime tenant.
 */
export interface IEnvironmentDataService
{
    Write(context: AccessContext, appName: string, operations: readonly AppWriteOpDto[]): Promise<AppWriteResultDto>
    Share(context: AccessContext, appName: string, params: ShareParams): Promise<ShareResultDto>
    Unshare(context: AccessContext, appName: string, params: UnshareParams): Promise<UnshareResultDto>
    ListShares(context: AccessContext, appName: string, params: ListSharesParams): Promise<ListSharesResultDto>
    Assign(context: AccessContext, appName: string, params: AssignParams): Promise<AssignResultDto>
}
