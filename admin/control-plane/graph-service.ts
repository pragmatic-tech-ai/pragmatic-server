import { join } from 'node:path'
import { EnvType, type EnvironmentRecord } from './environment-record.js'
import { EnvironmentNotFoundError } from './environment-service.js'
import type { GraphRecord } from './graph-record.js'
import { GraphRegistry } from './graph-registry.js'

export interface IEnvironmentLookup
{
    Get(name: string): EnvironmentRecord | undefined
}

export class GraphExistsError extends Error
{
    private static readonly ErrorName = 'GraphExistsError'
    private static readonly MessagePrefix = 'Graph already exists: '

    public constructor(graphName: string)
    {
        super(GraphExistsError.MessagePrefix + graphName)
        this.name = GraphExistsError.ErrorName
    }
}

export class GraphNotFoundError extends Error
{
    private static readonly ErrorName = 'GraphNotFoundError'
    private static readonly MessagePrefix = 'Graph not found: '

    public constructor(graphName: string)
    {
        super(GraphNotFoundError.MessagePrefix + graphName)
        this.name = GraphNotFoundError.ErrorName
    }
}

export class GraphNameInvalidError extends Error
{
    private static readonly ErrorName = 'GraphNameInvalidError'
    private static readonly MessagePrefix = 'Invalid graph name: '

    public constructor(graphName: string)
    {
        super(GraphNameInvalidError.MessagePrefix + graphName)
        this.name = GraphNameInvalidError.ErrorName
    }
}

export class EnvironmentNotDevelopmentError extends Error
{
    private static readonly ErrorName = 'EnvironmentNotDevelopmentError'
    private static readonly MessagePrefix = 'Environment is not a development environment: '

    public constructor(envName: string)
    {
        super(EnvironmentNotDevelopmentError.MessagePrefix + envName)
        this.name = EnvironmentNotDevelopmentError.ErrorName
    }
}

export class GraphService
{
    private static readonly GraphsFile = 'graphs.json'
    private static readonly GraphNamePattern = /^[a-z0-9][a-z0-9-]*$/

    public constructor(private readonly environments: IEnvironmentLookup)
    {
    }

    public async Create(envName: string, name: string, description: string): Promise<GraphRecord>
    {
        const env = this.Require(envName)
        GraphService.SanitizeGraphName(name)
        const store = this.StoreFor(env)
        await store.Load()
        if (store.Get(name))
        {
            throw new GraphExistsError(name)
        }
        const record: GraphRecord = {
            manifest: { name, description, packages: [] },
            createdAt: new Date().toISOString()
        }
        await store.Put(record)
        return record
    }

    public async List(envName: string): Promise<readonly GraphRecord[]>
    {
        const store = this.StoreFor(this.Require(envName))
        await store.Load()
        return store.List()
    }

    public async Get(envName: string, graphName: string): Promise<GraphRecord>
    {
        const store = this.StoreFor(this.Require(envName))
        await store.Load()
        const record = store.Get(graphName)
        if (!record)
        {
            throw new GraphNotFoundError(graphName)
        }
        return record
    }

    public async Delete(envName: string, graphName: string): Promise<void>
    {
        const store = this.StoreFor(this.Require(envName))
        await store.Load()
        if (!store.Get(graphName))
        {
            throw new GraphNotFoundError(graphName)
        }
        await store.Remove(graphName)
    }

    private Require(envName: string): EnvironmentRecord
    {
        const record = this.environments.Get(envName)
        if (!record)
        {
            throw new EnvironmentNotFoundError(envName)
        }
        if (record.type !== EnvType.Development)
        {
            throw new EnvironmentNotDevelopmentError(envName)
        }
        return record
    }

    private StoreFor(record: EnvironmentRecord): GraphRegistry
    {
        return new GraphRegistry(join(record.bundleDir, GraphService.GraphsFile))
    }

    private static SanitizeGraphName(name: string): string
    {
        if (!GraphService.GraphNamePattern.test(name))
        {
            throw new GraphNameInvalidError(name)
        }
        return name
    }
}
