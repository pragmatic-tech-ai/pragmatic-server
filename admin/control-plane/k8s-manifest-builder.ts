import type { EnvironmentWorkload, WorkloadDatabase } from './environment-workload.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import { IdpContainerEnv } from './idp-container-env.js'
import type { IdpWorkloadSpec } from './idp-workload-driver.js'
import { TenantAdminEnv } from './tenant-admin-env.js'
import type { TenantAdminWorkloadSpec } from './tenant-admin-workload.js'

export type K8sObject = Record<string, unknown>

/** Renders an EnvironmentWorkload as a kubectl-appliable v1 List. Secrets are referenced by name only. */
export class K8sManifestBuilder
{
    // k8s external-contract keys and values.
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly SpecKey = 'spec'
    private static readonly LabelsKey = 'labels'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly ItemsKey = 'items'
    private static readonly ReplicasKey = 'replicas'
    private static readonly SelectorKey = 'selector'
    private static readonly MatchLabelsKey = 'matchLabels'
    private static readonly TemplateKey = 'template'
    private static readonly ContainersKey = 'containers'
    private static readonly ImageKey = 'image'
    private static readonly ImagePullPolicyKey = 'imagePullPolicy'
    private static readonly PortsKey = 'ports'
    private static readonly ContainerPortKey = 'containerPort'
    private static readonly PortKey = 'port'
    private static readonly TargetPortKey = 'targetPort'
    private static readonly EnvKey = 'env'
    private static readonly ValueKey = 'value'
    private static readonly ValueFromKey = 'valueFrom'
    private static readonly SecretKeyRefKey = 'secretKeyRef'
    private static readonly KeyKey = 'key'
    private static readonly ReadinessProbeKey = 'readinessProbe'
    private static readonly HttpGetKey = 'httpGet'
    private static readonly PathKey = 'path'
    private static readonly TypeKey = 'type'
    private static readonly ClusterIpKey = 'clusterIP'
    private static readonly ServiceNameKey = 'serviceName'
    private static readonly VolumeMountsKey = 'volumeMounts'
    private static readonly MountPathKey = 'mountPath'
    private static readonly VolumeClaimTemplatesKey = 'volumeClaimTemplates'
    private static readonly AccessModesKey = 'accessModes'
    private static readonly ResourcesKey = 'resources'
    private static readonly RequestsKey = 'requests'
    private static readonly StorageKey = 'storage'
    private static readonly ServiceAccountNameKey = 'serviceAccountName'
    private static readonly CommandKey = 'command'
    private static readonly RulesKey = 'rules'
    private static readonly ApiGroupsKey = 'apiGroups'
    private static readonly ApiGroupKey = 'apiGroup'
    private static readonly VerbsKey = 'verbs'
    private static readonly ResourceNamesKey = 'resourceNames'
    private static readonly SubjectsKey = 'subjects'
    private static readonly RoleRefKey = 'roleRef'

    private static readonly ApiVersionCore = 'v1'
    private static readonly ApiVersionApps = 'apps/v1'
    private static readonly ListKind = 'List'
    private static readonly NamespaceKind = 'Namespace'
    private static readonly DeploymentKind = 'Deployment'
    private static readonly ServiceKind = 'Service'
    private static readonly StatefulSetKind = 'StatefulSet'
    private static readonly ApiVersionRbac = 'rbac.authorization.k8s.io/v1'
    private static readonly RbacApiGroup = 'rbac.authorization.k8s.io'
    private static readonly ServiceAccountKind = 'ServiceAccount'
    private static readonly RoleKind = 'Role'
    private static readonly RoleBindingKind = 'RoleBinding'
    private static readonly ClusterRoleKind = 'ClusterRole'
    private static readonly ClusterRoleBindingKind = 'ClusterRoleBinding'
    private static readonly AppsApiGroup = 'apps'
    private static readonly DeploymentsResource = 'deployments'
    private static readonly GetVerb = 'get'
    private static readonly ListVerb = 'list'
    private static readonly PatchVerb = 'patch'
    private static readonly IfNotPresent = 'IfNotPresent'
    private static readonly ClusterIpType = 'ClusterIP'
    private static readonly HeadlessClusterIp = 'None'
    private static readonly ReadWriteOnce = 'ReadWriteOnce'

    // Pragmatic conventions.
    private static readonly EnvironmentLabel = 'pragmatic/environment'
    private static readonly HiveLabel = 'pragmatic/hive'
    private static readonly AppLabel = 'pragmatic/app'
    private static readonly NamespacePrefix = 'pragmatic-env-'
    private static readonly ServerSuffix = 'server'
    private static readonly DatabaseSuffix = 'postgres'
    /** Same path DockerEnv.WaitHealthy polls. */
    private static readonly HealthPath = '/healthz'
    private static readonly PostgresPort = 5432
    private static readonly PostgresDataPath = '/var/lib/postgresql/data'
    private static readonly PostgresUserVar = 'POSTGRES_USER'
    private static readonly PostgresDbVar = 'POSTGRES_DB'
    private static readonly PostgresPasswordVar = 'POSTGRES_PASSWORD'
    private static readonly PasswordSecretKey = 'password'
    private static readonly DataVolumeName = 'data'
    private static readonly DataVolumeSize = '1Gi'
    private static readonly SingleReplica = 1

    // Pull-agent conventions.
    private static readonly AgentSuffix = 'agent'
    private static readonly AgentImage = 'pragmatic-server:dev'
    private static readonly AgentContainerName = 'agent'
    private static readonly AgentEntrypoint = ['node', 'dist/bin/pragmatic-agentd.js']
    private static readonly AgentRegistryUrlVar = 'PRAGMATIC_AGENT_REGISTRY_URL'
    private static readonly AgentHiveIdVar = 'PRAGMATIC_AGENT_HIVE_ID'
    private static readonly AgentTokenVar = 'PRAGMATIC_AGENT_TOKEN'
    private static readonly AgentTokenSecretKey = 'token'
    /** Namespace hosting the per-hive agent's ServiceAccount + Deployment (cluster-scoped RBAC has none). The Namespace object itself is emitted by RenderHiveAgent. */
    public static readonly SystemNamespace = 'pragmatic-system'
    private static readonly HiveAgentNamespace = K8sManifestBuilder.SystemNamespace
    private static readonly HiveAgentPrefix = 'pragmatic-hive-'

    // IdP workload conventions.
    private static readonly IdpPrefix = IdpContainerEnv.NamePrefix
    private static readonly IdpContainerName = 'idp'
    private static readonly IdpEntrypoint = ['node', 'dist/bin/pragmatic-idpd.js']
    private static readonly IdpDataMount = '/idp-data'
    private static readonly IdpTlsMount = '/idp-data/tls'
    private static readonly IdpSecretsMount = '/idp-data/secrets'
    private static readonly TmpMount = '/tmp'
    private static readonly IdpBindAll = '0.0.0.0'
    private static readonly IdpPortVar = 'PRAGMATIC_IDP_PORT'
    private static readonly IdpBaseUrlVar = 'PRAGMATIC_IDP_BASE_URL'
    private static readonly IdpHostVar = 'PRAGMATIC_IDP_HOST'
    private static readonly IdpDataVar = 'PRAGMATIC_IDP_DATA'
    private static readonly IdpAdminTokenRefVar = 'PRAGMATIC_IDP_ADMIN_TOKEN_REF'
    private static readonly IdpDnsSuffix = 'svc.cluster.local'
    private static readonly IdpScheme = 'https'
    private static readonly HttpsScheme = 'HTTPS'
    private static readonly IdpDataSuffix = '-data'
    private static readonly IdpDataVolume = 'data'
    private static readonly IdpTlsVolume = 'tls'
    private static readonly IdpSecretsVolume = 'secrets'
    private static readonly TmpVolume = 'tmp'
    private static readonly IdpDataSize = '256Mi'
    private static readonly SecretFileMode = 0o440
    private static readonly PersistentVolumeClaimKind = 'PersistentVolumeClaim'
    private static readonly VolumesKey = 'volumes'
    private static readonly SecretKey = 'secret'
    private static readonly SecretNameKey = 'secretName'
    private static readonly DefaultModeKey = 'defaultMode'
    private static readonly PersistentVolumeClaimKey = 'persistentVolumeClaim'
    private static readonly ClaimNameKey = 'claimName'
    private static readonly EmptyDirKey = 'emptyDir'
    private static readonly ReadOnlyKey = 'readOnly'
    private static readonly SchemeKey = 'scheme'
    private static readonly SecurityContextKey = 'securityContext'
    private static readonly RunAsNonRootKey = 'runAsNonRoot'
    private static readonly RunAsUserKey = 'runAsUser'
    private static readonly FsGroupKey = 'fsGroup'
    private static readonly CapabilitiesKey = 'capabilities'
    private static readonly DropKey = 'drop'
    private static readonly AllCapabilities = 'ALL'
    private static readonly SeccompProfileKey = 'seccompProfile'
    private static readonly RuntimeDefault = 'RuntimeDefault'
    /** Non-root uid the IdP image runs as (the 'node' user); also the pod fsGroup so the PVC is writable and 0440 secrets readable. */
    private static readonly IdpUid = 1000
    private static readonly AllowPrivilegeEscalationKey = 'allowPrivilegeEscalation'
    private static readonly ReadOnlyRootFilesystemKey = 'readOnlyRootFilesystem'
    private static readonly AutomountTokenKey = 'automountServiceAccountToken'

    // Tenant-admin workload conventions.
    private static readonly TenantAdminPrefix = 'pragmatic-tenant-admin-'
    private static readonly TenantAdminContainerName = 'tenant-admin'
    private static readonly TenantAdminSeedContainerName = 'seed'
    private static readonly TenantAdminEntrypoint = ['node', 'dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js']
    /** Copies every seeded file into the writable data root; --no-preserve=mode so the app can rewrite its own state files, -f so a restart overwrites. */
    private static readonly TenantAdminSeedCommand = ['sh', '-c', 'cp -f --no-preserve=mode /seed/* /data/']
    private static readonly TenantAdminDataMount = '/data'
    private static readonly TenantAdminSeedMount = '/seed'
    private static readonly TenantAdminDataVolume = 'data'
    private static readonly TenantAdminSeedVolume = 'seed'
    private static readonly TenantAdminDataSuffix = '-data'
    private static readonly TenantAdminSeedSuffix = '-seed'
    private static readonly TenantAdminDataSize = '256Mi'
    private static readonly TenantAdminBindAll = '0.0.0.0'
    private static readonly TenantAdminUid = 10001
    /** Non-root uid the server image runs as (docker/Dockerfile `USER 10001`); also the pod fsGroup so the 0440 Secret files are readable and the data PVC is writable. */
    private static readonly ServerUid = 10001
    private static readonly TenantAdminRootPath = '/'
    private static readonly HostHeader = 'Host'
    private static readonly HttpHeadersKey = 'httpHeaders'
    private static readonly InitContainersKey = 'initContainers'
    private static readonly ImagePullSecretsKey = 'imagePullSecrets'
    private static readonly HttpsSchemeName = 'https'
    private static readonly TrueText = 'true'
    private static readonly FalseText = 'false'
    private static readonly HostSeparator = '.'
    private static readonly AgentTokenSecretSuffix = '-token'

    // In-cluster server boot wiring (env var names and file contract match environments/seed/docker.ts).
    private static readonly ConfigMapKey = 'configMap'
    private static readonly BaseDirVar = 'PRAGMATIC_BASE_DIR'
    private static readonly TenantsFileVar = 'PRAGMATIC_TENANTS_FILE'
    private static readonly MasterKeyFileVar = 'PRAGMATIC_MASTER_KEY_FILE'
    private static readonly SecretsFileVar = 'PRAGMATIC_PROVISIONED_SECRETS_FILE'
    private static readonly DeploymentModeVar = 'PRAGMATIC_DEPLOYMENT_MODE'
    private static readonly DeploymentModeLocal = 'local'
    private static readonly ServerDataMount = '/pragmatic/data'
    private static readonly ServerConfigMount = '/pragmatic/config'
    private static readonly ServerSecretsMount = '/pragmatic/secrets'
    private static readonly ServerConfigVolume = 'config'
    private static readonly ServerSecretsVolume = 'secrets'
    private static readonly ServerDataVolume = 'data'
    private static readonly ServerDataClaimSuffix = '-data'
    private static readonly PathSeparator = '/'
    private static readonly ServerSeedMount = '/pragmatic/seed'
    private static readonly ServerSeedVolume = 'seed'
    private static readonly ServerSeedContainerName = 'seed'
    private static readonly NodeBinary = 'node'
    private static readonly NodeEvalFlag = '-e'
    /**
     * Unpacks seed.json ({ relpath: base64 }) into the env data dir (argv[1]) unless the marker exists. Idempotent: a restart never clobbers live state.
     * Rejects relpaths that escape the data dir.
     */
    private static readonly ServerSeedMarkerFile = '.env-seeded'
    private static readonly ServerSeedFile = EnvServerSeedSource.SeedKey
    private static readonly ServerSeedEscapeMessage = 'seed path escapes data dir: '
    public static readonly ServerSeedScript = [
        "const fs=require('fs'),p=require('path');",
        `const d=p.resolve(process.argv[1]);const m=p.join(d,'${K8sManifestBuilder.ServerSeedMarkerFile}');`,
        'if(!fs.existsSync(m)){',
        "const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));",
        'for(const [r,b] of Object.entries(s)){',
        'const t=p.resolve(d,r);',
        `if(t!==d&&!t.startsWith(d+p.sep))throw new Error('${K8sManifestBuilder.ServerSeedEscapeMessage}'+r);`,
        'fs.mkdirSync(p.dirname(t),{recursive:true});',
        "fs.writeFileSync(t,Buffer.from(b,'base64'));}",
        "fs.mkdirSync(d,{recursive:true});fs.writeFileSync(m,'');}",
    ].join('')

    public static readonly ServerContainerName = 'server'

    public static ServerDataClaimNameOf(environmentName: string): string
    {
        return `${K8sManifestBuilder.ServerDeploymentOf(environmentName)}${K8sManifestBuilder.ServerDataClaimSuffix}`
    }

    public static NamespaceOf(environmentName: string): string
    {
        return K8sManifestBuilder.NamespacePrefix + environmentName
    }

    public static ServerDeploymentOf(environmentName: string): string
    {
        return `${K8sManifestBuilder.NamespaceOf(environmentName)}-${K8sManifestBuilder.ServerSuffix}`
    }

    public Render(workload: EnvironmentWorkload): string
    {
        const items: K8sObject[] = [
            this.Namespace(workload),
            this.ServerDeployment(workload),
            this.ServerService(workload),
        ]
        if (workload.database)
        {
            items.push(this.DatabaseStatefulSet(workload, workload.database))
            items.push(this.DatabaseService(workload))
        }
        items.push(this.ServerDataClaim(workload))
        return JSON.stringify({
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ListKind,
            [K8sManifestBuilder.ItemsKey]: items,
        })
    }

    public static DatabaseOf(environmentName: string): string
    {
        return `${K8sManifestBuilder.NamespaceOf(environmentName)}-${K8sManifestBuilder.DatabaseSuffix}`
    }

    public static HiveAgentNameOf(hiveId: string): string
    {
        return `${K8sManifestBuilder.HiveAgentPrefix}${hiveId}-${K8sManifestBuilder.AgentSuffix}`
    }

    /** Renders the single per-hive pull agent: SA + cluster-wide get/list/patch on deployments + Deployment. */
    public RenderHiveAgent(hiveId: string, registryUrl: string, tokenSecretName: string): string
    {
        const items: K8sObject[] = [
            this.HiveAgentNamespaceObject(),
            this.HiveAgentServiceAccount(hiveId),
            this.HiveAgentClusterRole(hiveId),
            this.HiveAgentClusterRoleBinding(hiveId),
            this.HiveAgentDeployment(hiveId, registryUrl, tokenSecretName),
        ]
        return JSON.stringify({
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ListKind,
            [K8sManifestBuilder.ItemsKey]: items,
        })
    }

    /** Shared across hives, so deliberately NOT hive-labeled: a label-scoped delete of one hive must not drop it. */
    private HiveAgentNamespaceObject(): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.NamespaceKind,
            [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.HiveAgentNamespace },
        }
    }

    private HiveLabels(hiveId: string): Record<string, string>
    {
        return { [K8sManifestBuilder.HiveLabel]: hiveId }
    }

    /** Labels on an environment server deployment: the hive plus the environment marker the in-cluster agent's selector requires (agent objects deliberately lack it). */
    private EnvironmentDeploymentLabels(workload: EnvironmentWorkload): Record<string, string>
    {
        return {
            [K8sManifestBuilder.EnvironmentLabel]: workload.environmentName,
            [K8sManifestBuilder.HiveLabel]: workload.hiveId,
        }
    }

    private HiveAgentNamespacedMeta(hiveId: string, name: string): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: name,
            [K8sManifestBuilder.NamespaceKey]: K8sManifestBuilder.HiveAgentNamespace,
            [K8sManifestBuilder.LabelsKey]: this.HiveLabels(hiveId),
        }
    }

    private HiveAgentClusterMeta(hiveId: string, name: string): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: name,
            [K8sManifestBuilder.LabelsKey]: this.HiveLabels(hiveId),
        }
    }

    private HiveAgentServiceAccount(hiveId: string): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceAccountKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(hiveId, K8sManifestBuilder.HiveAgentNameOf(hiveId)),
        }
    }

    // Cluster-scoped get/list/patch on deployments: k8s RBAC cannot scope list/patch by label, and the agent must
    // discover its hive's environment deployments across namespaces, so the grant is cluster-wide by necessity. The
    // agent bounds what it actually touches with the app-level selector (pragmatic/hive + pragmatic/environment), not
    // RBAC; a compromised hive-agent token could patch any deployment's image cluster-wide (never secrets/create/delete).
    private HiveAgentClusterRole(hiveId: string): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionRbac,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ClusterRoleKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentClusterMeta(hiveId, K8sManifestBuilder.HiveAgentNameOf(hiveId)),
            [K8sManifestBuilder.RulesKey]: [{
                [K8sManifestBuilder.ApiGroupsKey]: [K8sManifestBuilder.AppsApiGroup],
                [K8sManifestBuilder.ResourcesKey]: [K8sManifestBuilder.DeploymentsResource],
                [K8sManifestBuilder.VerbsKey]: [K8sManifestBuilder.GetVerb, K8sManifestBuilder.ListVerb, K8sManifestBuilder.PatchVerb],
            }],
        }
    }

    private HiveAgentClusterRoleBinding(hiveId: string): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionRbac,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ClusterRoleBindingKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentClusterMeta(hiveId, K8sManifestBuilder.HiveAgentNameOf(hiveId)),
            [K8sManifestBuilder.SubjectsKey]: [{
                [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceAccountKind,
                [K8sManifestBuilder.NameKey]: K8sManifestBuilder.HiveAgentNameOf(hiveId),
                [K8sManifestBuilder.NamespaceKey]: K8sManifestBuilder.HiveAgentNamespace,
            }],
            [K8sManifestBuilder.RoleRefKey]: {
                [K8sManifestBuilder.ApiGroupKey]: K8sManifestBuilder.RbacApiGroup,
                [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ClusterRoleKind,
                [K8sManifestBuilder.NameKey]: K8sManifestBuilder.HiveAgentNameOf(hiveId),
            },
        }
    }

    private HiveAgentDeployment(hiveId: string, registryUrl: string, tokenSecretName: string): K8sObject
    {
        const name = K8sManifestBuilder.HiveAgentNameOf(hiveId)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionApps,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.DeploymentKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(hiveId, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.ReplicasKey]: K8sManifestBuilder.SingleReplica,
                [K8sManifestBuilder.SelectorKey]: { [K8sManifestBuilder.MatchLabelsKey]: this.Selector(name) },
                [K8sManifestBuilder.TemplateKey]: {
                    [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.LabelsKey]: this.Selector(name) },
                    [K8sManifestBuilder.SpecKey]: {
                        [K8sManifestBuilder.ServiceAccountNameKey]: K8sManifestBuilder.HiveAgentNameOf(hiveId),
                        [K8sManifestBuilder.ContainersKey]: [{
                            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.AgentContainerName,
                            [K8sManifestBuilder.ImageKey]: K8sManifestBuilder.AgentImage,
                            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
                            [K8sManifestBuilder.CommandKey]: K8sManifestBuilder.AgentEntrypoint,
                            [K8sManifestBuilder.EnvKey]: [
                                this.EnvLiteral(K8sManifestBuilder.AgentRegistryUrlVar, registryUrl),
                                this.EnvLiteral(K8sManifestBuilder.AgentHiveIdVar, hiveId),
                                {
                                    [K8sManifestBuilder.NameKey]: K8sManifestBuilder.AgentTokenVar,
                                    [K8sManifestBuilder.ValueFromKey]: {
                                        [K8sManifestBuilder.SecretKeyRefKey]: {
                                            [K8sManifestBuilder.NameKey]: tokenSecretName,
                                            [K8sManifestBuilder.KeyKey]: K8sManifestBuilder.AgentTokenSecretKey,
                                        },
                                    },
                                },
                            ],
                        }],
                    },
                },
            },
        }
    }

    public static IdpNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.IdpPrefix}${tenantId}`
    }

    public static IdpClaimNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.IdpNameOf(tenantId)}${K8sManifestBuilder.IdpDataSuffix}`
    }

    /** In-cluster Service DNS origin of a tenant's IdP (service and namespace share the name). */
    public static IdpBaseUrlOf(tenantId: string, port: number): string
    {
        const name = K8sManifestBuilder.IdpNameOf(tenantId)
        return `${K8sManifestBuilder.IdpScheme}://${name}.${name}.${K8sManifestBuilder.IdpDnsSuffix}:${port}`
    }

    /** Renders one tenant's IdP as an in-cluster workload: Namespace, SA (no API token), PVC, Deployment, ClusterIP Service. Hive-labeled only (no environment label, so the pull agent never selects it); secrets mounted by Secret name, never inline; no RBAC. */
    public RenderIdp(spec: IdpWorkloadSpec): string
    {
        const items: K8sObject[] = [
            this.IdpNamespaceObject(spec),
            this.IdpServiceAccount(spec),
            this.IdpClaim(spec),
            this.IdpDeployment(spec),
            this.IdpServiceObject(spec),
        ]
        return JSON.stringify({
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ListKind,
            [K8sManifestBuilder.ItemsKey]: items,
        })
    }

    private IdpMeta(spec: IdpWorkloadSpec, name: string): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: name,
            [K8sManifestBuilder.NamespaceKey]: K8sManifestBuilder.IdpNameOf(spec.tenantId),
            [K8sManifestBuilder.LabelsKey]: this.HiveLabels(spec.hiveId),
        }
    }

    private IdpNamespaceObject(spec: IdpWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.NamespaceKind,
            [K8sManifestBuilder.MetadataKey]: {
                [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpNameOf(spec.tenantId),
                [K8sManifestBuilder.LabelsKey]: this.HiveLabels(spec.hiveId),
            },
        }
    }

    private IdpServiceAccount(spec: IdpWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceAccountKind,
            [K8sManifestBuilder.MetadataKey]: this.IdpMeta(spec, K8sManifestBuilder.IdpNameOf(spec.tenantId)),
            [K8sManifestBuilder.AutomountTokenKey]: false,
        }
    }

    private IdpClaim(spec: IdpWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.PersistentVolumeClaimKind,
            [K8sManifestBuilder.MetadataKey]: this.IdpMeta(spec, K8sManifestBuilder.IdpClaimNameOf(spec.tenantId)),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.AccessModesKey]: [K8sManifestBuilder.ReadWriteOnce],
                [K8sManifestBuilder.ResourcesKey]: {
                    [K8sManifestBuilder.RequestsKey]: { [K8sManifestBuilder.StorageKey]: K8sManifestBuilder.IdpDataSize },
                },
            },
        }
    }

    private SecretVolume(volumeName: string, secretName: string): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: volumeName,
            [K8sManifestBuilder.SecretKey]: {
                [K8sManifestBuilder.SecretNameKey]: secretName,
                [K8sManifestBuilder.DefaultModeKey]: K8sManifestBuilder.SecretFileMode,
            },
        }
    }

    private IdpDeployment(spec: IdpWorkloadSpec): K8sObject
    {
        const name = K8sManifestBuilder.IdpNameOf(spec.tenantId)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionApps,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.DeploymentKind,
            [K8sManifestBuilder.MetadataKey]: this.IdpMeta(spec, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.ReplicasKey]: K8sManifestBuilder.SingleReplica,
                [K8sManifestBuilder.SelectorKey]: { [K8sManifestBuilder.MatchLabelsKey]: this.Selector(name) },
                [K8sManifestBuilder.TemplateKey]: {
                    [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.LabelsKey]: this.Selector(name) },
                    [K8sManifestBuilder.SpecKey]: {
                        [K8sManifestBuilder.ServiceAccountNameKey]: name,
                        [K8sManifestBuilder.AutomountTokenKey]: false,
                        [K8sManifestBuilder.SecurityContextKey]: { [K8sManifestBuilder.FsGroupKey]: K8sManifestBuilder.IdpUid },
                        [K8sManifestBuilder.ContainersKey]: [this.IdpContainer(spec)],
                        [K8sManifestBuilder.VolumesKey]: [
                            {
                                [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpDataVolume,
                                [K8sManifestBuilder.PersistentVolumeClaimKey]: { [K8sManifestBuilder.ClaimNameKey]: K8sManifestBuilder.IdpClaimNameOf(spec.tenantId) },
                            },
                            this.SecretVolume(K8sManifestBuilder.IdpTlsVolume, spec.tlsSecretName),
                            this.SecretVolume(K8sManifestBuilder.IdpSecretsVolume, spec.adminTokenSecretName),
                            { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TmpVolume, [K8sManifestBuilder.EmptyDirKey]: {} },
                        ],
                    },
                },
            },
        }
    }

    private IdpContainer(spec: IdpWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpContainerName,
            [K8sManifestBuilder.ImageKey]: spec.image,
            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
            [K8sManifestBuilder.CommandKey]: K8sManifestBuilder.IdpEntrypoint,
            [K8sManifestBuilder.PortsKey]: [{ [K8sManifestBuilder.ContainerPortKey]: spec.port }],
            [K8sManifestBuilder.SecurityContextKey]: {
                [K8sManifestBuilder.RunAsNonRootKey]: true,
                [K8sManifestBuilder.RunAsUserKey]: K8sManifestBuilder.IdpUid,
                [K8sManifestBuilder.AllowPrivilegeEscalationKey]: false,
                [K8sManifestBuilder.CapabilitiesKey]: { [K8sManifestBuilder.DropKey]: [K8sManifestBuilder.AllCapabilities] },
                [K8sManifestBuilder.SeccompProfileKey]: { [K8sManifestBuilder.TypeKey]: K8sManifestBuilder.RuntimeDefault },
                [K8sManifestBuilder.ReadOnlyRootFilesystemKey]: true,
            },
            [K8sManifestBuilder.EnvKey]: [
                this.EnvLiteral(K8sManifestBuilder.IdpPortVar, String(spec.port)),
                this.EnvLiteral(K8sManifestBuilder.IdpBaseUrlVar, K8sManifestBuilder.IdpBaseUrlOf(spec.tenantId, spec.port)),
                this.EnvLiteral(K8sManifestBuilder.IdpHostVar, K8sManifestBuilder.IdpBindAll),
                this.EnvLiteral(K8sManifestBuilder.IdpDataVar, K8sManifestBuilder.IdpDataMount),
                this.EnvLiteral(K8sManifestBuilder.IdpAdminTokenRefVar, spec.adminTokenRef),
            ],
            [K8sManifestBuilder.VolumeMountsKey]: [
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.IdpDataMount },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpTlsVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.IdpTlsMount, [K8sManifestBuilder.ReadOnlyKey]: true },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpSecretsVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.IdpSecretsMount, [K8sManifestBuilder.ReadOnlyKey]: true },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TmpVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TmpMount },
            ],
            [K8sManifestBuilder.ReadinessProbeKey]: {
                [K8sManifestBuilder.HttpGetKey]: {
                    [K8sManifestBuilder.PathKey]: K8sManifestBuilder.HealthPath,
                    [K8sManifestBuilder.PortKey]: spec.port,
                    [K8sManifestBuilder.SchemeKey]: K8sManifestBuilder.HttpsScheme,
                },
            },
        }
    }

    private IdpServiceObject(spec: IdpWorkloadSpec): K8sObject
    {
        const name = K8sManifestBuilder.IdpNameOf(spec.tenantId)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceKind,
            [K8sManifestBuilder.MetadataKey]: this.IdpMeta(spec, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.TypeKey]: K8sManifestBuilder.ClusterIpType,
                [K8sManifestBuilder.SelectorKey]: this.Selector(name),
                [K8sManifestBuilder.PortsKey]: [{
                    [K8sManifestBuilder.PortKey]: spec.port,
                    [K8sManifestBuilder.TargetPortKey]: spec.port,
                }],
            },
        }
    }

    public static TenantAdminNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminPrefix}${tenantId}`
    }

    public static TenantAdminClaimNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminNameOf(tenantId)}${K8sManifestBuilder.TenantAdminDataSuffix}`
    }

    /** Name of the Secret the bootstrap seeds the tenant-admin data root from (seed.json, master.key, ...). */
    public static TenantAdminSeedSecretNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminNameOf(tenantId)}${K8sManifestBuilder.TenantAdminSeedSuffix}`
    }

    /** Name of the Secret holding a hive's one-time agent bearer (key `token`). */
    public static AgentTokenSecretNameOf(hiveId: string): string
    {
        return `${K8sManifestBuilder.HiveAgentNameOf(hiveId)}${K8sManifestBuilder.AgentTokenSecretSuffix}`
    }

    /**
     * Renders one tenant's tenant-admin container: shared pragmatic-system Namespace (unlabeled, first), SA (no API
     * token: the process needs no in-cluster access, so no RBAC), data PVC, Deployment (init container seeds the data root
     * from the seed Secret) and a ClusterIP Service. Hive-labeled only, so the pull agent never selects it. Secrets are
     * referenced by Secret name only, never inlined.
     */
    public RenderTenantAdmin(spec: TenantAdminWorkloadSpec): string
    {
        const items: K8sObject[] = [
            this.HiveAgentNamespaceObject(),
            this.TenantAdminServiceAccount(spec),
            this.TenantAdminClaim(spec),
            this.TenantAdminDeployment(spec),
            this.TenantAdminServiceObject(spec),
        ]
        return JSON.stringify({
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ListKind,
            [K8sManifestBuilder.ItemsKey]: items,
        })
    }

    private TenantAdminServiceAccount(spec: TenantAdminWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceAccountKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(spec.hiveId, K8sManifestBuilder.TenantAdminNameOf(spec.tenantId)),
            [K8sManifestBuilder.AutomountTokenKey]: false,
        }
    }

    private TenantAdminClaim(spec: TenantAdminWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.PersistentVolumeClaimKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(spec.hiveId, K8sManifestBuilder.TenantAdminClaimNameOf(spec.tenantId)),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.AccessModesKey]: [K8sManifestBuilder.ReadWriteOnce],
                [K8sManifestBuilder.ResourcesKey]: {
                    [K8sManifestBuilder.RequestsKey]: { [K8sManifestBuilder.StorageKey]: K8sManifestBuilder.TenantAdminDataSize },
                },
            },
        }
    }

    private TenantAdminSecurityContext(): K8sObject
    {
        return {
            [K8sManifestBuilder.RunAsNonRootKey]: true,
            [K8sManifestBuilder.RunAsUserKey]: K8sManifestBuilder.TenantAdminUid,
            [K8sManifestBuilder.AllowPrivilegeEscalationKey]: false,
            [K8sManifestBuilder.CapabilitiesKey]: { [K8sManifestBuilder.DropKey]: [K8sManifestBuilder.AllCapabilities] },
            [K8sManifestBuilder.SeccompProfileKey]: { [K8sManifestBuilder.TypeKey]: K8sManifestBuilder.RuntimeDefault },
            [K8sManifestBuilder.ReadOnlyRootFilesystemKey]: true,
        }
    }

    private TenantAdminDeployment(spec: TenantAdminWorkloadSpec): K8sObject
    {
        const name = K8sManifestBuilder.TenantAdminNameOf(spec.tenantId)
        const pod: K8sObject = {
            [K8sManifestBuilder.ServiceAccountNameKey]: name,
            [K8sManifestBuilder.AutomountTokenKey]: false,
            [K8sManifestBuilder.SecurityContextKey]: { [K8sManifestBuilder.FsGroupKey]: K8sManifestBuilder.TenantAdminUid },
            [K8sManifestBuilder.InitContainersKey]: [this.TenantAdminSeedContainer(spec)],
            [K8sManifestBuilder.ContainersKey]: [this.TenantAdminContainer(spec)],
            [K8sManifestBuilder.VolumesKey]: [
                {
                    [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminDataVolume,
                    [K8sManifestBuilder.PersistentVolumeClaimKey]: { [K8sManifestBuilder.ClaimNameKey]: K8sManifestBuilder.TenantAdminClaimNameOf(spec.tenantId) },
                },
                this.SecretVolume(K8sManifestBuilder.TenantAdminSeedVolume, spec.seedSecretName),
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TmpVolume, [K8sManifestBuilder.EmptyDirKey]: {} },
            ],
        }
        if (spec.imagePullSecretName !== undefined)
        {
            pod[K8sManifestBuilder.ImagePullSecretsKey] = [{ [K8sManifestBuilder.NameKey]: spec.imagePullSecretName }]
        }
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionApps,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.DeploymentKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(spec.hiveId, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.ReplicasKey]: K8sManifestBuilder.SingleReplica,
                [K8sManifestBuilder.SelectorKey]: { [K8sManifestBuilder.MatchLabelsKey]: this.Selector(name) },
                [K8sManifestBuilder.TemplateKey]: {
                    [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.LabelsKey]: this.Selector(name) },
                    [K8sManifestBuilder.SpecKey]: pod,
                },
            },
        }
    }

    private TenantAdminSeedContainer(spec: TenantAdminWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminSeedContainerName,
            [K8sManifestBuilder.ImageKey]: spec.image,
            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
            [K8sManifestBuilder.CommandKey]: K8sManifestBuilder.TenantAdminSeedCommand,
            [K8sManifestBuilder.SecurityContextKey]: this.TenantAdminSecurityContext(),
            [K8sManifestBuilder.VolumeMountsKey]: [
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminSeedVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TenantAdminSeedMount, [K8sManifestBuilder.ReadOnlyKey]: true },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TenantAdminDataMount },
            ],
        }
    }

    private TenantAdminContainer(spec: TenantAdminWorkloadSpec): K8sObject
    {
        const secure = spec.externalScheme === K8sManifestBuilder.HttpsSchemeName
        return {
            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminContainerName,
            [K8sManifestBuilder.ImageKey]: spec.image,
            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
            [K8sManifestBuilder.CommandKey]: K8sManifestBuilder.TenantAdminEntrypoint,
            [K8sManifestBuilder.PortsKey]: [{ [K8sManifestBuilder.ContainerPortKey]: spec.port }],
            [K8sManifestBuilder.SecurityContextKey]: this.TenantAdminSecurityContext(),
            [K8sManifestBuilder.EnvKey]: [
                this.EnvLiteral(TenantAdminEnv.DataRoot, K8sManifestBuilder.TenantAdminDataMount),
                this.EnvLiteral(TenantAdminEnv.Port, String(spec.port)),
                this.EnvLiteral(TenantAdminEnv.Bind, K8sManifestBuilder.TenantAdminBindAll),
                this.EnvLiteral(TenantAdminEnv.BaseDomain, spec.baseDomain),
                this.EnvLiteral(TenantAdminEnv.Scheme, spec.externalScheme),
                this.EnvLiteral(TenantAdminEnv.SecureCookie, secure ? K8sManifestBuilder.TrueText : K8sManifestBuilder.FalseText),
                this.EnvLiteral(TenantAdminEnv.RolloutUrl, spec.rolloutUrl),
                this.EnvLiteral(TenantAdminEnv.RolloutHiveId, spec.hiveId),
                {
                    [K8sManifestBuilder.NameKey]: TenantAdminEnv.RolloutToken,
                    [K8sManifestBuilder.ValueFromKey]: {
                        [K8sManifestBuilder.SecretKeyRefKey]: {
                            [K8sManifestBuilder.NameKey]: spec.agentTokenSecretName,
                            [K8sManifestBuilder.KeyKey]: K8sManifestBuilder.AgentTokenSecretKey,
                        },
                    },
                },
            ],
            [K8sManifestBuilder.VolumeMountsKey]: [
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TenantAdminDataMount },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TmpVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TmpMount },
            ],
            // The plane answers 403 to any Host that is not a known tenant subdomain, so the probe presents the tenant's own host.
            [K8sManifestBuilder.ReadinessProbeKey]: {
                [K8sManifestBuilder.HttpGetKey]: {
                    [K8sManifestBuilder.PathKey]: K8sManifestBuilder.TenantAdminRootPath,
                    [K8sManifestBuilder.PortKey]: spec.port,
                    [K8sManifestBuilder.HttpHeadersKey]: [{
                        [K8sManifestBuilder.NameKey]: K8sManifestBuilder.HostHeader,
                        [K8sManifestBuilder.ValueKey]: spec.tenantId + K8sManifestBuilder.HostSeparator + spec.baseDomain,
                    }],
                },
            },
        }
    }

    private TenantAdminServiceObject(spec: TenantAdminWorkloadSpec): K8sObject
    {
        const name = K8sManifestBuilder.TenantAdminNameOf(spec.tenantId)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(spec.hiveId, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.TypeKey]: K8sManifestBuilder.ClusterIpType,
                [K8sManifestBuilder.SelectorKey]: this.Selector(name),
                [K8sManifestBuilder.PortsKey]: [{
                    [K8sManifestBuilder.PortKey]: spec.port,
                    [K8sManifestBuilder.TargetPortKey]: spec.port,
                }],
            },
        }
    }

    private EnvLiteral(key: string, value: string): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: key,
            [K8sManifestBuilder.ValueKey]: value,
        }
    }

    private DatabaseNameOf(workload: EnvironmentWorkload): string
    {
        return K8sManifestBuilder.DatabaseOf(workload.environmentName)
    }

    private Selector(name: string): Record<string, string>
    {
        return { [K8sManifestBuilder.AppLabel]: name }
    }

    private Meta(workload: EnvironmentWorkload, name: string): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: name,
            [K8sManifestBuilder.NamespaceKey]: K8sManifestBuilder.NamespaceOf(workload.environmentName),
        }
    }

    private Namespace(workload: EnvironmentWorkload): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.NamespaceKind,
            [K8sManifestBuilder.MetadataKey]: {
                [K8sManifestBuilder.NameKey]: K8sManifestBuilder.NamespaceOf(workload.environmentName),
                [K8sManifestBuilder.LabelsKey]: {
                    [K8sManifestBuilder.EnvironmentLabel]: workload.environmentName,
                    [K8sManifestBuilder.HiveLabel]: workload.hiveId,
                },
            },
        }
    }

    private ServerDeployment(workload: EnvironmentWorkload): K8sObject
    {
        const name = K8sManifestBuilder.ServerDeploymentOf(workload.environmentName)
        const env: K8sObject[] = Object.entries(workload.env).map(([k, v]) => ({
            [K8sManifestBuilder.NameKey]: k,
            [K8sManifestBuilder.ValueKey]: v,
        }))
        env.push(
            this.EnvLiteral(K8sManifestBuilder.BaseDirVar, K8sManifestBuilder.ServerDataMount),
            this.EnvLiteral(K8sManifestBuilder.TenantsFileVar, this.MountedFile(K8sManifestBuilder.ServerConfigMount, EnvServerSeedSource.TenantsFile)),
            this.EnvLiteral(K8sManifestBuilder.MasterKeyFileVar, this.MountedFile(K8sManifestBuilder.ServerSecretsMount, EnvServerSeedSource.MasterKeyFile)),
            this.EnvLiteral(K8sManifestBuilder.SecretsFileVar, this.MountedFile(K8sManifestBuilder.ServerSecretsMount, EnvServerSeedSource.SecretsFile)),
            this.EnvLiteral(K8sManifestBuilder.DeploymentModeVar, K8sManifestBuilder.DeploymentModeLocal),
        )
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionApps,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.DeploymentKind,
            [K8sManifestBuilder.MetadataKey]: {
                ...this.Meta(workload, name),
                [K8sManifestBuilder.LabelsKey]: this.EnvironmentDeploymentLabels(workload),
            },
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.ReplicasKey]: K8sManifestBuilder.SingleReplica,
                [K8sManifestBuilder.SelectorKey]: { [K8sManifestBuilder.MatchLabelsKey]: this.Selector(name) },
                [K8sManifestBuilder.TemplateKey]: {
                    [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.LabelsKey]: this.Selector(name) },
                    [K8sManifestBuilder.SpecKey]: {
                        [K8sManifestBuilder.SecurityContextKey]: { [K8sManifestBuilder.FsGroupKey]: K8sManifestBuilder.ServerUid },
                        [K8sManifestBuilder.InitContainersKey]: [this.ServerSeedContainer(workload)],
                        [K8sManifestBuilder.ContainersKey]: [{
                            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerContainerName,
                            [K8sManifestBuilder.ImageKey]: workload.image,
                            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
                            [K8sManifestBuilder.PortsKey]: [{ [K8sManifestBuilder.ContainerPortKey]: workload.serverPort }],
                            [K8sManifestBuilder.EnvKey]: env,
                            [K8sManifestBuilder.VolumeMountsKey]: [
                                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerConfigVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerConfigMount, [K8sManifestBuilder.ReadOnlyKey]: true },
                                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerSecretsVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerSecretsMount, [K8sManifestBuilder.ReadOnlyKey]: true },
                                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerDataMount },
                            ],
                            [K8sManifestBuilder.ReadinessProbeKey]: {
                                [K8sManifestBuilder.HttpGetKey]: {
                                    [K8sManifestBuilder.PathKey]: K8sManifestBuilder.HealthPath,
                                    [K8sManifestBuilder.PortKey]: workload.serverPort,
                                },
                            },
                        }],
                        [K8sManifestBuilder.VolumesKey]: [
                            {
                                [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerConfigVolume,
                                [K8sManifestBuilder.ConfigMapKey]: { [K8sManifestBuilder.NameKey]: EnvServerSeedSource.ConfigMapNameOf(workload.environmentName) },
                            },
                            this.SecretVolume(K8sManifestBuilder.ServerSecretsVolume, EnvServerSeedSource.SecretNameOf(workload.environmentName)),
                            {
                                [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerDataVolume,
                                [K8sManifestBuilder.PersistentVolumeClaimKey]: { [K8sManifestBuilder.ClaimNameKey]: K8sManifestBuilder.ServerDataClaimNameOf(workload.environmentName) },
                            },
                            this.SecretVolume(K8sManifestBuilder.ServerSeedVolume, EnvServerSeedSource.SeedSecretNameOf(workload.environmentName)),
                        ],
                    },
                },
            },
        }
    }

    /** Unpacks the projected env seed tree into data/<environmentId>/ (NOT environmentName: the server reads by id). Hardened like the tenant-admin seed. */
    private ServerSeedContainer(workload: EnvironmentWorkload): K8sObject
    {
        const dest = this.MountedFile(K8sManifestBuilder.ServerDataMount, workload.environmentId)
        return {
            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerSeedContainerName,
            [K8sManifestBuilder.ImageKey]: workload.image,
            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
            [K8sManifestBuilder.CommandKey]: [K8sManifestBuilder.NodeBinary, K8sManifestBuilder.NodeEvalFlag, K8sManifestBuilder.ServerSeedScript, dest, this.MountedFile(K8sManifestBuilder.ServerSeedMount, K8sManifestBuilder.ServerSeedFile)],
            [K8sManifestBuilder.SecurityContextKey]: this.ServerSeedSecurityContext(),
            [K8sManifestBuilder.VolumeMountsKey]: [
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerSeedVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerSeedMount, [K8sManifestBuilder.ReadOnlyKey]: true },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerDataMount },
            ],
        }
    }

    private ServerSeedSecurityContext(): K8sObject
    {
        return {
            [K8sManifestBuilder.RunAsNonRootKey]: true,
            [K8sManifestBuilder.RunAsUserKey]: K8sManifestBuilder.ServerUid,
            [K8sManifestBuilder.AllowPrivilegeEscalationKey]: false,
            [K8sManifestBuilder.CapabilitiesKey]: { [K8sManifestBuilder.DropKey]: [K8sManifestBuilder.AllCapabilities] },
            [K8sManifestBuilder.SeccompProfileKey]: { [K8sManifestBuilder.TypeKey]: K8sManifestBuilder.RuntimeDefault },
            [K8sManifestBuilder.ReadOnlyRootFilesystemKey]: true,
        }
    }

    private MountedFile(dir: string, file: string): string
    {
        return `${dir}${K8sManifestBuilder.PathSeparator}${file}`
    }

    /** Standalone PVC for the server base dir (a Deployment cannot use volumeClaimTemplates). */
    private ServerDataClaim(workload: EnvironmentWorkload): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.PersistentVolumeClaimKind,
            [K8sManifestBuilder.MetadataKey]: this.Meta(workload, K8sManifestBuilder.ServerDataClaimNameOf(workload.environmentName)),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.AccessModesKey]: [K8sManifestBuilder.ReadWriteOnce],
                [K8sManifestBuilder.ResourcesKey]: {
                    [K8sManifestBuilder.RequestsKey]: { [K8sManifestBuilder.StorageKey]: K8sManifestBuilder.DataVolumeSize },
                },
            },
        }
    }

    private ServerService(workload: EnvironmentWorkload): K8sObject
    {
        const name = K8sManifestBuilder.ServerDeploymentOf(workload.environmentName)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceKind,
            [K8sManifestBuilder.MetadataKey]: this.Meta(workload, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.TypeKey]: K8sManifestBuilder.ClusterIpType,
                [K8sManifestBuilder.SelectorKey]: this.Selector(name),
                [K8sManifestBuilder.PortsKey]: [{
                    [K8sManifestBuilder.PortKey]: workload.serverPort,
                    [K8sManifestBuilder.TargetPortKey]: workload.serverPort,
                }],
            },
        }
    }

    private DatabaseStatefulSet(workload: EnvironmentWorkload, db: WorkloadDatabase): K8sObject
    {
        const name = this.DatabaseNameOf(workload)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionApps,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.StatefulSetKind,
            [K8sManifestBuilder.MetadataKey]: this.Meta(workload, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.ServiceNameKey]: name,
                [K8sManifestBuilder.ReplicasKey]: K8sManifestBuilder.SingleReplica,
                [K8sManifestBuilder.SelectorKey]: { [K8sManifestBuilder.MatchLabelsKey]: this.Selector(name) },
                [K8sManifestBuilder.TemplateKey]: {
                    [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.LabelsKey]: this.Selector(name) },
                    [K8sManifestBuilder.SpecKey]: {
                        [K8sManifestBuilder.ContainersKey]: [{
                            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.DatabaseSuffix,
                            [K8sManifestBuilder.ImageKey]: db.image,
                            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
                            [K8sManifestBuilder.PortsKey]: [{ [K8sManifestBuilder.ContainerPortKey]: K8sManifestBuilder.PostgresPort }],
                            [K8sManifestBuilder.EnvKey]: [
                                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.PostgresUserVar, [K8sManifestBuilder.ValueKey]: db.user },
                                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.PostgresDbVar, [K8sManifestBuilder.ValueKey]: db.database },
                                {
                                    [K8sManifestBuilder.NameKey]: K8sManifestBuilder.PostgresPasswordVar,
                                    [K8sManifestBuilder.ValueFromKey]: {
                                        [K8sManifestBuilder.SecretKeyRefKey]: {
                                            [K8sManifestBuilder.NameKey]: db.passwordRef,
                                            [K8sManifestBuilder.KeyKey]: K8sManifestBuilder.PasswordSecretKey,
                                        },
                                    },
                                },
                            ],
                            [K8sManifestBuilder.VolumeMountsKey]: [{
                                [K8sManifestBuilder.NameKey]: K8sManifestBuilder.DataVolumeName,
                                [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.PostgresDataPath,
                            }],
                        }],
                    },
                },
                [K8sManifestBuilder.VolumeClaimTemplatesKey]: [{
                    [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.DataVolumeName },
                    [K8sManifestBuilder.SpecKey]: {
                        [K8sManifestBuilder.AccessModesKey]: [K8sManifestBuilder.ReadWriteOnce],
                        [K8sManifestBuilder.ResourcesKey]: {
                            [K8sManifestBuilder.RequestsKey]: { [K8sManifestBuilder.StorageKey]: K8sManifestBuilder.DataVolumeSize },
                        },
                    },
                }],
            },
        }
    }

    private DatabaseService(workload: EnvironmentWorkload): K8sObject
    {
        const name = this.DatabaseNameOf(workload)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceKind,
            [K8sManifestBuilder.MetadataKey]: this.Meta(workload, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.ClusterIpKey]: K8sManifestBuilder.HeadlessClusterIp,
                [K8sManifestBuilder.SelectorKey]: this.Selector(name),
                [K8sManifestBuilder.PortsKey]: [{ [K8sManifestBuilder.PortKey]: K8sManifestBuilder.PostgresPort }],
            },
        }
    }
}
