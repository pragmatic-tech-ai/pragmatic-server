import type { Cypher } from '@pragmatic-tech-ai/graph'
import type { AppWriteStatus, CypherExecuteResultDto, CypherQueryPageDto, CypherWriteCountsDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/**
 * Builds the camelCase `cypher/execute` wire result from the engine's write stats and the RETURN rows already mapped
 * to the wire page (EngineCellMapper, then CypherResultMapper). Never carries field values in `reason`.
 */
export class CypherExecuteResultMapper
{
    /** A write that ran: its stats (absent for a read-only query: zero counts) and its rows. */
    public static Applied(status: AppWriteStatus, revision: number, page: CypherQueryPageDto, stats: Cypher.CypherWriteStatsDto | undefined): CypherExecuteResultDto
    {
        return { status, counts: CypherExecuteResultMapper.Counts(stats), revision, columns: page.columns, rows: page.items, truncated: page.truncated }
    }

    /** A write that was refused or failed: nothing was kept, so no counts and no rows, only the fixed reason. */
    public static Refused(status: AppWriteStatus, revision: number, reason: string): CypherExecuteResultDto
    {
        return { status, counts: CypherExecuteResultMapper.Counts(undefined), revision, columns: [], rows: [], truncated: false, reason }
    }

    public static Counts(stats: Cypher.CypherWriteStatsDto | undefined): CypherWriteCountsDto
    {
        return {
            nodesCreated: stats?.NodesCreated ?? 0,
            nodesDeleted: stats?.NodesDeleted ?? 0,
            relationshipsCreated: stats?.RelationshipsCreated ?? 0,
            relationshipsDeleted: stats?.RelationshipsDeleted ?? 0,
            propertiesSet: stats?.PropertiesSet ?? 0,
        }
    }
}
