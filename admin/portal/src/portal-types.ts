// Environment kinds; values match the server wire strings in EnvironmentDto.type.
export enum EnvironmentType
{
    Development = 'development',
    Runtime = 'runtime'
}

export type EnvironmentDto =
{
    name: string
    template: string
    type: string
    environmentId: string
    hostPort: number
    status: string
    createdAt: string
    httpUrl: string
    wsUrl: string
}

export type ClientDto =
{
    id: string
    displayName: string
    subscriptionRef?: string
    createdAt: string
}

export type TenantDto =
{
    id: string
    clientId: string
    displayName: string
    createdAt?: string
}

// POST /api/tenants provisions the tenant's Owner and reveals its password exactly once in the response.
export type TenantOwnerDto = { email: string; principalId: string; password: string }
export type CreatedTenantDto = TenantDto & { owner: TenantOwnerDto }

// A reset tenant Owner password (the owner-password route's reply), shown once. sessionsRevoked is false, with a
// warning to show, when the password changed but the Owner's existing sessions could not be ended.
export type OwnerPasswordResetDto = { ownerEmail: string; ownerPassword: string; sessionsRevoked: boolean; warning?: string }

export type HiveClusterBackend = 'aks' | 'eks' | 'gke' | 'private' | 'local'
export type HiveProvisionMode = 'provision' | 'attach'

// Where the certificate of an Ingress the hive serves comes from; values match the server wire strings.
export enum IngressTlsSource
{
    ExistingSecret = 'existing-secret',
    CertManager = 'cert-manager',
    Development = 'development',
}

// Where a hive serves its tenant's console and how it is secured. No host: console-<tenantId>.<baseDomain>.
// ingressNamespace: the ingress controller's namespace, the only one the console's NetworkPolicy admits (absent: ingress-nginx).
export type HiveConsoleSpecDto = { baseDomain: string; host?: string; tls: { source: IngressTlsSource; secretName?: string; clusterIssuer?: string }; ingressNamespace?: string }

export type HiveDto =
{
    id: string
    tenantId: string
    displayName: string
    cluster: { backend: HiveClusterBackend; mode: HiveProvisionMode; configRef?: string }
    registry: { mode: HiveProvisionMode; endpoint?: string; credentialRef?: string }
    trustRootRef?: string
    // Set once the operator chose to run the tenant console in this hive.
    console?: HiveConsoleSpecDto
}

export type GraphDto =
{
    name: string
    description: string
    packageCount: number
    createdAt: string
}

export type PromotionResultDto =
{
    graphName: string
    packageCount: number
    targetEnv: string
}

export type GraphLoadedDto =
{
    name: string
    packages: { id: string; version: string }[]
    promotedAt: string
}

// The reply to an own-password change: changed; whether the other sessions were signed out; why to look (warning) when
// they were not, or when no fresh session could be issued (sign in again).
export type PasswordChangedDto = { ok: boolean; otherSessionsEnded: boolean; warning?: string }

export type OperatorDto =
{
    email: string
    principalId: string
    role: string
}

export type GatingDto = { tenantId: string; version: string; gatedAt: string }
export type SelectionDto = { hiveId: string; targetVersion: string; selectedAt: string }
export type OperatorSummaryDto = { email: string; role: string; disabled?: boolean }
export type ManifestDto = { id: string; image: string; notes?: string; publishedAt: string; withdrawn?: boolean; channel?: 'stable' | 'early'; digest?: string; signed?: boolean; withdrawal?: { reason: string; actor: string; at: string }; release?: ManifestReleaseDto }

// The outcome of verifying a registry release on import; values match the server wire strings.
export enum ReleaseVerification
{
    Verified = 'verified',
    Rejected = 'rejected',
}

// The applications a release ships, one image each; values match the server's image names (ReleaseApps.All order).
export enum ReleaseApp
{
    PlatformAdmin = 'pragmatic-platform-admin',
    PlatformEdge = 'pragmatic-platform-edge',
    EnvServer = 'pragmatic-env-server',
    EnvGateway = 'pragmatic-env-gateway',
    HiveAgent = 'pragmatic-hive-agent',
    TenantAdmin = 'pragmatic-tenant-admin',
    TenantIdp = 'pragmatic-tenant-idp',
    UiUnpack = 'pragmatic-ui-unpack',
}

// Provenance of a version imported from the release registry (mirrors the server's ManifestRelease); absent on
// locally published manifests. A Rejected one carries only its reason.
export type ManifestReleaseDto = {
    state: ReleaseVerification
    serverCommit?: string
    siblingCommits?: Record<string, string>
    builtAt?: string
    signingKeyId?: string
    images?: Record<ReleaseApp, { repository: string; digest: string }>
    rejectedReason?: string
}

// POST /api/releases/refresh's reply: the versions imported and rejected, how many were already known, and the
// registry versions hidden by a local manifest with the same id.
export type ReleaseRefreshDto = { imported: string[]; rejected: string[]; unchanged: number; shadowed: string[] }
export type EnvRolloutDto = { environmentName: string; runningImage?: string; obsolete: boolean; ready: boolean }
export type HiveRolloutDto = { hiveId: string; targetVersion?: string; environments: EnvRolloutDto[] }

export type FleetEnvDto = { name: string; ready: boolean; image?: string; detail: string }

export type FleetHiveDto = {
    id: string
    displayName: string
    tenant: { id: string; displayName: string } | null
    client: { id: string; displayName: string } | null
    clusterBackend: string
    clusterMode: string
    lastSeen: string | null
    environments: FleetEnvDto[]
}

// A record that already exists, used as is by the provision.
export type ExistingRecordRefDto = { existing: true; id: string }

// The client and the tenant are each new or an existing record; the hive is always new.
export type ProvisionInputDto =
{
    client: { id: string; displayName: string; subscriptionRef?: string } | ExistingRecordRefDto
    tenant: { id: string; displayName: string; ownerEmail: string } | ExistingRecordRefDto
    hive: { id: string; displayName: string; cluster: HiveDto['cluster']; registry: HiveDto['registry']; trustRootRef?: string }
}

// The Owner's email and password come back only when a new tenant was created.
export type ProvisionSecretsDto = { ownerEmail?: string; ownerPassword?: string; agentToken: string }

export type ProvisionResultDto = { client: ClientDto; tenant: TenantDto; hive: HiveDto; secrets: ProvisionSecretsDto }

export type PolicyDto = { tenantId: string; hiveId?: string; channels?: ('stable' | 'early')[]; minVersion?: string; hold?: { reason: string; actor: string; at: string } }

// note: what the operation kept or skipped, when it says (e.g. a hive delete's retained objects).
export type ActivityDto = { id: string; actor: string; method: string; path: string; status: number; at: string; note?: string }
export type ObservationDto = { id: string; hiveId: string; environments: { environmentName: string; ready: boolean; runningImage?: string; detail: string }[]; reportedAt: string }
export type LedgerDto = { id: string; tenantId?: string; hiveId?: string; version: string; action: string; at: string }

// A hive agent's install bundle: the agent's Kubernetes objects (a v1 List, JSON) and where its token Secret goes. Never the token.
export type HiveBootstrapDto =
{
    hiveId: string
    fileName: string
    manifest: string
    namespace: string
    agentName: string
    // Selects the hive's deployments that read the token Secret (restart them after a reissue).
    hiveSelector: string
    tokenSecretName: string
    tokenSecretKey: string
    channelUrl: string
    // True when the control plane installs the agent itself (a Local hive): the automatic path is offered first.
    autoInstall: boolean
}

// Where an automatic agent install stands; values match the server wire strings.
export enum AgentInstallState
{
    Installing = 'installing',
    Connected = 'connected',
    Failed = 'failed',
}

// The automatic install's steps, in order; values match the server wire strings.
export enum AgentInstallStep
{
    PreparingCluster = 'preparing-cluster',
    ApplyingAgent = 'applying-agent',
    StoringToken = 'storing-token',
    RestartingAgent = 'restarting-agent',
    WaitingForCheckIn = 'waiting-for-check-in',
}

// An automatic agent install's status (the agent-install route's reply). Never carries the agent token.
export type AgentInstallStatusDto =
{
    state: AgentInstallState
    step: AgentInstallStep
    startedAt: string
    finishedAt?: string
    error?: string
}

// Where an in-hive console install stands; values match the server wire strings. Deployed: the console is running,
// its first report is still to come. Reported: the running console has reported to the control plane.
export enum ConsoleInstallState
{
    Installing = 'installing',
    Deployed = 'deployed',
    Failed = 'failed',
    Reported = 'reported',
}

// The console install's steps, in order; values match the server wire strings.
export enum ConsoleInstallStep
{
    CheckingAgent = 'checking-agent',
    PreparingCertificates = 'preparing-certificates',
    ApplyingConsole = 'applying-console',
    StoringSecrets = 'storing-secrets',
    WaitingForRollout = 'waiting-for-rollout',
    SeedingOwner = 'seeding-owner',
}

// A console install's status (the console-install route's reply). Never carries a secret; devCaFile is the
// development CA certificate's path on the control plane's machine (development TLS only). reportedAt and stale
// (Reported only): when the console last reported, and whether that was more than a day ago.
export type ConsoleInstallStatusDto =
{
    state: ConsoleInstallState
    step: ConsoleInstallStep
    startedAt: string
    finishedAt?: string
    error?: string
    consoleUrl?: string
    devCaFile?: string
    reportedAt?: string
    stale?: boolean
}

// Where a tenant's email domains come from: its platform record (control-plane tenant) or its in-hive console's
// report; values match the server wire strings.
export enum EmailDomainSource
{
    Tenant = 'tenant',
    Console = 'console',
}

// Where a claimed email domain stands with the platform; values match the server wire strings.
export enum DomainApprovalState
{
    Approved = 'approved',
    Verified = 'verified',
    VerifiedContested = 'verified-contested',
    Revoked = 'revoked',
    Pending = 'pending',
}

// One domain of a tenant as the operator reviews it: whether an operator approved it, whether the tenant still claims it
// (false: an approved domain its console or record no longer lists, kept so it can be revoked), which other tenants
// claim it too, and where it stands (state). verified: its DNS TXT record was last seen; lastCheckedAt: when it was last
// looked up. recordName / recordValue: the TXT record the tenant publishes to prove it controls the domain (the token in
// it is public by design).
export type EmailDomainApprovalDto =
{
    domain: string
    approved: boolean
    claimed: boolean
    sharedWith: string[]
    state: DomainApprovalState
    verified: boolean
    lastCheckedAt?: string
    recordName?: string
    recordValue?: string
}

// A tenant's email domains as the operator sees them (the email-domains route's reply). editable: false for an
// in-hive tenant, whose Owner sets them in its console. sharedWith: sorted ids of the other tenants claiming any of
// these domains. approvals: every tenant, one entry per claimed domain in domains order, then each approved domain no
// longer claimed; a domain takes effect in sign-in discovery while it is claimed and either operator-approved or
// verified by its DNS TXT record with no other tenant claiming it (an operator's revoke beats a verification).
export type TenantEmailDomainsDto =
{
    tenantId: string
    domains: string[]
    source: EmailDomainSource
    editable: boolean
    reportedAt?: string
    sharedWith: string[]
    approvals: EmailDomainApprovalDto[]
}

// A fresh Owner password in the hive's in-hive identity provider, shown once.
export type InHiveOwnerPasswordDto = { ownerEmail: string; ownerPassword: string }

// A hive delete's reply: what was deliberately kept in the cluster (the tenant-admin data volume and its seed
// Secret), and what a delete anyway may have left behind.
export type HiveDeleteOutcomeDto = { ok: boolean; retained: string[]; notice?: string }

// A console removal's reply: the updated hive and what stays in the cluster (the console's and its identity provider's
// data and Secrets, and the environment namespaces the console created, which keep running). notice: the removal
// succeeded but what it kept could not be listed (retained is then empty).
export type ConsoleRemovalDto = { hive: HiveDto; retained: string[]; notice?: string }

// A freshly minted one-time agent token (the rollout-registration route's reply).
export type RolloutRegistrationDto = { token: string }
