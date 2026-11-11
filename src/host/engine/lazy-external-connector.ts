import { ConnectorResidency } from '@pragmatic-tech-ai/graph'
import type { IConnectorCapabilities, IConnectorTransaction, IExternalConnector, IFetchPage, IFetchRequest } from '@pragmatic-tech-ai/graph'
import { DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import type { ExternalRecord, IDataSourceAdapter, PageQuery, PageSlice, QueryRequest, WriteBatch, WriteResult } from '@pragmatic-tech-ai/todl'
import { DataSourceConnector } from '@pragmatic-tech-ai/todl/engine'
import type { ExternalIdentity, IExternalConnectorPlan } from '@pragmatic-tech-ai/todl/engine'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'

/**
 * Stands in for an adapter that has not been opened. It lets the connector's capabilities and bindings be checked
 * without touching the source. It is never called: the lazy connector only forwards to the connector it opened.
 */
class UnopenedSourceAdapter implements IDataSourceAdapter
{
    public static readonly Instance = new UnopenedSourceAdapter()
    private static readonly Message = 'the data source has not been opened'

    public Query(_request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        return Promise.reject(new Error(UnopenedSourceAdapter.Message))
    }

    public QueryPage(_request: QueryRequest, _page: PageQuery): Promise<PageSlice>
    {
        return Promise.reject(new Error(UnopenedSourceAdapter.Message))
    }

    public Apply(_batch: WriteBatch): Promise<WriteResult>
    {
        return Promise.reject(new Error(UnopenedSourceAdapter.Message))
    }

    public async Dispose(): Promise<void>
    {
    }
}

/**
 * An engine External connector that opens its TODL `DataSourceConnector` on first use (ruling R21), so an unreachable
 * or misconfigured data source never fails the engine open, an upgrade or a reopen: only the fetches and transactions
 * that touch this connector's bindings fail, with the open's error, and the next use opens again. The adapter catalog
 * memoizes the opened adapter and drops a failed open. Its name, residency and capabilities are the
 * DataSourceConnector's, and the plan's bindings are checked against `identity` at construction (as the connector
 * checks them). Purpose-free: dev and runtime hosts both install it.
 */
export class LazyExternalConnector implements IExternalConnector
{
    public readonly Name: string
    public readonly Residency = ConnectorResidency.External as const
    public readonly Capabilities: IConnectorCapabilities

    private opening: Promise<DataSourceConnector> | undefined

    public constructor(
        private readonly plan: IExternalConnectorPlan,
        /** Resolves the `DataSourceAdapterCatalog` and the services its connections resolve with, on first use. */
        private readonly services: () => IServiceProvider,
        private readonly identity: ExternalIdentity,
    )
    {
        const unopened = new DataSourceConnector(plan, UnopenedSourceAdapter.Instance, identity)
        this.Name = unopened.Name
        this.Capabilities = unopened.Capabilities
    }

    public async Fetch(request: IFetchRequest): Promise<IFetchPage>
    {
        return (await this.Connector()).Fetch(request)
    }

    public async Begin(): Promise<IConnectorTransaction>
    {
        return (await this.Connector()).Begin()
    }

    /**
     * Forgets the opened connector, so the next use opens it again (ruling R23: after the adapter catalog disposed and
     * dropped the adapter, e.g. a connector refresh). A call already running keeps the connector it got.
     */
    public Reset(): void
    {
        this.opening = undefined
    }

    /** The opened connector; a failed open is forgotten, so the next call tries again. */
    private Connector(): Promise<DataSourceConnector>
    {
        if (this.opening === undefined)
        {
            const opening = this.Open().catch((error: unknown) =>
            {
                if (this.opening === opening) this.opening = undefined
                throw error
            })
            this.opening = opening
        }
        return this.opening
    }

    private async Open(): Promise<DataSourceConnector>
    {
        const services = this.services()
        return DataSourceConnector.Open(this.plan, services.getRequired(DataSourceAdapterCatalog.ServiceKey), services, this.identity)
    }
}
