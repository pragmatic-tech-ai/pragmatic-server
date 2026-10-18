import type { CypherExecuteResultDto, CypherWriteCountsDto, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { Cypher } from '@pragmatic-tech-ai/todl'
import { CypherResultMapper } from './cypher-result-mapper.js'

/** Maps an engine write result (PascalCase stats) to the camelCase wire DTO. Never carries field values in `reason`. */
export class CypherExecuteResultMapper
{
    private static readonly Empty: Cypher.CypherResultDto = { Columns: [], Rows: [], Truncated: false, HasMore: false }

    public static ToWire(status: AppWriteStatus, revision: number, result: Cypher.CypherResultDto | undefined, reason?: string): CypherExecuteResultDto
    {
        const page = CypherResultMapper.ToWire(result ?? CypherExecuteResultMapper.Empty)
        const dto: CypherExecuteResultDto = {
            status,
            counts: CypherExecuteResultMapper.Counts(result?.Stats),
            revision,
            columns: page.columns,
            rows: page.items,
            truncated: page.truncated,
        }
        if (reason !== undefined)
        {
            dto.reason = reason
        }
        return dto
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

    public static Changed(stats: Cypher.CypherWriteStatsDto | undefined): boolean
    {
        const c = CypherExecuteResultMapper.Counts(stats)
        return c.nodesCreated + c.nodesDeleted + c.relationshipsCreated + c.relationshipsDeleted + c.propertiesSet > 0
    }
}
