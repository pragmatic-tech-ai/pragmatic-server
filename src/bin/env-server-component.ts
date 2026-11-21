import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'
import { ServerOptionDeclarations } from '@pragmatic-tech-ai/pragmatic-env-cluster'

/**
 * The component descriptor of the env server image (pragmatic-serverd, and pragmatic-workerd from the same image): what
 * `ServerConfigLoader.Load` reads. Stores in Postgres (A5).
 */
export class EnvServerComponent
{
    public static readonly Name = 'pragmatic-env-server'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.0'

    private static readonly Declaration: ComponentDeclaration = {
        name: EnvServerComponent.Name,
        version: EnvServerComponent.Version,
        options: [
            {
                name: 'core',
                description: 'The server process: listener, state folder, environments and master key.',
                settings: [
                    { name: 'host', type: SettingType.String, source: 'PRAGMATIC_HOST', default: '0.0.0.0', description: 'Address the listener binds.' },
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_PORT', default: 8080, description: 'Port the listener binds.' },
                    { name: 'baseDir', type: SettingType.String, source: 'PRAGMATIC_BASE_DIR', required: true, description: 'The state folder.' },
                    { name: 'deploymentMode', type: SettingType.String, source: 'PRAGMATIC_DEPLOYMENT_MODE', default: 'local', description: 'local or cloud.' },
                    { name: 'configFile', type: SettingType.String, source: 'PRAGMATIC_CONFIG_FILE', description: 'Optional JSON file with host, port, baseDir, deploymentMode, idle and Redis defaults.' },
                    { name: 'environmentsFile', type: SettingType.String, source: 'PRAGMATIC_ENVIRONMENTS_FILE', description: 'File listing the environments served (or set environmentId).' },
                    { name: 'environmentId', type: SettingType.String, source: 'PRAGMATIC_ENVIRONMENT_ID', description: 'The single environment served when no environments file is given.' },
                    { name: 'environmentDisplayName', type: SettingType.String, source: 'PRAGMATIC_ENVIRONMENT_DISPLAY_NAME', description: 'Display name of that single environment (defaults to its id).' },
                    { name: 'masterKey', type: SettingType.String, source: 'PRAGMATIC_MASTER_KEY_FILE', required: true, secret: true, description: 'The 32-byte master key (a mounted secret file; PRAGMATIC_MASTER_KEY_B64_ENV may name an environment variable holding it instead).' },
                    { name: 'provisionedSecrets', type: SettingType.String, source: 'PRAGMATIC_PROVISIONED_SECRETS_FILE', secret: true, description: 'The provisioned connection secrets (a mounted secret file).' },
                    { name: 'allowedOrigins', type: SettingType.List, source: 'PRAGMATIC_ALLOWED_ORIGINS', description: 'Browser origins allowed to connect (comma-separated).' },
                    { name: 'idleTtlMs', type: SettingType.Integer, source: 'PRAGMATIC_IDLE_TTL_MS', description: 'An environment idle this many milliseconds is unloaded.' },
                    { name: 'idleSweepMs', type: SettingType.Integer, source: 'PRAGMATIC_IDLE_SWEEP_MS', description: 'Interval of the idle sweep in milliseconds.' },
                    { name: 'drainTimeoutMs', type: SettingType.Integer, source: 'PRAGMATIC_DRAIN_TIMEOUT_MS', default: 25000, description: 'How long shutdown waits for connections to drain, in milliseconds.' },
                    { name: 'healthPort', type: SettingType.Integer, source: 'PRAGMATIC_HEALTH_PORT', description: 'Separate port for /healthz and /readyz (served on the main listener when unset).' },
                ],
            },
            {
                name: 'cluster',
                description: 'Gateway and workers sharing a Redis worker directory.',
                settings: [
                    { name: 'redisUrl', type: SettingType.Url, source: 'PRAGMATIC_REDIS_URL', required: true, description: 'The Redis URL of the worker directory.' },
                    { name: 'replicaId', type: SettingType.String, source: 'PRAGMATIC_REPLICA_ID', description: 'The id of this replica (defaults to HOSTNAME, else a random id).' },
                    { name: 'workerAdvertiseHost', type: SettingType.String, source: 'PRAGMATIC_WORKER_ADVERTISE_HOST', description: 'Host the gateway reaches this worker on.' },
                    { name: 'workerAdvertisePort', type: SettingType.Integer, source: 'PRAGMATIC_WORKER_ADVERTISE_PORT', description: 'Port the gateway reaches this worker on.' },
                    { name: 'workerServerName', type: SettingType.String, source: 'PRAGMATIC_WORKER_SERVERNAME', description: 'TLS server name of the workers.' },
                ],
            },
            ServerOptionDeclarations.Tls,
            ServerOptionDeclarations.ClientTls,
            ServerOptionDeclarations.Observability,
            {
                name: 'audit',
                description: 'Where access audit records go.',
                settings: [
                    { name: 'sink', type: SettingType.String, source: 'PRAGMATIC_AUDIT_SINK', description: 'none, file or sql (sql needs deploymentMode cloud).' },
                    { name: 'file', type: SettingType.String, source: 'PRAGMATIC_AUDIT_FILE', description: 'The audit file (required for sink file).' },
                ],
            },
            ServerOptionDeclarations.RateLimit,
            ServerOptionDeclarations.WebSocket,
            {
                name: 'paging',
                description: 'Query result paging.',
                settings: [
                    { name: 'pageSizeDefault', type: SettingType.Integer, source: 'PRAGMATIC_PAGE_SIZE_DEFAULT', description: 'Default page size.' },
                    { name: 'pageSizeMax', type: SettingType.Integer, source: 'PRAGMATIC_PAGE_SIZE_MAX', description: 'Largest page size a request may ask for.' },
                ],
            },
            {
                name: 'adapterPacks',
                description: 'Signed connector adapter packs, loaded into a sandbox.',
                settings: [
                    { name: 'cacheDir', type: SettingType.String, source: 'PRAGMATIC_ADAPTER_PACKS_DIR', required: true, description: 'The pack cache folder (the feature is off without it).' },
                    { name: 'sandbox', type: SettingType.String, source: 'PRAGMATIC_ADAPTER_PACKS_SANDBOX', default: 'worker', description: 'worker or child.' },
                    { name: 'requireSignatures', type: SettingType.Boolean, source: 'PRAGMATIC_ADAPTER_PACKS_REQUIRE_SIGNATURES', description: 'Refuse unsigned packs.' },
                    { name: 'maxOldMb', type: SettingType.Integer, source: 'PRAGMATIC_ADAPTER_PACKS_MAX_OLD_MB', description: 'Old-generation heap limit of a pack, in MB.' },
                    { name: 'maxYoungMb', type: SettingType.Integer, source: 'PRAGMATIC_ADAPTER_PACKS_MAX_YOUNG_MB', description: 'Young-generation heap limit of a pack, in MB.' },
                    { name: 'stackMb', type: SettingType.Integer, source: 'PRAGMATIC_ADAPTER_PACKS_STACK_MB', description: 'Stack limit of a pack, in MB.' },
                    { name: 'evictMaxVersions', type: SettingType.Integer, source: 'PRAGMATIC_ADAPTER_PACKS_EVICT_MAX_VERSIONS', description: 'Versions of one pack kept in the cache.' },
                    { name: 'evictMaxAgeMs', type: SettingType.Integer, source: 'PRAGMATIC_ADAPTER_PACKS_EVICT_MAX_AGE_MS', description: 'Age in milliseconds after which an unused pack version is evicted.' },
                    { name: 'scriptAllowlist', type: SettingType.List, source: 'PRAGMATIC_ADAPTER_PACKS_SCRIPT_ALLOWLIST', description: 'Packs allowed to run scripts (comma-separated names).' },
                ],
            },
            {
                name: 'cloud',
                description: 'Cloud deployment (deploymentMode cloud): the provider and its key references; the option of the provider holds the rest.',
                settings: [
                    { name: 'provider', type: SettingType.String, source: 'PRAGMATIC_CLOUD_PROVIDER', required: true, description: 'gcp, aws or azure.' },
                    { name: 'masterKeyRef', type: SettingType.String, source: 'PRAGMATIC_CLOUD_MASTER_KEY_REF', required: true, description: 'The provider KMS key that wraps the master key.' },
                    { name: 'auditAnchorKeyRef', type: SettingType.String, source: 'PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF', description: 'The KMS key that signs audit anchors.' },
                    { name: 'auditAnchorInterval', type: SettingType.Integer, source: 'PRAGMATIC_CLOUD_AUDIT_ANCHOR_INTERVAL', description: 'Audit records between two anchors (at least 1).' },
                ],
            },
            {
                name: 'gcp',
                description: 'Google Cloud: Cloud Storage and Cloud SQL.',
                settings: [
                    { name: 'project', type: SettingType.String, source: 'PRAGMATIC_GCP_PROJECT', required: true, description: 'The project id.' },
                    { name: 'gcsBucket', type: SettingType.String, source: 'PRAGMATIC_GCS_BUCKET', required: true, description: 'The Cloud Storage bucket.' },
                    { name: 'gcsPrefix', type: SettingType.String, source: 'PRAGMATIC_GCS_PREFIX', description: 'Object name prefix in the bucket.' },
                    { name: 'cloudSqlInstance', type: SettingType.String, source: 'PRAGMATIC_CLOUDSQL_INSTANCE', required: true, description: 'The Cloud SQL instance connection name.' },
                    { name: 'cloudSqlUser', type: SettingType.String, source: 'PRAGMATIC_CLOUDSQL_USER', required: true, description: 'The database user (IAM).' },
                    { name: 'cloudSqlDatabase', type: SettingType.String, source: 'PRAGMATIC_CLOUDSQL_DB', required: true, description: 'The database.' },
                    { name: 'cloudSqlIpType', type: SettingType.String, source: 'PRAGMATIC_CLOUDSQL_IPTYPE', description: 'PUBLIC, PRIVATE or PSC.' },
                    { name: 'cloudSqlAuth', type: SettingType.String, source: 'PRAGMATIC_CLOUDSQL_AUTH', default: 'iam', description: 'Only iam is supported.' },
                ],
            },
            {
                name: 'aws',
                description: 'AWS: S3 and RDS for PostgreSQL.',
                settings: [
                    { name: 'region', type: SettingType.String, source: 'PRAGMATIC_AWS_REGION', required: true, description: 'The region.' },
                    { name: 's3Bucket', type: SettingType.String, source: 'PRAGMATIC_S3_BUCKET', required: true, description: 'The S3 bucket.' },
                    { name: 's3Prefix', type: SettingType.String, source: 'PRAGMATIC_S3_PREFIX', description: 'Object key prefix in the bucket.' },
                    { name: 'rdsHost', type: SettingType.String, source: 'PRAGMATIC_RDS_HOST', required: true, description: 'The RDS endpoint.' },
                    { name: 'rdsPort', type: SettingType.Integer, source: 'PRAGMATIC_RDS_PORT', description: 'The RDS port.' },
                    { name: 'rdsUser', type: SettingType.String, source: 'PRAGMATIC_RDS_USER', required: true, description: 'The database user.' },
                    { name: 'rdsDatabase', type: SettingType.String, source: 'PRAGMATIC_RDS_DB', required: true, description: 'The database.' },
                    { name: 'rdsAuth', type: SettingType.String, source: 'PRAGMATIC_RDS_AUTH', description: 'iam or password.' },
                    { name: 'rdsPassword', type: SettingType.String, source: 'PRAGMATIC_RDS_PASSWORD_REF', secret: true, description: 'The database password for rdsAuth password (PRAGMATIC_RDS_PASSWORD_REF names it in Secrets Manager).' },
                ],
            },
            {
                name: 'azure',
                description: 'Azure: Blob Storage, Key Vault and Database for PostgreSQL.',
                settings: [
                    { name: 'storageAccount', type: SettingType.String, source: 'PRAGMATIC_AZURE_STORAGE_ACCOUNT', required: true, description: 'The storage account.' },
                    { name: 'blobContainer', type: SettingType.String, source: 'PRAGMATIC_BLOB_CONTAINER', required: true, description: 'The blob container.' },
                    { name: 'blobPrefix', type: SettingType.String, source: 'PRAGMATIC_BLOB_PREFIX', description: 'Blob name prefix in the container.' },
                    { name: 'keyVaultUrl', type: SettingType.Url, source: 'PRAGMATIC_AZURE_KEYVAULT_URL', required: true, description: 'The Key Vault URL.' },
                    { name: 'postgresHost', type: SettingType.String, source: 'PRAGMATIC_AZPG_HOST', required: true, description: 'The Postgres server host.' },
                    { name: 'postgresPort', type: SettingType.Integer, source: 'PRAGMATIC_AZPG_PORT', description: 'The Postgres port.' },
                    { name: 'postgresUser', type: SettingType.String, source: 'PRAGMATIC_AZPG_USER', required: true, description: 'The database user.' },
                    { name: 'postgresDatabase', type: SettingType.String, source: 'PRAGMATIC_AZPG_DB', required: true, description: 'The database.' },
                    { name: 'postgresAuth', type: SettingType.String, source: 'PRAGMATIC_AZPG_AUTH', description: 'entra or password.' },
                    { name: 'postgresPassword', type: SettingType.String, source: 'PRAGMATIC_AZPG_PASSWORD_REF', secret: true, description: 'The database password for postgresAuth password (PRAGMATIC_AZPG_PASSWORD_REF names it in Key Vault).' },
                ],
            },
        ],
        roles: [],
        postgres: true,
        ports: [{ name: 'http', number: 8080 }],
        health: { port: 'http', path: '/healthz' },
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(EnvServerComponent.Declaration)
    }
}
