import { ConnectorError, ConnectorPhase } from '@pragmatic-tech-ai/graph'
import { ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'

/** The wire data of a DataSourceFailure: the data source (the model's connector name) that did not answer. */
export interface IDataSourceFailureData
{
    dataSource: string
}

/**
 * A read that needed an External data source which did not answer (the graph engine's ConnectorError in the Fetch
 * phase, e.g. its database host does not resolve) as a typed wire error: code {@link DataSourceFailure.Code}, a message
 * and data naming the source, never the cause (it can carry hosts, paths or credentials; the server log has it).
 * Writes map their connector failures themselves (EngineWriteFailure), so only fetches reach here.
 */
export class DataSourceFailure
{
    public static readonly Code = -32034
    public static readonly MessageStart = 'data source unavailable: '
    /** TODL names a datasource's connector node `<namespace>@connector:<name>`. */
    private static readonly ConnectorIdInfix = '@connector:'
    private static readonly QualifiedSeparator = '.'

    /** True when `error` is a data source's failed fetch. */
    public static Is(error: unknown): error is ConnectorError
    {
        return error instanceof ConnectorError && error.Phase === ConnectorPhase.Fetch
    }

    /** The wire error for a data source's failed fetch; undefined for any other error. */
    public static ToResponseError(error: unknown): ResponseError<IDataSourceFailureData> | undefined
    {
        if (!DataSourceFailure.Is(error))
        {
            return undefined
        }
        const name = DataSourceFailure.NameOf(error.Connector)
        return new ResponseError<IDataSourceFailureData>(DataSourceFailure.Code, DataSourceFailure.MessageStart + name, { dataSource: name })
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
