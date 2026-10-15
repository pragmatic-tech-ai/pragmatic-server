import type { IDataSourceAdapterFactory, IDataSourceAdapter, ResolvedConnection } from '@pragmatic-tech-ai/todl'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { DocumentAdapter } from '@pragmatic-tech-ai/todl-connectors-host'
import type { IDocumentSession } from '@pragmatic-tech-ai/todl-connectors-host'
import { BuiltinStoreEngine } from './builtin-store-engine.js'

/** Opens the built-in default connector: a DocumentAdapter over the session the platform builds for the
 *  configured data root + engine. */
export class BuiltinAdapterFactory implements IDataSourceAdapterFactory
{
    public static readonly DataRootKey = 'dataRoot'
    public static readonly EngineKey = 'engine'

    public readonly Kind = DataSourceKind.Builtin

    public constructor(private readonly createStore: (dataRoot: string, engine: BuiltinStoreEngine) => IDocumentSession)
    {
    }

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        const dataRoot = connection.Config[BuiltinAdapterFactory.DataRootKey]
        const engine = connection.Config[BuiltinAdapterFactory.EngineKey] as BuiltinStoreEngine
        return new DocumentAdapter(this.createStore(dataRoot, engine))
    }
}
