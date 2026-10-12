import type { IConnectionResolver, ConnectorSpec, ResolvedConnection } from '@pragmatic-tech-ai/todl'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { SecretStoreKey } from '@pragmatic-tech-ai/todl-identity'

/** A file-declared external connection: flat string settings merged into the resolved Config, plus an optional
 *  by-reference secret (resolved from the per-tenant secret store) or an environment-variable token. */
export interface FileConnection
{
    Settings: Record<string, string>
    SecretRef?: string
    TokenEnvVar?: string
}

/** A model referenced a named connection the tenant did not declare. */
export class ConnectionNotDeclaredError extends Error
{
    private static readonly ErrorName = 'ConnectionNotDeclaredError'
    private static readonly Prefix = "connector '"
    private static readonly Middle = "': connection '"
    private static readonly Suffix = "' is not declared for this tenant"

    public readonly Connector: string
    public readonly Connection: string

    public constructor(connector: string, connection: string)
    {
        super(ConnectionNotDeclaredError.Prefix + connector + ConnectionNotDeclaredError.Middle + connection + ConnectionNotDeclaredError.Suffix)
        this.name = ConnectionNotDeclaredError.ErrorName
        this.Connector = connector
        this.Connection = connection
    }
}

/** Resolves a connector spec against a per-tenant map of file-declared connections: merges a named connection's
 *  settings with the model's inline Config (inline wins) and resolves the secret from the per-tenant secret store
 *  or an environment variable. An inline spec (no Connection) passes through; an undeclared connection fails closed. */
export class FileConnectionResolver implements IConnectionResolver
{
    private readonly connections: ReadonlyMap<string, FileConnection>

    public constructor(connections: ReadonlyMap<string, FileConnection>)
    {
        this.connections = connections
    }

    public async Resolve(spec: ConnectorSpec, services: IServiceProvider): Promise<ResolvedConnection>
    {
        if (spec.Connection === undefined)
        {
            return spec.Secret === undefined
                ? { Kind: spec.Kind, Config: spec.Config }
                : { Kind: spec.Kind, Config: spec.Config, Secret: spec.Secret }
        }
        const connection = this.connections.get(spec.Connection)
        if (connection === undefined)
        {
            throw new ConnectionNotDeclaredError(spec.Name, spec.Connection)
        }
        const config: Record<string, string> = {}
        Object.assign(config, connection.Settings)
        Object.assign(config, spec.Config)
        const secret = await this.ResolveSecret(spec, connection, services)
        return secret === undefined
            ? { Kind: spec.Kind, Config: config }
            : { Kind: spec.Kind, Config: config, Secret: secret }
    }

    private async ResolveSecret(spec: ConnectorSpec, connection: FileConnection, services: IServiceProvider): Promise<string | undefined>
    {
        if (spec.Secret !== undefined)
        {
            return (await services.get(SecretStoreKey)?.Get(spec.Secret)) ?? undefined
        }
        if (connection.SecretRef !== undefined && connection.SecretRef.length > 0)
        {
            return (await services.get(SecretStoreKey)?.Get(connection.SecretRef)) ?? undefined
        }
        if (connection.TokenEnvVar !== undefined)
        {
            return process.env[connection.TokenEnvVar]
        }
        return undefined
    }
}
