import { createHash } from 'node:crypto'
import { UiArtifact } from './ui-artifact.js'
import { EnvConventions } from '../../environments/seed/env-conventions.js'
import type { EnvironmentWorkload, WorkloadAppDeployment, WorkloadDatabase } from './environment-workload.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import { InClusterRegistry } from './in-cluster-registry.js'
import { IdpWorkloadNames, type IdpWorkloadSpec } from './idp-workload-driver.js'
import { TenantAdminEnv } from './tenant-admin-env.js'
import type { TenantAdminWorkloadSpec } from './tenant-admin-workload.js'
import { InvalidRecordIdError } from './platform-records.js'
import { KindClusterName } from './kind-cluster-name.js'
import { IngressTlsPolicy, IngressTlsSource, type IngressTls } from './ingress-tls.js'
import { TenantConsoleAdmission, type TenantConsoleAdmissionSpec } from './tenant-console-admission.js'

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
    /** Every environment namespace starts with this; the console's guard fences its writes to it. */
    public static readonly EnvNamespacePrefix = 'pragmatic-env-'
    private static readonly ServerSuffix = 'server'
    private static readonly DatabaseSuffix = 'postgres'
    private static readonly PostgresPort = 5432
    private static readonly PostgresDataPath = '/var/lib/postgresql/data'
    private static readonly PostgresUserVar = 'POSTGRES_USER'
    private static readonly PostgresDbVar = 'POSTGRES_DB'
    private static readonly PostgresPasswordVar = 'POSTGRES_PASSWORD'
    private static readonly PasswordSecretKey = 'password'
    private static readonly Rfc1123Name = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
    /** A label value's (and an RFC 1123 label's) maximum length. */
    private static readonly LabelValueMax = 63
    private static readonly NonNameChars = /[^a-z0-9]+/g
    private static readonly EdgeDashes = /^-+|-+$/g
    private static readonly NameDash = '-'
    private static readonly Empty = ''
    private static readonly NameFallback = 'secret'
    private static readonly NameBaseMax = 200
    private static readonly NameHashAlgorithm = 'sha256'
    private static readonly NameHashEncoding = 'hex'
    private static readonly NameHashLength = 10
    private static readonly DataVolumeName = 'data'
    private static readonly DataVolumeSize = '1Gi'
    private static readonly SingleReplica = 1

    // In-cluster registry conventions.
    private static readonly NodePortKey = 'nodePort'
    private static readonly NodePortType = 'NodePort'
    private static readonly RegistryDataPath = '/var/lib/registry'
    private static readonly RegistryDataVolume = 'registry-data'

    // Pull-agent conventions.
    private static readonly AgentSuffix = 'agent'
    /** The agent's image; the automatic install prepares the cluster with it (a kind node loads it). */
    public static readonly AgentImage = 'pragmatic-server:dev'
    private static readonly AgentContainerName = 'agent'
    private static readonly AgentEntrypoint = ['node', 'dist/bin/pragmatic-agentd.js']
    private static readonly AgentRegistryUrlVar = 'PRAGMATIC_AGENT_REGISTRY_URL'
    private static readonly AgentHiveIdVar = 'PRAGMATIC_AGENT_HIVE_ID'
    private static readonly AgentTokenVar = 'PRAGMATIC_AGENT_TOKEN'
    public static readonly AgentTokenSecretKey = 'token'
    /** Namespace hosting the per-hive agent's ServiceAccount + Deployment (cluster-scoped RBAC has none). The Namespace object itself is emitted by RenderHiveAgent. */
    public static readonly SystemNamespace = 'pragmatic-system'
    private static readonly HiveAgentNamespace = K8sManifestBuilder.SystemNamespace
    private static readonly HiveAgentPrefix = 'pragmatic-hive-'
    /**
     * The longest hive id every id-derived name and label still fits: the agent name (pragmatic-hive-ID-agent) is also its
     * app label value (<= 63), and a provisioned hive's kind cluster name has its own, tighter, cap. The portal mirrors it.
     */
    public static readonly HiveIdMaxLength = Math.min(
        K8sManifestBuilder.LabelValueMax - (K8sManifestBuilder.HiveAgentPrefix.length + 1 + K8sManifestBuilder.AgentSuffix.length),
        KindClusterName.MaxHiveIdLength)
    private static readonly InvalidHiveIdMessage = "hive id must be a lowercase Kubernetes name: letters a-z, digits and '-', starting and ending with a letter or digit, at most "
        + String(K8sManifestBuilder.HiveIdMaxLength) + ' characters'

    // IdP workload conventions.
    private static readonly IdpBrowserHostPrefix = 'idp-'
    private static readonly ApiVersionNetworking = 'networking.k8s.io/v1'
    private static readonly IngressKind = 'Ingress'
    private static readonly NetworkPolicyKind = 'NetworkPolicy'
    private static readonly PodSelectorKey = 'podSelector'
    private static readonly PolicyTypesKey = 'policyTypes'
    private static readonly IngressRulesKey = 'ingress'
    private static readonly FromKey = 'from'
    private static readonly NamespaceSelectorKey = 'namespaceSelector'
    private static readonly ProtocolKey = 'protocol'
    private static readonly TcpProtocol = 'TCP'
    private static readonly IngressPolicyType = 'Ingress'
    private static readonly NamespaceNameLabel = 'kubernetes.io/metadata.name'
    /** The default namespace of the nginx ingress controller (the console's Ingress uses ingressClassName nginx); the console settings may name another. */
    public static readonly IngressControllerNamespace = 'ingress-nginx'
    private static readonly IngressClassNameKey = 'ingressClassName'
    private static readonly IngressClassNginx = 'nginx'
    private static readonly AnnotationsKey = 'annotations'
    private static readonly SslPassthroughAnnotation = 'nginx.ingress.kubernetes.io/ssl-passthrough'
    private static readonly TlsKey = 'tls'
    private static readonly HostsKey = 'hosts'
    private static readonly SslPassthroughValue = 'true'
    private static readonly BackendProtocolAnnotation = 'nginx.ingress.kubernetes.io/backend-protocol'
    private static readonly BackendProtocolHttps = 'HTTPS'
    private static readonly ProxySslSecretAnnotation = 'nginx.ingress.kubernetes.io/proxy-ssl-secret'
    private static readonly ProxySslVerifyAnnotation = 'nginx.ingress.kubernetes.io/proxy-ssl-verify'
    private static readonly ProxySslNameAnnotation = 'nginx.ingress.kubernetes.io/proxy-ssl-name'
    private static readonly ProxySslServerNameAnnotation = 'nginx.ingress.kubernetes.io/proxy-ssl-server-name'
    private static readonly AnnotationOn = 'on'
    private static readonly NamespaceSeparator = '/'
    private static readonly HostKey = 'host'
    private static readonly HttpKey = 'http'
    private static readonly PathsKey = 'paths'
    private static readonly PathTypeKey = 'pathType'
    private static readonly PathTypePrefix = 'Prefix'
    private static readonly BackendKey = 'backend'
    private static readonly ServiceKey = 'service'
    private static readonly PortNumberKey = 'number'
    private static readonly IngressRootPath = '/'
    // Served-environment federation: ca.crt-only trust mount + per-env TLS-terminating Ingress.
    private static readonly EnvIdpCaVolume = 'idp-ca'
    private static readonly EnvIdpCaMount = '/etc/idp-ca'
    private static readonly EnvIdpCaFile = '/etc/idp-ca/ca.crt'
    private static readonly EnvIdpCaItemKey = 'ca.crt'
    private static readonly NodeExtraCaCertsVar = 'NODE_EXTRA_CA_CERTS'
    private static readonly HostDotSeparator = '.'
    private static readonly IdpPrefix = IdpWorkloadNames.NamePrefix
    private static readonly IdpContainerName = 'idp'
    private static readonly IdpEntrypoint = ['node', 'dist/bin/pragmatic-idpd.js']
    private static readonly IdpDataMount = '/idp-data'
    private static readonly IdpTlsMount = '/idp-data/tls'
    private static readonly IdpSecretsMount = '/idp-data/secrets'
    private static readonly TmpMount = '/tmp'
    private static readonly IdpBindAll = '0.0.0.0'
    private static readonly IdpPortVar = 'PRAGMATIC_IDP_PORT'
    private static readonly IdpBaseUrlVar = 'PRAGMATIC_IDP_BASE_URL'
    private static readonly IdpInternalUrlVar = 'PRAGMATIC_IDP_INTERNAL_URL'
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
    private static readonly TenantAdminIdpCaItemKey = 'ca.crt'
    private static readonly TenantAdminIdpTokenItemKey = 'admin-token'
    private static readonly TenantAdminIdpCaVolume = 'idp-ca'
    private static readonly TenantAdminIdpCaMount = '/idp/ca'
    private static readonly TenantAdminIdpCaFile = '/idp/ca/ca.crt'
    private static readonly TenantAdminIdpTokenVolume = 'idp-token'
    private static readonly TenantAdminIdpTokenMount = '/idp/token'
    private static readonly TenantAdminIdpTokenFile = '/idp/token/admin-token'
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

    // Tenant console: in-cluster API access (environment management) and browser exposure.
    private static readonly ConsoleHostPrefix = 'console-'
    private static readonly TenantConsoleEnvRoleSuffix = '-env'
    private static readonly TenantConsoleTlsRoleSuffix = '-tls'
    private static readonly TenantConsoleFingerprintSuffix = '-fingerprint'
    private static readonly TenantConsoleIdpCaSuffix = '-idp-ca'
    private static readonly TenantConsoleIdpTokenSuffix = '-idp-token'
    private static readonly TenantConsoleDevTlsSuffix = '-dev-tls'
    private static readonly FingerprintVolume = 'fingerprint'
    private static readonly FingerprintMount = '/fingerprint'
    /** The one key of the fingerprint Secret (and the file name it is projected as). */
    public static readonly FingerprintItemKey = 'fingerprint.key'
    /** Name of the RoleBinding the console creates in each environment namespace (binding its env ClusterRole there). */
    public static readonly TenantConsoleEnvBindingName = 'pragmatic-tenant-console'
    /** Where the console reads its fingerprint key (the mount plus the one projected item). */
    public static readonly FingerprintKeyFilePath = `${K8sManifestBuilder.FingerprintMount}/${K8sManifestBuilder.FingerprintItemKey}`
    private static readonly SecretKind = 'Secret'
    private static readonly CoreApiGroup = ''
    private static readonly NetworkingApiGroup = 'networking.k8s.io'
    private static readonly NamespacesResource = 'namespaces'
    private static readonly RoleBindingsResource = 'rolebindings'
    private static readonly ClusterRolesResource = 'clusterroles'
    private static readonly SecretsResource = 'secrets'
    private static readonly EnvCoreResources = [K8sManifestBuilder.SecretsResource, 'configmaps', 'services', 'persistentvolumeclaims']
    private static readonly EnvAppsResources = ['deployments', 'deployments/scale', 'statefulsets', 'statefulsets/scale']
    private static readonly EnvNetworkingResources = ['ingresses']
    private static readonly CreateVerb = 'create'
    private static readonly DeleteVerb = 'delete'
    private static readonly BindVerb = 'bind'
    private static readonly AnyVerb = '*'
    private static readonly PodSecurityEnforceLabel = 'pod-security.kubernetes.io/enforce'
    private static readonly PodSecurityEnforceVersionLabel = 'pod-security.kubernetes.io/enforce-version'
    private static readonly PodSecurityBaseline = 'baseline'
    private static readonly PodSecurityRestricted = 'restricted'
    private static readonly PodSecurityLatest = 'latest'
    /** Pod Security levels the console's admission fence accepts on a namespace it creates (never `privileged`). */
    private static readonly AdmittedPodSecurityLevels = [K8sManifestBuilder.PodSecurityBaseline, K8sManifestBuilder.PodSecurityRestricted]

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
    private static readonly UiUnpackContainerName = 'ui-unpack'
    private static readonly UiUnpackBinPath = 'dist-tenant-admin/admin/control-plane/bin/pragmatic-ui-unpack.js'
    private static readonly UiTrustVolume = 'ui-trust'
    private static readonly UiTrustMount = '/pragmatic/ui-trust'
    private static readonly UiPubSuffix = '.pub'
    private static readonly UiRegistryBaseVar = 'PRAGMATIC_UI_REGISTRY_BASE'
    private static readonly UiRepoVar = 'PRAGMATIC_UI_REPO'
    private static readonly UiArtifactTagVar = 'PRAGMATIC_UI_ARTIFACT_TAG'
    private static readonly UiSigTagVar = 'PRAGMATIC_UI_SIG_TAG'
    private static readonly UiManifestDigestVar = 'PRAGMATIC_UI_MANIFEST_DIGEST'
    private static readonly UiAppNameVar = 'PRAGMATIC_UI_APP_NAME'
    private static readonly UiAppVersionVar = 'PRAGMATIC_UI_APP_VERSION'
    private static readonly UiTrustRootRefVar = 'PRAGMATIC_UI_TRUST_ROOT_REF'
    private static readonly UiDataDirVar = 'PRAGMATIC_UI_DATA_DIR'
    /** The env server reads its apps from `<base dir>/<environment id>/applications` (TenantRegistry.OptionsFor), so the unpack writes there. */
    private static readonly ApplicationsDir = 'applications'
    private static readonly UiTrustDirVar = 'PRAGMATIC_UI_TRUST_DIR'
    /**
     * Unpacks seed.json ({ relpath: base64 }) into the env data dir (argv[1]) unless the marker exists. Idempotent: a restart never clobbers live state.
     * Rejects relpaths that escape the data dir.
     */
    private static readonly ServerSeedMarkerFile = '.env-seeded'
    private static readonly ServerSeedFile = 'seed.json'
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
        return K8sManifestBuilder.EnvNamespacePrefix + environmentName
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
        if (workload.federation)
        {
            items.push(this.ServerIngress(workload, workload.federation.baseDomain))
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

    public static HiveAgentNameOf(hiveId: string): string
    {
        return `${K8sManifestBuilder.HiveAgentPrefix}${hiveId}-${K8sManifestBuilder.AgentSuffix}`
    }

    /** Renders the in-cluster OCI registry (registry:2): Namespace, Deployment, NodePort Service, PVC. Addressing is cluster-fixed; the objects are unlabeled by hive (shared infra). */
    public RenderRegistry(_hiveId: string): string
    {
        const items: K8sObject[] = [
            this.HiveAgentNamespaceObject(),
            this.RegistryDeployment(),
            this.RegistryService(),
            this.RegistryClaim(),
        ]
        return JSON.stringify({
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ListKind,
            [K8sManifestBuilder.ItemsKey]: items,
        })
    }

    private RegistryMeta(name: string): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: name,
            [K8sManifestBuilder.NamespaceKey]: InClusterRegistry.Namespace,
            [K8sManifestBuilder.LabelsKey]: this.Selector(InClusterRegistry.RegistryName),
        }
    }

    private RegistryDeployment(): K8sObject
    {
        const selector = this.Selector(InClusterRegistry.RegistryName)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionApps,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.DeploymentKind,
            [K8sManifestBuilder.MetadataKey]: this.RegistryMeta(InClusterRegistry.RegistryName),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.ReplicasKey]: K8sManifestBuilder.SingleReplica,
                [K8sManifestBuilder.SelectorKey]: { [K8sManifestBuilder.MatchLabelsKey]: selector },
                [K8sManifestBuilder.TemplateKey]: {
                    [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.LabelsKey]: selector },
                    [K8sManifestBuilder.SpecKey]: {
                        // Dev infra: registry:2 is not hardened here, so no strict non-root securityContext is imposed.
                        [K8sManifestBuilder.ContainersKey]: [{
                            [K8sManifestBuilder.NameKey]: InClusterRegistry.RegistryName,
                            [K8sManifestBuilder.ImageKey]: InClusterRegistry.Image,
                            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
                            [K8sManifestBuilder.PortsKey]: [{ [K8sManifestBuilder.ContainerPortKey]: InClusterRegistry.ServicePort }],
                            [K8sManifestBuilder.VolumeMountsKey]: [
                                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.RegistryDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.RegistryDataPath },
                            ],
                            [K8sManifestBuilder.ReadinessProbeKey]: {
                                [K8sManifestBuilder.HttpGetKey]: {
                                    [K8sManifestBuilder.PathKey]: InClusterRegistry.V2Path,
                                    [K8sManifestBuilder.PortKey]: InClusterRegistry.ServicePort,
                                },
                            },
                        }],
                        [K8sManifestBuilder.VolumesKey]: [{
                            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.RegistryDataVolume,
                            [K8sManifestBuilder.PersistentVolumeClaimKey]: { [K8sManifestBuilder.ClaimNameKey]: InClusterRegistry.DataClaimName },
                        }],
                    },
                },
            },
        }
    }

    private RegistryService(): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceKind,
            [K8sManifestBuilder.MetadataKey]: this.RegistryMeta(InClusterRegistry.RegistryName),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.TypeKey]: K8sManifestBuilder.NodePortType,
                [K8sManifestBuilder.SelectorKey]: this.Selector(InClusterRegistry.RegistryName),
                [K8sManifestBuilder.PortsKey]: [{
                    [K8sManifestBuilder.PortKey]: InClusterRegistry.ServicePort,
                    [K8sManifestBuilder.TargetPortKey]: InClusterRegistry.ServicePort,
                    [K8sManifestBuilder.NodePortKey]: InClusterRegistry.NodePort,
                }],
            },
        }
    }

    private RegistryClaim(): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.PersistentVolumeClaimKind,
            [K8sManifestBuilder.MetadataKey]: this.RegistryMeta(InClusterRegistry.DataClaimName),
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.AccessModesKey]: [K8sManifestBuilder.ReadWriteOnce],
                [K8sManifestBuilder.ResourcesKey]: {
                    [K8sManifestBuilder.RequestsKey]: { [K8sManifestBuilder.StorageKey]: InClusterRegistry.DataSize },
                },
            },
        }
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
        return K8sManifestBuilder.HiveLabelsOf(hiveId)
    }

    /** The hive an object (as kubectl returns it) is labelled for; undefined when unlabelled. */
    public static HiveOf(doc: unknown): string | undefined
    {
        const labels = (doc as { [k: string]: { [k: string]: Record<string, unknown> | undefined } | undefined } | null)?.[K8sManifestBuilder.MetadataKey]?.[K8sManifestBuilder.LabelsKey]
        const hive = labels?.[K8sManifestBuilder.HiveLabel]
        return typeof hive === 'string' ? hive : undefined
    }

    /** Whether a Namespace (as the API returns it) enforces a Pod Security level the console's admission fence admits. */
    public static EnforcesAdmittedPodSecurity(doc: unknown): boolean
    {
        const labels = (doc as { [k: string]: { [k: string]: Record<string, unknown> | undefined } | undefined } | null)?.[K8sManifestBuilder.MetadataKey]?.[K8sManifestBuilder.LabelsKey]
        const level = labels?.[K8sManifestBuilder.PodSecurityEnforceLabel]
        return typeof level === 'string' && K8sManifestBuilder.AdmittedPodSecurityLevels.includes(level)
    }

    /** The labels that mark an object as the hive's (selected by HiveLabelSelectorOf). */
    public static HiveLabelsOf(hiveId: string): Record<string, string>
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

    /** Browser-facing origin of a tenant's IdP: https://idp-<tenant>.<baseDomain>[:port]. The internal Service-DNS origin stays IdpBaseUrlOf. */
    public static IdpBrowserUrlOf(tenantId: string, baseDomain: string, port?: number): string
    {
        const suffix = port === undefined ? '' : `:${port}`
        return `${K8sManifestBuilder.IdpScheme}://${K8sManifestBuilder.IdpBrowserHostOf(tenantId, baseDomain)}${suffix}`
    }

    /** Browser-facing hostname idp-<tenant>.<baseDomain> (the second SAN on the IdP cert). */
    public static IdpBrowserHostOf(tenantId: string, baseDomain: string): string
    {
        return `${K8sManifestBuilder.IdpBrowserHostPrefix}${tenantId}.${baseDomain}`
    }

    /** Renders one tenant's IdP as an in-cluster workload: Namespace, SA (no API token), PVC, Deployment, ClusterIP Service, plus an ssl-passthrough Ingress when baseDomain is set. Hive-labeled only (no environment label, so the pull agent never selects it); secrets mounted by Secret name, never inline; no RBAC. */
    public RenderIdp(spec: IdpWorkloadSpec): string
    {
        const items: K8sObject[] = [
            this.IdpNamespaceObject(spec),
            this.IdpServiceAccount(spec),
            this.IdpClaim(spec),
            this.IdpDeployment(spec),
            this.IdpServiceObject(spec),
        ]
        if (spec.baseDomain !== undefined)
        {
            items.push(this.IdpIngressObject(spec, spec.baseDomain))
        }
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

    private SecretVolume(volumeName: string, secretName: string, items?: ReadonlyArray<{ key: string; path: string }>): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: volumeName,
            [K8sManifestBuilder.SecretKey]: {
                [K8sManifestBuilder.SecretNameKey]: secretName,
                [K8sManifestBuilder.DefaultModeKey]: K8sManifestBuilder.SecretFileMode,
                // When items is given, project ONLY those keys so a Secret that also carries sensitive keys
                // (e.g. an IdP TLS Secret's server.key) can never surface in the mount (SERVER-KEY SAFETY).
                ...(items === undefined ? {} : { [K8sManifestBuilder.ItemsKey]: items.map(i => ({ [K8sManifestBuilder.KeyKey]: i.key, [K8sManifestBuilder.PathKey]: i.path })) }),
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

    /**
     * The IdP container env. Split-host when baseDomain is set: PRAGMATIC_IDP_BASE_URL = the BROWSER base (so iss +
     * issuer + authorization_endpoint are browser-reachable) and PRAGMATIC_IDP_INTERNAL_URL = the internal
     * Service-DNS base (token_endpoint + jwks_uri the pod reaches). Absent baseDomain ⇒ single-host (BASE_URL =
     * internal, no INTERNAL_URL), byte-identical to the pre-6c pod.
     */
    private IdpEnv(spec: IdpWorkloadSpec): K8sObject[]
    {
        const internal = K8sManifestBuilder.IdpBaseUrlOf(spec.tenantId, spec.port)
        const baseUrl = spec.baseDomain === undefined ? internal : K8sManifestBuilder.IdpBrowserUrlOf(spec.tenantId, spec.baseDomain)
        return [
            this.EnvLiteral(K8sManifestBuilder.IdpPortVar, String(spec.port)),
            this.EnvLiteral(K8sManifestBuilder.IdpBaseUrlVar, baseUrl),
            ...(spec.baseDomain === undefined ? [] : [this.EnvLiteral(K8sManifestBuilder.IdpInternalUrlVar, internal)]),
            this.EnvLiteral(K8sManifestBuilder.IdpHostVar, K8sManifestBuilder.IdpBindAll),
            this.EnvLiteral(K8sManifestBuilder.IdpDataVar, K8sManifestBuilder.IdpDataMount),
            this.EnvLiteral(K8sManifestBuilder.IdpAdminTokenRefVar, spec.adminTokenRef),
        ]
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
            [K8sManifestBuilder.EnvKey]: this.IdpEnv(spec),
            [K8sManifestBuilder.VolumeMountsKey]: [
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.IdpDataMount },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpTlsVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.IdpTlsMount, [K8sManifestBuilder.ReadOnlyKey]: true },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.IdpSecretsVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.IdpSecretsMount, [K8sManifestBuilder.ReadOnlyKey]: true },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TmpVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TmpMount },
            ],
            [K8sManifestBuilder.ReadinessProbeKey]: {
                [K8sManifestBuilder.HttpGetKey]: {
                    [K8sManifestBuilder.PathKey]: EnvConventions.HealthPath,
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

    private IdpIngressObject(spec: IdpWorkloadSpec, baseDomain: string): K8sObject
    {
        const name = K8sManifestBuilder.IdpNameOf(spec.tenantId)
        const meta = this.IdpMeta(spec, name)
        const tls = spec.ingressTls
        const host = K8sManifestBuilder.IdpBrowserHostOf(spec.tenantId, baseDomain)
        // With a TLS choice the controller terminates for browsers and re-encrypts to the IdP, which keeps serving its own internal certificate.
        meta[K8sManifestBuilder.AnnotationsKey] = tls === undefined
            ? { [K8sManifestBuilder.SslPassthroughAnnotation]: K8sManifestBuilder.SslPassthroughValue }
            : {
                [K8sManifestBuilder.BackendProtocolAnnotation]: K8sManifestBuilder.BackendProtocolHttps,
                // Verify the IdP certificate on the re-encrypt hop: its own TLS Secret carries the issuing ca.crt (nginx uses it as the CA bundle),
                // and the cert is issued for the Service-DNS host, which is not the upstream name nginx would otherwise present.
                [K8sManifestBuilder.ProxySslSecretAnnotation]: `${name}${K8sManifestBuilder.NamespaceSeparator}${spec.tlsSecretName}`,
                [K8sManifestBuilder.ProxySslVerifyAnnotation]: K8sManifestBuilder.AnnotationOn,
                [K8sManifestBuilder.ProxySslNameAnnotation]: new URL(K8sManifestBuilder.IdpBaseUrlOf(spec.tenantId, spec.port)).hostname,
                [K8sManifestBuilder.ProxySslServerNameAnnotation]: K8sManifestBuilder.AnnotationOn,
                ...IngressTlsPolicy.AnnotationsFor(tls),
            }
        const tlsEntry = tls === undefined ? undefined : this.IngressTlsEntry(host, IngressTlsPolicy.SecretNameFor(tls, name))
        return this.IngressOf(meta, host, name, spec.port, tlsEntry)
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

    /** Browser host of a tenant's console: console-<tenantId>.<baseDomain>. */
    public static ConsoleHostOf(tenantId: string, baseDomain: string): string
    {
        return `${K8sManifestBuilder.ConsoleHostPrefix}${tenantId}${K8sManifestBuilder.HostDotSeparator}${baseDomain}`
    }

    /** The console's environment ClusterRole: never bound cluster-wide, only per environment namespace by the console itself. */
    public static TenantConsoleEnvRoleNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminNameOf(tenantId)}${K8sManifestBuilder.TenantConsoleEnvRoleSuffix}`
    }

    /** The get-only Role (and its RoleBinding) on the console's copied TLS source Secret in pragmatic-system. */
    public static TenantConsoleTlsRoleNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminNameOf(tenantId)}${K8sManifestBuilder.TenantConsoleTlsRoleSuffix}`
    }

    /** Secret holding the console's account-email fingerprint key (key `fingerprint.key`). */
    public static TenantConsoleFingerprintSecretNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminNameOf(tenantId)}${K8sManifestBuilder.TenantConsoleFingerprintSuffix}`
    }

    /** The ca.crt-only IdP trust Secret projected into pragmatic-system for the console pod. */
    public static TenantConsoleIdpCaSecretNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminNameOf(tenantId)}${K8sManifestBuilder.TenantConsoleIdpCaSuffix}`
    }

    /** The IdP admin-token Secret copy projected into pragmatic-system (the IdP-namespace original is unreachable from the pod). */
    public static TenantConsoleIdpTokenSecretNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminNameOf(tenantId)}${K8sManifestBuilder.TenantConsoleIdpTokenSuffix}`
    }

    /**
     * This tenant's own copy of the development TLS Secret in pragmatic-system (never the cluster-shared pragmatic-dev-tls,
     * so removing one console cannot break another): the console Ingress serves it and the console copies it on.
     */
    public static TenantConsoleDevTlsSecretNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.TenantAdminNameOf(tenantId)}${K8sManifestBuilder.TenantConsoleDevTlsSuffix}`
    }

    /**
     * Identities of the console's live-credential Secret copies in pragmatic-system (fingerprint key, IdP CA, IdP admin token):
     * the list TenantConsoleRemovalManifest deletes (older clusters carry them unlabelled). Never the seed Secret.
     */
    public static TenantConsoleCredentialIdentitiesOf(tenantId: string): K8sObject[]
    {
        return [
            K8sManifestBuilder.TenantConsoleFingerprintSecretNameOf(tenantId),
            K8sManifestBuilder.TenantConsoleIdpCaSecretNameOf(tenantId),
            K8sManifestBuilder.TenantConsoleIdpTokenSecretNameOf(tenantId),
        ].map(name => K8sManifestBuilder.SystemSecretIdentity(name))
    }

    private static SystemSecretIdentity(name: string): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.SecretKind,
            [K8sManifestBuilder.MetadataKey]: { [K8sManifestBuilder.NameKey]: name, [K8sManifestBuilder.NamespaceKey]: K8sManifestBuilder.SystemNamespace },
        }
    }

    /**
     * Selects every workload labelled for the hive (in pragmatic-system: its agent and, when installed, its tenant-admin pod).
     * Refuses an id that is not a valid label value: `pragmatic/hive==b` would also select hive `b`.
     */
    public static HiveLabelSelectorOf(hiveId: string): string
    {
        K8sManifestBuilder.AssertValidHiveId(hiveId)
        return `${K8sManifestBuilder.HiveLabel}=${hiveId}`
    }

    /** Whether a hive id is a lowercase RFC 1123 label (so also a valid label value and name component): selectors built from it match only that hive. */
    public static IsValidHiveId(hiveId: string): boolean
    {
        return hiveId.length <= K8sManifestBuilder.HiveIdMaxLength && K8sManifestBuilder.Rfc1123Name.test(hiveId)
    }

    /** Throws InvalidRecordIdError (a 400) with the operator-facing rule when the hive id is not valid. */
    public static AssertValidHiveId(hiveId: string): void
    {
        if (!K8sManifestBuilder.IsValidHiveId(hiveId))
        {
            throw new InvalidRecordIdError(K8sManifestBuilder.InvalidHiveIdMessage)
        }
    }

    /** Name of the Secret holding a hive's one-time agent bearer (key `token`). */
    public static AgentTokenSecretNameOf(hiveId: string): string
    {
        return `${K8sManifestBuilder.HiveAgentNameOf(hiveId)}${K8sManifestBuilder.AgentTokenSecretSuffix}`
    }

    /**
     * Renders one tenant's console (tenant-admin) container: shared pragmatic-system Namespace (unlabeled, first); SA with a
     * mounted API token; the console ClusterRole; its admission fence (ValidatingAdmissionPolicy + binding, applied before the
     * grant; enforcement is eventually consistent, but the console pod and its token start later in the same apply); the ClusterRoleBinding (namespaces and per-namespace binding of its env role); the env ClusterRole (bound by the console per environment namespace, never here); with a console exposure whose TLS
     * Secret is copied, a get-only Role + RoleBinding on that one source Secret; data PVC; Deployment (init container seeds
     * the data root from the seed Secret); a ClusterIP Service; and, with a console exposure, its Ingress. The token and RBAC
     * render even without `console`, by design: every console manages its environments in-cluster (including bootstrap
     * and smoke installs). Hive-labeled only, so the pull agent never selects it. Secrets are referenced by name only,
     * never inlined.
     */
    public RenderTenantAdmin(spec: TenantAdminWorkloadSpec): string
    {
        const items: K8sObject[] = [
            this.HiveAgentNamespaceObject(),
            this.TenantAdminServiceAccount(spec),
            this.TenantConsoleClusterRole(spec),
            TenantConsoleAdmission.Policy(this.TenantConsoleAdmissionSpecOf(spec)),
            TenantConsoleAdmission.Binding(this.TenantConsoleAdmissionSpecOf(spec)),
            this.TenantConsoleClusterRoleBinding(spec),
            this.TenantConsoleEnvClusterRole(spec),
            ...this.TenantConsoleTlsReadRbac(spec),
            this.TenantAdminClaim(spec),
            this.TenantAdminDeployment(spec),
            this.TenantAdminServiceObject(spec),
            ...this.TenantConsoleIngressObjects(spec),
        ]
        return this.ListOf(items)
    }

    /**
     * Identities (v1 List, name + namespace only) of everything RenderTenantAdmin can render except the shared Namespace and
     * the data PVC, plus the console's credential Secret copies, this tenant's development TLS copy in pragmatic-system, and the
     * in-hive IdP's serving objects (Deployment, Service, Ingress; never its namespace, data PVC or Secrets).
     * Optional objects (TLS Role + RoleBinding, Ingress, dev TLS copy) are always named so a removal after a TLS-source change
     * leaves nothing behind; the delete tolerates absent objects. Never the seed Secret (retained with the PVC: its master key
     * decrypts that data) and never the cluster-shared pragmatic-dev-tls. With `servesAdmission` false (a cluster below Kubernetes
     * 1.30, TenantConsoleAdmission.ServedBy) the admission policy and its binding are left out: kubectl refuses a whole delete that
     * names an unserved kind. Refuses an invalid hive id.
     */
    public TenantConsoleRemovalManifest(tenantId: string, hiveId: string, servesAdmission: boolean = true): string
    {
        K8sManifestBuilder.AssertValidHiveId(hiveId)
        const B = K8sManifestBuilder
        const name = B.TenantAdminNameOf(tenantId)
        const tlsRole = B.TenantConsoleTlsRoleNameOf(tenantId)
        const system = B.SystemNamespace
        const idp = B.IdpNameOf(tenantId)
        const items: K8sObject[] = [
            this.Identity(B.ApiVersionCore, B.ServiceAccountKind, name, system),
            this.Identity(B.ApiVersionRbac, B.ClusterRoleKind, name),
            ...(servesAdmission ? [
                this.Identity(TenantConsoleAdmission.ApiVersion, TenantConsoleAdmission.PolicyKind, name),
                this.Identity(TenantConsoleAdmission.ApiVersion, TenantConsoleAdmission.BindingKind, name),
            ] : []),
            this.Identity(B.ApiVersionRbac, B.ClusterRoleBindingKind, name),
            this.Identity(B.ApiVersionRbac, B.ClusterRoleKind, B.TenantConsoleEnvRoleNameOf(tenantId)),
            this.Identity(B.ApiVersionRbac, B.RoleKind, tlsRole, system),
            this.Identity(B.ApiVersionRbac, B.RoleBindingKind, tlsRole, system),
            this.Identity(B.ApiVersionApps, B.DeploymentKind, name, system),
            this.Identity(B.ApiVersionCore, B.ServiceKind, name, system),
            this.Identity(B.ApiVersionNetworking, B.IngressKind, name, system),
            this.Identity(B.ApiVersionNetworking, B.NetworkPolicyKind, name, system),
            ...B.TenantConsoleCredentialIdentitiesOf(tenantId),
            B.SystemSecretIdentity(B.TenantConsoleDevTlsSecretNameOf(tenantId)),
            // The in-hive IdP stops serving with its console; its namespace, data volume and Secrets stay (a reinstall resumes it).
            this.Identity(B.ApiVersionApps, B.DeploymentKind, idp, idp),
            this.Identity(B.ApiVersionCore, B.ServiceKind, idp, idp),
            this.Identity(B.ApiVersionNetworking, B.IngressKind, idp, idp),
        ]
        return this.ListOf(items)
    }

    /** A delete-by-name identity: apiVersion, kind and metadata { name, namespace? } only. */
    private Identity(apiVersion: string, kind: string, name: string, namespace?: string): K8sObject
    {
        const metadata: K8sObject = { [K8sManifestBuilder.NameKey]: name }
        if (namespace !== undefined)
        {
            metadata[K8sManifestBuilder.NamespaceKey] = namespace
        }
        return {
            [K8sManifestBuilder.ApiVersionKey]: apiVersion,
            [K8sManifestBuilder.KindKey]: kind,
            [K8sManifestBuilder.MetadataKey]: metadata,
        }
    }

    private TenantConsoleAdmissionSpecOf(spec: TenantAdminWorkloadSpec): TenantConsoleAdmissionSpec
    {
        return {
            name: K8sManifestBuilder.TenantAdminNameOf(spec.tenantId),
            labels: this.HiveLabels(spec.hiveId),
            hiveId: spec.hiveId,
            hiveLabel: K8sManifestBuilder.HiveLabel,
            podSecurityLabel: K8sManifestBuilder.PodSecurityEnforceLabel,
            podSecurityLevels: K8sManifestBuilder.AdmittedPodSecurityLevels,
            namespacePrefix: K8sManifestBuilder.EnvNamespacePrefix,
            serviceAccountName: K8sManifestBuilder.TenantAdminNameOf(spec.tenantId),
            serviceAccountNamespace: K8sManifestBuilder.SystemNamespace,
            envRoleName: K8sManifestBuilder.TenantConsoleEnvRoleNameOf(spec.tenantId),
            envBindingName: K8sManifestBuilder.TenantConsoleEnvBindingName,
        }
    }

    /** existing-secret / cert-manager: IngressTlsPolicy.SecretNameFor; development: this tenant's own dev TLS copy. */
    private TenantConsoleTlsSecretNameOf(spec: TenantAdminWorkloadSpec, tls: IngressTls): string
    {
        return tls.source === IngressTlsSource.Development
            ? K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf(spec.tenantId)
            : IngressTlsPolicy.SecretNameFor(tls, K8sManifestBuilder.TenantAdminNameOf(spec.tenantId))
    }

    private ListOf(items: K8sObject[]): string
    {
        return JSON.stringify({
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ListKind,
            [K8sManifestBuilder.ItemsKey]: items,
        })
    }

    /** The token is mounted: the console drives environment namespaces through the Kubernetes API with this identity. */
    private TenantAdminServiceAccount(spec: TenantAdminWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionCore,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceAccountKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(spec.hiveId, K8sManifestBuilder.TenantAdminNameOf(spec.tenantId)),
            [K8sManifestBuilder.AutomountTokenKey]: true,
        }
    }

    /**
     * The console's only cluster-wide grant: get/create/delete namespaces, create rolebindings, and bind exactly its own env
     * ClusterRole. RBAC cannot fence names by prefix or label, so these verbs are cluster-wide; RBAC and admission fence them
     * together: the console's ValidatingAdmissionPolicy (TenantConsoleAdmission) admits them only on this hive's
     * `pragmatic-env-` namespaces and only for its own env RoleBinding to its own ServiceAccount, and the console's kubectl
     * guard applies the same prefix rule client-side. The bind restriction caps escalation: a RoleBinding the console creates
     * can only grant its env role (never cluster-admin), and only inside the namespace the binding lives in.
     */
    private TenantConsoleClusterRole(spec: TenantAdminWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionRbac,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ClusterRoleKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentClusterMeta(spec.hiveId, K8sManifestBuilder.TenantAdminNameOf(spec.tenantId)),
            [K8sManifestBuilder.RulesKey]: [
                this.Rule(K8sManifestBuilder.CoreApiGroup, [K8sManifestBuilder.NamespacesResource], [K8sManifestBuilder.GetVerb, K8sManifestBuilder.CreateVerb, K8sManifestBuilder.DeleteVerb]),
                this.Rule(K8sManifestBuilder.RbacApiGroup, [K8sManifestBuilder.RoleBindingsResource], [K8sManifestBuilder.CreateVerb]),
                this.Rule(K8sManifestBuilder.RbacApiGroup, [K8sManifestBuilder.ClusterRolesResource], [K8sManifestBuilder.BindVerb], [K8sManifestBuilder.TenantConsoleEnvRoleNameOf(spec.tenantId)]),
            ],
        }
    }

    private TenantConsoleClusterRoleBinding(spec: TenantAdminWorkloadSpec): K8sObject
    {
        const name = K8sManifestBuilder.TenantAdminNameOf(spec.tenantId)
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionRbac,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ClusterRoleBindingKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentClusterMeta(spec.hiveId, name),
            [K8sManifestBuilder.SubjectsKey]: [this.TenantConsoleSubject(spec)],
            [K8sManifestBuilder.RoleRefKey]: this.RoleRef(K8sManifestBuilder.ClusterRoleKind, name),
        }
    }

    /**
     * What an environment manifest needs inside its own namespace. Deliberately NOT bound by this manifest: the console binds
     * it per environment namespace (RoleBinding `pragmatic-tenant-console`), so it never applies cluster-wide.
     */
    private TenantConsoleEnvClusterRole(spec: TenantAdminWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionRbac,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ClusterRoleKind,
            [K8sManifestBuilder.MetadataKey]: this.HiveAgentClusterMeta(spec.hiveId, K8sManifestBuilder.TenantConsoleEnvRoleNameOf(spec.tenantId)),
            [K8sManifestBuilder.RulesKey]: [
                this.Rule(K8sManifestBuilder.CoreApiGroup, K8sManifestBuilder.EnvCoreResources, [K8sManifestBuilder.AnyVerb]),
                this.Rule(K8sManifestBuilder.AppsApiGroup, K8sManifestBuilder.EnvAppsResources, [K8sManifestBuilder.AnyVerb]),
                this.Rule(K8sManifestBuilder.NetworkingApiGroup, K8sManifestBuilder.EnvNetworkingResources, [K8sManifestBuilder.AnyVerb]),
            ],
        }
    }

    /**
     * With a console exposure whose TLS Secret is copied into each Ingress namespace (existing-secret, development): a Role +
     * RoleBinding in pragmatic-system granting `get` on that one source Secret, so the console can copy it into environment
     * namespaces. cert-manager writes per-Ingress Secrets itself, so it gets none. Empty otherwise.
     */
    private TenantConsoleTlsReadRbac(spec: TenantAdminWorkloadSpec): K8sObject[]
    {
        if (spec.console === undefined || !IngressTlsPolicy.CopiesSecret(spec.console.ingressTls))
        {
            return []
        }
        const name = K8sManifestBuilder.TenantConsoleTlsRoleNameOf(spec.tenantId)
        const source = this.TenantConsoleTlsSecretNameOf(spec, spec.console.ingressTls)
        return [
            {
                [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionRbac,
                [K8sManifestBuilder.KindKey]: K8sManifestBuilder.RoleKind,
                [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(spec.hiveId, name),
                [K8sManifestBuilder.RulesKey]: [this.Rule(K8sManifestBuilder.CoreApiGroup, [K8sManifestBuilder.SecretsResource], [K8sManifestBuilder.GetVerb], [source])],
            },
            {
                [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionRbac,
                [K8sManifestBuilder.KindKey]: K8sManifestBuilder.RoleBindingKind,
                [K8sManifestBuilder.MetadataKey]: this.HiveAgentNamespacedMeta(spec.hiveId, name),
                [K8sManifestBuilder.SubjectsKey]: [this.TenantConsoleSubject(spec)],
                [K8sManifestBuilder.RoleRefKey]: this.RoleRef(K8sManifestBuilder.RoleKind, name),
            },
        ]
    }

    /** TLS-terminating nginx Ingress for the console host (ServerIngress shape); empty without a console exposure. */
    private TenantConsoleIngressObjects(spec: TenantAdminWorkloadSpec): K8sObject[]
    {
        if (spec.console === undefined)
        {
            return []
        }
        const name = K8sManifestBuilder.TenantAdminNameOf(spec.tenantId)
        const { host, ingressTls } = spec.console
        const meta = this.HiveAgentNamespacedMeta(spec.hiveId, name)
        return [this.TerminatingIngress(meta, host, name, spec.port, ingressTls, this.TenantConsoleTlsSecretNameOf(spec, ingressTls)), this.TenantConsoleNetworkPolicy(spec)]
    }

    /**
     * With a console exposure the console trusts the forwarded-for header (TrustedProxy), so only the ingress controller's namespace
     * may reach its port: any other pod (an environment workload included) could otherwise forge the address the login throttle keys
     * on. Ingress only; the console's own egress (API server, IdP, DNS) is not restricted.
     */
    private TenantConsoleNetworkPolicy(spec: TenantAdminWorkloadSpec): K8sObject
    {
        const B = K8sManifestBuilder
        const name = B.TenantAdminNameOf(spec.tenantId)
        return {
            [B.ApiVersionKey]: B.ApiVersionNetworking,
            [B.KindKey]: B.NetworkPolicyKind,
            [B.MetadataKey]: this.HiveAgentNamespacedMeta(spec.hiveId, name),
            [B.SpecKey]: {
                [B.PodSelectorKey]: { [B.MatchLabelsKey]: this.Selector(name) },
                [B.PolicyTypesKey]: [B.IngressPolicyType],
                [B.IngressRulesKey]: [{
                    [B.FromKey]: [{ [B.NamespaceSelectorKey]: { [B.MatchLabelsKey]: { [B.NamespaceNameLabel]: spec.console?.ingressNamespace ?? B.IngressControllerNamespace } } }],
                    [B.PortsKey]: [{ [B.ProtocolKey]: B.TcpProtocol, [B.PortKey]: spec.port }],
                }],
            },
        }
    }

    /**
     * TLS-terminating nginx Ingress (environment server and console): the TLS choice's annotations (when any) on `meta`, one
     * tls entry for the host (secretName only when given: none means the controller's default certificate), host -> Service.
     */
    private TerminatingIngress(meta: K8sObject, host: string, serviceName: string, port: number, tls: IngressTls | undefined, secretName: string | undefined): K8sObject
    {
        if (tls !== undefined)
        {
            const annotations = IngressTlsPolicy.AnnotationsFor(tls)
            if (Object.keys(annotations).length > 0)
            {
                meta[K8sManifestBuilder.AnnotationsKey] = annotations
            }
        }
        return this.IngressOf(meta, host, serviceName, port, this.IngressTlsEntry(host, secretName))
    }

    private IngressTlsEntry(host: string, secretName: string | undefined): K8sObject
    {
        const entry: K8sObject = { [K8sManifestBuilder.HostsKey]: [host] }
        if (secretName !== undefined)
        {
            entry[K8sManifestBuilder.SecretNameKey] = secretName
        }
        return entry
    }

    /** The one nginx Ingress shape: class nginx, an optional single tls entry, and `/` (Prefix) on the host -> Service:port. */
    private IngressOf(meta: K8sObject, host: string, serviceName: string, port: number, tlsEntry: K8sObject | undefined): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiVersionKey]: K8sManifestBuilder.ApiVersionNetworking,
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.IngressKind,
            [K8sManifestBuilder.MetadataKey]: meta,
            [K8sManifestBuilder.SpecKey]: {
                [K8sManifestBuilder.IngressClassNameKey]: K8sManifestBuilder.IngressClassNginx,
                ...(tlsEntry === undefined ? {} : { [K8sManifestBuilder.TlsKey]: [tlsEntry] }),
                [K8sManifestBuilder.RulesKey]: [{
                    [K8sManifestBuilder.HostKey]: host,
                    [K8sManifestBuilder.HttpKey]: {
                        [K8sManifestBuilder.PathsKey]: [{
                            [K8sManifestBuilder.PathKey]: K8sManifestBuilder.IngressRootPath,
                            [K8sManifestBuilder.PathTypeKey]: K8sManifestBuilder.PathTypePrefix,
                            [K8sManifestBuilder.BackendKey]: {
                                [K8sManifestBuilder.ServiceKey]: {
                                    [K8sManifestBuilder.NameKey]: serviceName,
                                    [K8sManifestBuilder.PortKey]: { [K8sManifestBuilder.PortNumberKey]: port },
                                },
                            },
                        }],
                    },
                }],
            },
        }
    }

    private TenantConsoleSubject(spec: TenantAdminWorkloadSpec): K8sObject
    {
        return {
            [K8sManifestBuilder.KindKey]: K8sManifestBuilder.ServiceAccountKind,
            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminNameOf(spec.tenantId),
            [K8sManifestBuilder.NamespaceKey]: K8sManifestBuilder.SystemNamespace,
        }
    }

    private RoleRef(kind: string, name: string): K8sObject
    {
        return {
            [K8sManifestBuilder.ApiGroupKey]: K8sManifestBuilder.RbacApiGroup,
            [K8sManifestBuilder.KindKey]: kind,
            [K8sManifestBuilder.NameKey]: name,
        }
    }

    private Rule(apiGroup: string, resources: ReadonlyArray<string>, verbs: ReadonlyArray<string>, resourceNames?: ReadonlyArray<string>): K8sObject
    {
        const rule: K8sObject = {
            [K8sManifestBuilder.ApiGroupsKey]: [apiGroup],
            [K8sManifestBuilder.ResourcesKey]: [...resources],
            [K8sManifestBuilder.VerbsKey]: [...verbs],
        }
        if (resourceNames !== undefined)
        {
            rule[K8sManifestBuilder.ResourceNamesKey] = [...resourceNames]
        }
        return rule
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
            [K8sManifestBuilder.AutomountTokenKey]: true,
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
                ...this.TenantAdminIdpVolumes(spec),
                ...this.TenantConsoleFingerprintVolumes(spec),
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

    /** Secret volumes carrying the operator-provisioned IdP CA cert and admin token (by ref only). */
    private TenantAdminIdpVolumes(spec: TenantAdminWorkloadSpec): K8sObject[]
    {
        if (spec.idp === undefined)
        {
            return []
        }
        return [
            this.SecretVolume(K8sManifestBuilder.TenantAdminIdpCaVolume, spec.idp.caSecretName, [{ key: K8sManifestBuilder.TenantAdminIdpCaItemKey, path: K8sManifestBuilder.TenantAdminIdpCaItemKey }]),
            this.SecretVolume(K8sManifestBuilder.TenantAdminIdpTokenVolume, spec.idp.adminTokenSecretName, [{ key: K8sManifestBuilder.TenantAdminIdpTokenItemKey, path: K8sManifestBuilder.TenantAdminIdpTokenItemKey }]),
        ]
    }

    private TenantAdminIdpMounts(spec: TenantAdminWorkloadSpec): K8sObject[]
    {
        if (spec.idp === undefined)
        {
            return []
        }
        return [
            { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminIdpCaVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TenantAdminIdpCaMount, [K8sManifestBuilder.ReadOnlyKey]: true },
            { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminIdpTokenVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TenantAdminIdpTokenMount, [K8sManifestBuilder.ReadOnlyKey]: true },
        ]
    }

    private TenantAdminIdpEnv(spec: TenantAdminWorkloadSpec): K8sObject[]
    {
        if (spec.idp === undefined)
        {
            return []
        }
        return [
            this.EnvLiteral(TenantAdminEnv.IdpBrowserBaseUrl, spec.idp.browserBaseUrl),
            this.EnvLiteral(TenantAdminEnv.IdpBaseUrl, spec.idp.internalBaseUrl),
            this.EnvLiteral(TenantAdminEnv.IdpCaFile, K8sManifestBuilder.TenantAdminIdpCaFile),
            this.EnvLiteral(TenantAdminEnv.IdpAdminTokenFile, K8sManifestBuilder.TenantAdminIdpTokenFile),
        ]
    }

    /** The account-email fingerprint key Secret, projecting ONLY `fingerprint.key`; empty when none is named. */
    private TenantConsoleFingerprintVolumes(spec: TenantAdminWorkloadSpec): K8sObject[]
    {
        if (spec.fingerprintKeySecretName === undefined)
        {
            return []
        }
        const item = K8sManifestBuilder.FingerprintItemKey
        return [this.SecretVolume(K8sManifestBuilder.FingerprintVolume, spec.fingerprintKeySecretName, [{ key: item, path: item }])]
    }

    private TenantConsoleFingerprintMounts(spec: TenantAdminWorkloadSpec): K8sObject[]
    {
        if (spec.fingerprintKeySecretName === undefined)
        {
            return []
        }
        return [{ [K8sManifestBuilder.NameKey]: K8sManifestBuilder.FingerprintVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.FingerprintMount, [K8sManifestBuilder.ReadOnlyKey]: true }]
    }

    /** Console host, trusted proxy (the Ingress controller forwards the user's address) and the TLS choice; plus the fingerprint key path. */
    private TenantConsoleEnv(spec: TenantAdminWorkloadSpec): K8sObject[]
    {
        const env: K8sObject[] = []
        if (spec.console !== undefined)
        {
            env.push(this.EnvLiteral(TenantAdminEnv.ConsoleHost, spec.console.host))
            env.push(this.EnvLiteral(TenantAdminEnv.TrustedProxy, K8sManifestBuilder.TrueText))
            for (const [key, value] of Object.entries(IngressTlsPolicy.ToEnv(spec.console.ingressTls)))
            {
                env.push(this.EnvLiteral(key, value))
            }
        }
        if (spec.fingerprintKeySecretName !== undefined)
        {
            env.push(this.EnvLiteral(TenantAdminEnv.FingerprintKeyFile, K8sManifestBuilder.FingerprintKeyFilePath))
        }
        return env
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
                ...this.TenantAdminIdpEnv(spec),
                ...this.TenantConsoleEnv(spec),
            ],
            [K8sManifestBuilder.VolumeMountsKey]: [
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TenantAdminDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TenantAdminDataMount },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.TmpVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.TmpMount },
                ...this.TenantAdminIdpMounts(spec),
                ...this.TenantConsoleFingerprintMounts(spec),
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

    /**
     * Maps a secret ref (which may carry a store path such as `<tenant>/appdb/password`) to a valid
     * RFC-1123 object name. A ref that is already valid is kept verbatim; otherwise the sanitised
     * form gets a hash of the ORIGINAL ref appended so distinct refs never collapse to one name.
     */
    public static SecretNameOf(ref: string): string
    {
        if (K8sManifestBuilder.Rfc1123Name.test(ref) && ref.length <= K8sManifestBuilder.NameBaseMax)
        {
            return ref
        }
        const base = ref.toLowerCase()
            .replace(K8sManifestBuilder.NonNameChars, K8sManifestBuilder.NameDash)
            .replace(K8sManifestBuilder.EdgeDashes, K8sManifestBuilder.Empty)
            .slice(0, K8sManifestBuilder.NameBaseMax)
            .replace(K8sManifestBuilder.EdgeDashes, K8sManifestBuilder.Empty)
        const hash = createHash(K8sManifestBuilder.NameHashAlgorithm).update(ref).digest(K8sManifestBuilder.NameHashEncoding).slice(0, K8sManifestBuilder.NameHashLength)
        return (base.length > 0 ? base : K8sManifestBuilder.NameFallback) + K8sManifestBuilder.NameDash + hash
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
                // Pod Security Admission: every environment namespace enforces `baseline` (no privileged / host access), so the
                // console's env role cannot run a node-escaping pod there; the console's admission fence requires this label.
                [K8sManifestBuilder.LabelsKey]: {
                    [K8sManifestBuilder.EnvironmentLabel]: workload.environmentName,
                    [K8sManifestBuilder.HiveLabel]: workload.hiveId,
                    [K8sManifestBuilder.PodSecurityEnforceLabel]: K8sManifestBuilder.PodSecurityBaseline,
                    [K8sManifestBuilder.PodSecurityEnforceVersionLabel]: K8sManifestBuilder.PodSecurityLatest,
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
        const volumeMounts: K8sObject[] = [
            { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerConfigVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerConfigMount, [K8sManifestBuilder.ReadOnlyKey]: true },
            { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerSecretsVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerSecretsMount, [K8sManifestBuilder.ReadOnlyKey]: true },
            { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerDataMount },
        ]
        const volumes: K8sObject[] = [
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
        ]
        if (workload.federation)
        {
            // The served app uses the default fetch client with no ca: plumb, so it trusts the IdP via NODE_EXTRA_CA_CERTS.
            // Only the public ca.crt is projected (items selector): the IdP server key can never surface in this pod.
            env.push(this.EnvLiteral(K8sManifestBuilder.NodeExtraCaCertsVar, K8sManifestBuilder.EnvIdpCaFile))
            volumeMounts.push({ [K8sManifestBuilder.NameKey]: K8sManifestBuilder.EnvIdpCaVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.EnvIdpCaMount, [K8sManifestBuilder.ReadOnlyKey]: true })
            volumes.push(this.SecretVolume(K8sManifestBuilder.EnvIdpCaVolume, workload.federation.caSecretName, [{ key: K8sManifestBuilder.EnvIdpCaItemKey, path: K8sManifestBuilder.EnvIdpCaItemKey }]))
        }
        const initContainers: K8sObject[] = [this.ServerSeedContainer(workload)]
        if (workload.appDeployment)
        {
            // Only the public <trustKeyRef>.pub is projected (items selector); the unpacker verifies the app artifact against it.
            const pubFile = `${workload.appDeployment.trustKeyRef}${K8sManifestBuilder.UiPubSuffix}`
            initContainers.push(this.UiUnpackContainer(workload, workload.appDeployment))
            volumes.push(this.SecretVolume(K8sManifestBuilder.UiTrustVolume, workload.appDeployment.trustSecretName, [{ key: pubFile, path: pubFile }]))
        }
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
                        [K8sManifestBuilder.InitContainersKey]: initContainers,
                        [K8sManifestBuilder.ContainersKey]: [{
                            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerContainerName,
                            [K8sManifestBuilder.ImageKey]: workload.image,
                            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
                            [K8sManifestBuilder.PortsKey]: [{ [K8sManifestBuilder.ContainerPortKey]: workload.serverPort }],
                            [K8sManifestBuilder.EnvKey]: env,
                            [K8sManifestBuilder.VolumeMountsKey]: volumeMounts,
                            [K8sManifestBuilder.ReadinessProbeKey]: {
                                [K8sManifestBuilder.HttpGetKey]: {
                                    [K8sManifestBuilder.PathKey]: EnvConventions.HealthPath,
                                    [K8sManifestBuilder.PortKey]: workload.serverPort,
                                },
                            },
                        }],
                        [K8sManifestBuilder.VolumesKey]: volumes,
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

    /** Pulls, verifies and unpacks the app UI artifact into the shared data dir. Same hardened context as the seed container; the data PVC (fsGroup) stays writable. */
    private UiUnpackContainer(workload: EnvironmentWorkload, app: WorkloadAppDeployment): K8sObject
    {
        return {
            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.UiUnpackContainerName,
            [K8sManifestBuilder.ImageKey]: workload.image,
            [K8sManifestBuilder.ImagePullPolicyKey]: K8sManifestBuilder.IfNotPresent,
            [K8sManifestBuilder.CommandKey]: [K8sManifestBuilder.NodeBinary, K8sManifestBuilder.UiUnpackBinPath],
            [K8sManifestBuilder.SecurityContextKey]: this.ServerSeedSecurityContext(),
            [K8sManifestBuilder.EnvKey]: [
                this.EnvLiteral(K8sManifestBuilder.UiRegistryBaseVar, app.registryPullBase),
                this.EnvLiteral(K8sManifestBuilder.UiRepoVar, app.repo),
                this.EnvLiteral(K8sManifestBuilder.UiArtifactTagVar, app.artifactTag),
                this.EnvLiteral(K8sManifestBuilder.UiSigTagVar, `${app.artifactTag}${UiArtifact.SignatureTagSuffix}`),
                this.EnvLiteral(K8sManifestBuilder.UiManifestDigestVar, app.manifestDigest),
                this.EnvLiteral(K8sManifestBuilder.UiAppNameVar, app.appName),
                this.EnvLiteral(K8sManifestBuilder.UiAppVersionVar, app.appVersion),
                this.EnvLiteral(K8sManifestBuilder.UiTrustRootRefVar, app.trustKeyRef),
                this.EnvLiteral(K8sManifestBuilder.UiDataDirVar, this.MountedFile(this.MountedFile(K8sManifestBuilder.ServerDataMount, workload.environmentId), K8sManifestBuilder.ApplicationsDir)),
                this.EnvLiteral(K8sManifestBuilder.UiTrustDirVar, K8sManifestBuilder.UiTrustMount),
            ],
            [K8sManifestBuilder.VolumeMountsKey]: [
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.ServerDataVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.ServerDataMount },
                { [K8sManifestBuilder.NameKey]: K8sManifestBuilder.UiTrustVolume, [K8sManifestBuilder.MountPathKey]: K8sManifestBuilder.UiTrustMount, [K8sManifestBuilder.ReadOnlyKey]: true },
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

    /**
     * Per-env TLS-TERMINATING Ingress: <environmentId>.<baseDomain> → the env Service. The env server speaks plain
     * HTTP (pragmatic-server-host serves node:http in-cluster), so — unlike the IdP, which serves its own HTTPS and
     * uses ssl-passthrough — the ingress controller terminates TLS here and proxies HTTP to the backend. With a
     * federation.ingressTls choice the host serves the Secret from IngressTlsPolicy.SecretNameFor (plus the cert-manager
     * annotation for that source); with none, ingress-nginx serves its default self-signed cert (the Playwright smoke
     * uses ignoreHTTPSErrors). NEVER passthrough (that would hand raw TLS to an HTTP server).
     */
    private ServerIngress(workload: EnvironmentWorkload, baseDomain: string): K8sObject
    {
        const name = K8sManifestBuilder.ServerDeploymentOf(workload.environmentName)
        const host = K8sManifestBuilder.EnvBrowserHostOf(workload.environmentId, baseDomain)
        const tls = workload.federation?.ingressTls
        const meta = this.Meta(workload, name)
        // TLS section (no secretName without an Ingress TLS choice -> controller default cert) makes nginx terminate TLS for the host.
        const secretName = tls === undefined ? undefined : IngressTlsPolicy.SecretNameFor(tls, name)
        return this.TerminatingIngress(meta, host, name, workload.serverPort, tls, secretName)
    }

    /** Browser-facing hostname <environmentId>.<baseDomain> of a federated in-cluster environment. */
    public static EnvBrowserHostOf(environmentId: string, baseDomain: string): string
    {
        return `${environmentId}${K8sManifestBuilder.HostDotSeparator}${baseDomain}`
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
                                            [K8sManifestBuilder.NameKey]: K8sManifestBuilder.SecretNameOf(db.passwordRef),
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
