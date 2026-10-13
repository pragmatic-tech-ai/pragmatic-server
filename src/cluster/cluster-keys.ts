/** The Redis key namespace shared by the worker tier: WorkerRegistration writes/reads the live-worker set and
 *  RedisWorkerRouter reads it + claims per-tenant routes. One home so the producer/consumer contract can't drift. */
export class ClusterKeys
{
    public static readonly Workers = 'pragmatic:workers'
    public static readonly RoutePrefix = 'pragmatic:route:'
    public static readonly OidcFlowPrefix = 'pragmatic:oidc:flow:'
}
