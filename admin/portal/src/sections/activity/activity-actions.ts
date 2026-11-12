// What an audited request did, in the operator's words; and its outcome.
export enum ActivityOutcome
{
    Succeeded,
    Refused,
    Failed,
}

interface ActionRule
{
    method: string
    test: RegExp
    label: string
}

// Names audited control-plane requests: the first matching (method, path)
// rule wins; id segments match any non-slash run. An unknown request shows as
// its method and path.
export class ActivityActions
{
    private static readonly SuccessMin = 200
    private static readonly SuccessMax = 299
    private static readonly ServerErrorMin = 500
    private static readonly FallbackSeparator = ' '
    private static readonly QueryMark = '?'

    private static readonly Rules: readonly ActionRule[] = [
        { method: 'POST', test: /^\/api\/releases\/refresh\/?$/, label: 'Refreshed releases from the registry' },
        // Manual publishing is gone; older audit entries keep their name.
        { method: 'POST', test: /^\/api\/manifests\/?$/, label: 'Published a version' },
        { method: 'POST', test: /^\/api\/manifests\/[^/]+\/withdrawn\/?$/, label: 'Withdrew a version' },
        { method: 'DELETE', test: /^\/api\/manifests\/[^/]+\/withdrawn\/?$/, label: 'Restored a version' },
        { method: 'POST', test: /^\/api\/tenants\/[^/]+\/gating\/?$/, label: 'Gated a version' },
        { method: 'DELETE', test: /^\/api\/tenants\/[^/]+\/gating\/[^/]+\/?$/, label: 'Ungated a version' },
        { method: 'PUT', test: /^\/api\/tenants\/[^/]+\/policy\/channels\/?$/, label: 'Set subscribed channels' },
        { method: 'PUT', test: /^\/api\/tenants\/[^/]+\/policy\/min-version\/?$/, label: 'Set the version floor' },
        { method: 'DELETE', test: /^\/api\/tenants\/[^/]+\/policy\/min-version\/?$/, label: 'Cleared the version floor' },
        { method: 'POST', test: /^\/api\/tenants\/[^/]+\/policy\/hold\/?$/, label: 'Held a tenant' },
        { method: 'DELETE', test: /^\/api\/tenants\/[^/]+\/policy\/hold\/?$/, label: 'Released a tenant' },
        { method: 'PUT', test: /^\/api\/hives\/[^/]+\/policy\/channels\/?$/, label: 'Set hive channels' },
        { method: 'PUT', test: /^\/api\/hives\/[^/]+\/policy\/min-version\/?$/, label: 'Set a hive version floor' },
        { method: 'DELETE', test: /^\/api\/hives\/[^/]+\/policy\/min-version\/?$/, label: 'Cleared a hive version floor' },
        { method: 'POST', test: /^\/api\/hives\/[^/]+\/policy\/hold\/?$/, label: 'Held a hive' },
        { method: 'DELETE', test: /^\/api\/hives\/[^/]+\/policy\/hold\/?$/, label: 'Released a hive' },
        { method: 'POST', test: /^\/api\/operators\/?$/, label: 'Invited an operator' },
        { method: 'POST', test: /^\/api\/operators\/role\/?$/, label: 'Changed an operator role' },
        { method: 'POST', test: /^\/api\/operators\/password-reset\/?$/, label: 'Reset a password' },
        { method: 'POST', test: /^\/api\/operators\/disabled\/?$/, label: 'Enabled or disabled an operator' },
        { method: 'POST', test: /^\/api\/operators\/revoke-sessions\/?$/, label: 'Revoked sessions' },
        { method: 'POST', test: /^\/api\/provision\/?$/, label: 'Provisioned' },
        { method: 'POST', test: /^\/api\/clients\/?$/, label: 'Created a client' },
        { method: 'DELETE', test: /^\/api\/clients\/[^/]+\/?$/, label: 'Deleted a client' },
        { method: 'POST', test: /^\/api\/tenants\/?$/, label: 'Created a tenant' },
        { method: 'DELETE', test: /^\/api\/tenants\/[^/]+\/?$/, label: 'Deleted a tenant' },
        { method: 'POST', test: /^\/api\/hives\/?$/, label: 'Created a hive' },
        { method: 'DELETE', test: /^\/api\/hives\/[^/]+\/?$/, label: 'Deleted a hive' },
    ]

    public static Label(method: string, path: string): string
    {
        const bare = path.split(ActivityActions.QueryMark)[0]
        for (const rule of ActivityActions.Rules)
        {
            if (rule.method === method && rule.test.test(bare))
            {
                return rule.label
            }
        }
        return method + ActivityActions.FallbackSeparator + bare
    }

    // 2xx succeeded; 5xx failed; anything else the control plane refused.
    public static Outcome(status: number): ActivityOutcome
    {
        if (status >= ActivityActions.SuccessMin && status <= ActivityActions.SuccessMax)
        {
            return ActivityOutcome.Succeeded
        }
        return status >= ActivityActions.ServerErrorMin ? ActivityOutcome.Failed : ActivityOutcome.Refused
    }
}
