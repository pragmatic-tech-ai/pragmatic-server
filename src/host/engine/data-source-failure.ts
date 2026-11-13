import { ConnectorError, ConnectorPhase } from '@pragmatic-tech-ai/graph'
import { DataSourceUnavailableError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { DataSourceUnavailableData, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'

/**
 * A read that needed an External data source which did not answer (the graph engine's ConnectorError in the Fetch
 * phase, e.g. its database host does not resolve) as the protocol's DataSourceUnavailableError: a message and data
 * naming the source, never the cause (it can carry hosts, paths or credentials; the server log has it).
 * Writes map their connector failures themselves (EngineWriteFailure), so only fetches reach here.
 */
export class DataSourceFailure
{
    /** TODL names a datasource's connector node `<namespace>@connector:<name>`. */
    private static readonly ConnectorIdInfix = '@connector:'
    private static readonly QualifiedSeparator = '.'

    /** True when `error` is a data source's failed fetch. */
    public static Is(error: unknown): error is ConnectorError
    {
        return error instanceof ConnectorError && error.Phase === ConnectorPhase.Fetch
    }

    /** The wire error for a data source's failed fetch; undefined for any other error. */
    public static ToResponseError(error: unknown): ResponseError<DataSourceUnavailableData> | undefined
    {
        return DataSourceFailure.Is(error) ? DataSourceUnavailableError.Create(DataSourceFailure.NameOf(error.Connector)) : undefined
    }

    /** The datasource's qualified TODL name (`<namespace>.<name>`) for a connector node id; any other name as is. */
    public static NameOf(connector: string): string
    {
        const at = connector.indexOf(DataSourceFailure.ConnectorIdInfix)
        if (at <= 0)
        {
            return connector
        }
        return connector.slice(0, at) + DataSourceFailure.QualifiedSeparator + connector.slice(at + DataSourceFailure.ConnectorIdInfix.length)
    }
}
