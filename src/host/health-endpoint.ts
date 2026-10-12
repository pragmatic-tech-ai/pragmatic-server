export interface HealthResult
{
    status: number
    body: string
}

/** Pure routing for the unauthenticated liveness (/healthz) and readiness (/readyz) probes. */
export class HealthEndpoint
{
    private static readonly LivenessPath = '/healthz'
    private static readonly ReadinessPath = '/readyz'
    private static readonly GetMethod = 'GET'
    private static readonly Ok = 200
    private static readonly Unavailable = 503
    private static readonly OkBody = 'ok'
    private static readonly NotReadyBody = 'not ready'

    public Handle(method: string, path: string, ready: boolean): HealthResult | null
    {
        if (method !== HealthEndpoint.GetMethod)
        {
            return null
        }
        if (path === HealthEndpoint.LivenessPath)
        {
            return { status: HealthEndpoint.Ok, body: HealthEndpoint.OkBody }
        }
        if (path === HealthEndpoint.ReadinessPath)
        {
            return ready
                ? { status: HealthEndpoint.Ok, body: HealthEndpoint.OkBody }
                : { status: HealthEndpoint.Unavailable, body: HealthEndpoint.NotReadyBody }
        }
        return null
    }
}
