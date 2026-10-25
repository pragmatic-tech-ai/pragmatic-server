/** The environment contract of the standalone tenant-admin process, shared by the process (reads) and the manifest builder (writes). */
export class TenantAdminEnv
{
    public static readonly DataRoot = 'PRAGMATIC_TENANT_ADMIN_DATA_ROOT'
    public static readonly Port = 'PRAGMATIC_TENANT_ADMIN_PORT'
    public static readonly Bind = 'PRAGMATIC_TENANT_ADMIN_BIND'
    public static readonly BaseDomain = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    public static readonly Scheme = 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME'
    public static readonly SecureCookie = 'PRAGMATIC_TENANT_ADMIN_SECURE_COOKIE'
    public static readonly SecretTtl = 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS'
    public static readonly HealthProbeMs = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS'
    public static readonly HealthProbeTimeoutMs = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS'
    /** Base URL of the platform agent channel; when set the process uses the HTTP rollout client. */
    public static readonly RolloutUrl = 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL'
    /** Per-hive bearer for the agent channel (delivered by Secret reference; never logged). */
    public static readonly RolloutToken = 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN'
    /** The hive the rollout client is bound to. */
    public static readonly RolloutHiveId = 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID'
}
