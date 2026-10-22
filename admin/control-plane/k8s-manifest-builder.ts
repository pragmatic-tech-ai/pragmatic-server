import type { EnvironmentWorkload, WorkloadDatabase } from './environment-workload.js'

type K8sObject = Record<string, unknown>

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

    private static readonly ApiVersionCore = 'v1'
    private static readonly ApiVersionApps = 'apps/v1'
    private static readonly ListKind = 'List'
    private static readonly NamespaceKind = 'Namespace'
    private static readonly DeploymentKind = 'Deployment'
    private static readonly ServiceKind = 'Service'
    private static readonly StatefulSetKind = 'StatefulSet'
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

    public static readonly ServerContainerName = 'server'

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
        const env = Object.entries(workload.env).map(([k, v]) => ({
            [K8sManifestBuilder.NameKey]: k,
            [K8sManifestBuilder.ValueKey]: v,
        }))
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionApps,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.DeploymentKind,
            [K8sManifestBuilder.MetadataKey]: this.Meta(workload, name),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.ReplicasKey]: K8sManifestBuilder.SingleReplica,
                [K8sManifestBuilder.SelectorKey]: { [K8sManifestBuilder.MatchLabelsKey]: this.Selector(name) },
                [K8sManifestBuilder.TemplateKey]: {
                    [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.LabelsKey]: this.Selector(name) },
                    [K8sManifestBuilder.SpecKey]: {
                        [K8sManifestBuilder.ContainersKey]: [{
                            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerContainerName,
                            [K8sManifestBuilder.ImageKey]: workload.image,
                            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
                            [K8sManifestBuilder.PortsKey]: [{ [K8sManifestBuilder.ContainerPortKey]: workload.serverPort }],
                            [K8sManifestBuilder.EnvKey]: env,
                            [K8sManifestBuilder.ReadinessProbeKey]: {
                                [K8sManifestBuilder.HttpGetKey]: {
                                    [K8sManifestBuilder.PathKey]: K8sManifestBuilder.HealthPath,
                                    [K8sManifestBuilder.PortKey]: workload.serverPort,
                                },
                            },
                        }],
                    },
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
