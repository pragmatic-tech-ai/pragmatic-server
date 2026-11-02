import { TenantApiError } from '../../tenant-api-client.js'

// A read that only enriches a page (health, versions, the rollout): its
// failure degrades to a fallback instead of failing the page. A 401 is still
// session death, so it propagates and the page expires the session.
export class BestEffort
{
    public static async Or<T>(task: Promise<T>, fallback: T): Promise<T>
    {
        try
        {
            return await task
        }
        catch (e)
        {
            BestEffort.RethrowUnauthorized(e)
            return fallback
        }
    }

    public static RethrowUnauthorized(e: unknown): void
    {
        if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
        {
            throw e
        }
    }
}
