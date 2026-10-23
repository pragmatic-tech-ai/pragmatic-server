export interface WorkerEndpoint
{
    host: string
    port: number
}

/** Routes a tenant to the worker that owns it. Async because the SaaS impl (Redis) does network I/O;
 *  distinct from the per-worker synchronous ITenantCoordinator (connection-refcount/idle-evict). */
export interface IWorkerRouter
{
    RouteOrSpawn(environmentId: string): Promise<WorkerEndpoint>
    Drain(): Promise<void>
}

/** Single-worker router for the in-process topology and self-hosted: every tenant resolves to the one worker. */
export class InMemoryWorkerRouter implements IWorkerRouter
{
    private readonly endpoint: WorkerEndpoint

    public constructor(endpoint: WorkerEndpoint)
    {
        this.endpoint = endpoint
    }

    public async RouteOrSpawn(_tenantId: string): Promise<WorkerEndpoint>
    {
        return this.endpoint
    }

    public async Drain(): Promise<void>
    {
    }
}
