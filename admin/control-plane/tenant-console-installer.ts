import { randomBytes } from 'node:crypto'
import type { ConsoleFingerprintKeys } from './console-fingerprint-keys.js'
import { ConsoleRetention } from './console-retention.js'
import { DevCaHostOutsideDomainError, DevCaKeyMissingError, type IDevCertificateIssuer, type IssuedCertificate } from './dev-certificate-authority.js'
import { EffectiveRegistry } from './effective-registry.js'
import { SystemInstallClock, type IInstallClock, type IInstallOrchestratorSource } from './hive-agent-installer.js'
import { HiveConsoleSpecs, InvalidHiveConsoleError, type HiveConsoleSpec } from './hive-console-spec.js'
import { IdpAdminError, IdpAdminTransportError } from './idp-admin-client.js'
import { ImageVerificationError, type IImageVerifier } from './image-verifier.js'
import { InClusterIdpSeedSource } from './in-cluster-idp-seed.js'
import { InHiveIdpUnavailableError, type IInHiveIdpAdmin, type InHiveOwnerPassword } from './in-hive-idp-admin.js'
import { IngressTlsPolicy, IngressTlsSource } from './ingress-tls.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { IKeyStore } from './key-store.js'
import { KubectlError, PortForwardError, type IKubectl } from './kubectl.js'
import type { VerifiedImage } from './pinned-image-verifier.js'
import type { PlatformImageSigner } from './platform-signing-key.js'
import { UnknownTenantError } from './platform-directory.js'
import { HiveBackend, type HiveRecord, type TenantRecord } from './platform-records.js'
import { UnknownHiveError } from './rollout-errors.js'
import { TenantAdminBootstrap } from './tenant-admin-bootstrap.js'
import { TenantConsoleAdmission } from './tenant-console-admission.js'
import { OwnerAccountMissingError, OwnerIdpRefusedError, OwnerNotRecordedError, IdpUnreachableError } from './tenant-provisioning-service.js'

/** Where a console install stands. Values are the wire strings. */
export enum ConsoleInstallState
{
    Installing = 'installing',
    Deployed = 'deployed',
    Failed = 'failed',
}

/** The console install's steps, in the order they run. Values are the wire strings. */
export enum ConsoleInstallStep
{
    CheckingAgent = 'checking-agent',
    PreparingCertificates = 'preparing-certificates',
    ApplyingConsole = 'applying-console',
    StoringSecrets = 'storing-secrets',
    WaitingForRollout = 'waiting-for-rollout',
    SeedingOwner = 'seeding-owner',
}

/** A console install's state as the operator sees it. Never carries a secret. */
export type ConsoleInstallStatus = {
    state: ConsoleInstallState
    step: ConsoleInstallStep
    startedAt: string
    finishedAt?: string
    error?: string
    consoleUrl?: string
    devCaFile?: string
}

/** The hive has no console settings yet. Maps to 409. */
export class ConsoleNotConfiguredError extends Error
{
    private static readonly ErrorName = 'ConsoleNotConfiguredError'
    private static readonly Text = 'This hive has no console settings. Set where the console is served first.'

    public constructor()
    {
        super(ConsoleNotConfiguredError.Text)
        this.name = ConsoleNotConfiguredError.ErrorName
    }
}

/** A console install cannot run for this hive (not Local, the agent channel is off, or the id is unsafe). Maps to 409. */
export class ConsoleInstallUnavailableError extends Error
{
    private static readonly ErrorName = 'ConsoleInstallUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = ConsoleInstallUnavailableError.ErrorName
    }
}

/** A console install is already running for the hive. Maps to 409. */
export class ConsoleInstallInProgressError extends Error
{
    private static readonly ErrorName = 'ConsoleInstallInProgressError'
    private static readonly MessagePrefix = 'A console install is already running for hive '

    public constructor(hiveId: string)
    {
        super(ConsoleInstallInProgressError.MessagePrefix + hiveId)
        this.name = ConsoleInstallInProgressError.ErrorName
    }
}

/** A step's own plain-sentence failure (agent missing, TLS Secret unusable, no trust root, hive deleted). */
class ConsoleInstallStepError extends Error
{
    private static readonly ErrorName = 'ConsoleInstallStepError'

    public constructor(message: string)
    {
        super(message)
        this.name = ConsoleInstallStepError.ErrorName
    }
}

/** Finds the hive and its tenant; satisfied by PlatformDirectory. */
export interface IConsoleDirectory
{
    GetHive(id: string): HiveRecord | undefined
    GetTenant(id: string): TenantRecord | undefined
}

/** Approves the console image for a hive: the ref the hive pulls, verified against its trust root. */
export interface IConsoleImageApproval
{
    Approve(hive: HiveRecord, baseImage: string): Promise<VerifiedImage>
}

/**
 * Signs the image for a hive that trusts the platform key (as InClusterEnvironmentRuntime does for server images), then verifies it
 * fail-closed against the hive's trust root. The approved entry is the pulled ref only (a plain allow-list; no digest).
 */
export class PlatformConsoleImageApproval implements IConsoleImageApproval
{
    public constructor(private readonly signer: PlatformImageSigner | undefined, private readonly verifier: IImageVerifier)
    {
    }

    public async Approve(hive: HiveRecord, baseImage: string): Promise<VerifiedImage>
    {
        const imageRef = EffectiveRegistry.For(hive).ImageRef(baseImage)
        if (this.signer !== undefined && this.signer.SignsFor(hive))
        {
            await this.signer.Sign(imageRef)
        }
        await this.verifier.Verify(imageRef, hive.trustRootRef)
        return { imageRef }
    }
}

/** The IdP's CA + admin token for the bootstrap, and the seed Secrets to apply (undefined when the running IdP's are reused). */
type IdpMaterial = { ca: Buffer; adminToken: string; secretsManifest: string | undefined; scrub: string[] }

/** One install's mutable state; the installer hands out copies only. */
class ConsoleInstallRun
{
    public state = ConsoleInstallState.Installing
    public step = ConsoleInstallStep.CheckingAgent
    public finishedAt: string | undefined
    public error: string | undefined
    public consoleUrl: string | undefined
    public devCaFile: string | undefined
    public settled: Promise<void> = Promise.resolve()
    /** Secret values seen by this run, scrubbed from any failure text. Dropped once the run settles. */
    public readonly secrets: string[] = []

    public constructor(public readonly hiveId: string, public readonly startedAt: string)
    {
    }

    public Snapshot(): ConsoleInstallStatus
    {
        const status: ConsoleInstallStatus = { state: this.state, step: this.step, startedAt: this.startedAt }
        if (this.finishedAt !== undefined)
        {
            status.finishedAt = this.finishedAt
        }
        if (this.error !== undefined)
        {
            status.error = this.error
        }
        if (this.consoleUrl !== undefined)
        {
            status.consoleUrl = this.consoleUrl
        }
        if (this.devCaFile !== undefined)
        {
            status.devCaFile = this.devCaFile
        }
        return status
    }
}

/**
 * Installs a hive's tenant console (and its in-hive IdP) from the control plane, in the background, on a Local hive whose agent
 * already runs: check the agent's token Secret, prepare the console's TLS (development leaf, existing Secret, or cert-manager),
 * approve the image, render the bootstrap (agent token reused, master key / fingerprint key / IdP credentials kept across
 * reinstalls), apply it, store its Secrets server-side, restart and wait for the IdP and console, then seed the Owner account.
 * One install per hive at a time; the latest status is kept in memory only. No secret value leaves this class except on
 * kubectl's stdin and into the sealed store: not in arguments, logs, errors or status.
 */
export class TenantConsoleInstaller
{
    public static readonly ConsolePort = 7100
    public static readonly IdpPort = 9443

    private static readonly NotLocalMessage = 'The console cannot be installed in this hive from here: the control plane does not manage its cluster.'
    private static readonly ChannelOffMessage = 'The console cannot be installed: the agent channel is not configured (start the control plane with PRAGMATIC_AGENT_CHANNEL_PORT).'
    private static readonly UnsafeIdMessage = "The console cannot be installed in this hive: its id is not a valid Kubernetes label value. Recreate the hive with a lowercase id (a-z, 0-9, '-')."
    private static readonly AgentMissingMessage = 'Install the agent first: the console uses the hive agent token.'
    private static readonly AdmissionUnservedMessage = "This cluster does not serve ValidatingAdmissionPolicy (admissionregistration.k8s.io/v1), so the console's admission fence cannot be applied. The console needs Kubernetes 1.30 or newer."
    private static readonly NoTrustRootMessage = 'This hive has no trust root, so the console image cannot be verified. Give the hive a trust root first.'
    private static readonly TlsSecretPrefix = 'The TLS Secret '
    private static readonly TlsSecretSuffix = ' was not found in pragmatic-system, or is not a kubernetes.io/tls Secret.'
    private static readonly HiveGoneMessage = 'The install stopped: the hive was deleted while it ran.'
    private static readonly StepFailureMessages: Readonly<Record<ConsoleInstallStep, string>> = {
        [ConsoleInstallStep.CheckingAgent]: 'Could not check the hive agent.',
        [ConsoleInstallStep.PreparingCertificates]: "Could not prepare the console's certificates and settings.",
        [ConsoleInstallStep.ApplyingConsole]: 'Could not apply the console to the cluster.',
        [ConsoleInstallStep.StoringSecrets]: "Could not store the console's Secrets in the cluster.",
        [ConsoleInstallStep.WaitingForRollout]: 'The identity provider or the console did not roll out.',
        [ConsoleInstallStep.SeedingOwner]: "Could not seed the tenant's Owner in the in-hive identity provider.",
    }
    /** Errors whose message is a safe plain sentence (or names only a resource) and helps the operator; others add nothing. */
    private static readonly ShowableErrors: ReadonlyArray<abstract new (...args: never[]) => Error> = [
        KubectlError, PortForwardError, IdpAdminError, IdpAdminTransportError, InHiveIdpUnavailableError, OwnerNotRecordedError,
        OwnerAccountMissingError, OwnerIdpRefusedError, IdpUnreachableError, ImageVerificationError, DevCaKeyMissingError,
        DevCaHostOutsideDomainError, InvalidHiveConsoleError,
    ]
    private static readonly HttpsScheme = 'https'
    private static readonly HttpsPrefix = 'https://'
    private static readonly WildcardPrefix = '*.'
    private static readonly Dot = '.'
    private static readonly SecretPrefix = 'secret/'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly IngressPrefix = 'ingress/'
    private static readonly DetailSeparator = ' '
    private static readonly Redacted = '[REDACTED]'
    private static readonly LogPrefix = '[console-install] hive '
    private static readonly LogStepInfix = ' failed at '
    private static readonly LogErrorInfix = ': '
    private static readonly UnknownErrorName = 'Error'
    private static readonly Base64 = 'base64'
    private static readonly Hex = 'hex'
    private static readonly Utf8 = 'utf8'
    private static readonly TlsCertKey = 'tls.crt'
    private static readonly TlsKeyKey = 'tls.key'
    private static readonly IdpCaKey = 'ca.crt'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly TypeKey = 'type'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly LabelsKey = 'labels'
    private static readonly DataKey = 'data'
    private static readonly ItemsKey = 'items'
    private static readonly ApiVersionCore = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly ListKind = 'List'
    private static readonly MasterKeyBytes = 32
    private static readonly IdpServerKeyKey = 'server.key'
    private static readonly SecretResource = 'secret'
    private static readonly TlsCopyLabel = 'pragmatic/tls-copy'
    private static readonly TlsCopyValue = 'true'
    private static readonly SelectorSeparator = ','
    private static readonly LabelAssign = '='
    private static readonly PartialIdpPrefix = 'The identity provider Secret '
    private static readonly PartialIdpInfix = ' is missing from '
    private static readonly PartialIdpWhile = ' while '
    private static readonly PartialIdpSuffix = ' exists. Restore it, or delete both to give the identity provider a new certificate (every environment then needs its identity provider CA re-applied).'

    private readonly runs = new Map<string, ConsoleInstallRun>()
    private readonly manifests = new K8sManifestBuilder()

    public constructor(
        private readonly directory: IConsoleDirectory,
        private readonly orchestrators: IInstallOrchestratorSource,
        private readonly bootstrap: TenantAdminBootstrap,
        private readonly fingerprints: ConsoleFingerprintKeys,
        private readonly devCa: IDevCertificateIssuer,
        private readonly idpAdmin: IInHiveIdpAdmin,
        private readonly images: IConsoleImageApproval,
        private readonly trustRoots: IKeyStore,
        private readonly agentChannelUrl: string | undefined,
        private readonly clock: IInstallClock = new SystemInstallClock())
    {
    }

    /** Whether the control plane can install (and remove) this hive's console: a Local hive with a safe id, and the agent channel on. */
    public Supports(hive: HiveRecord): boolean
    {
        return hive.cluster.backend === HiveBackend.Local && this.agentChannelUrl !== undefined && K8sManifestBuilder.IsValidHiveId(hive.id)
    }

    /**
     * Whether the control plane can remove this hive's console: a Local hive with a safe id. Unlike Supports, the agent channel does
     * not matter (removal never talks to the agent), so turning the channel off never strands a console in the cluster.
     */
    public CanUninstall(hive: HiveRecord): boolean
    {
        return hive.cluster.backend === HiveBackend.Local && K8sManifestBuilder.IsValidHiveId(hive.id)
    }

    /** Begins an install in the background and returns its first status. Throws for an unknown, unconfigured, unsupported or busy hive. */
    public Start(hiveId: string): ConsoleInstallStatus
    {
        const hive = this.directory.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        const spec = hive.console
        if (spec === undefined)
        {
            throw new ConsoleNotConfiguredError()
        }
        if (hive.cluster.backend !== HiveBackend.Local)
        {
            throw new ConsoleInstallUnavailableError(TenantConsoleInstaller.NotLocalMessage)
        }
        if (!K8sManifestBuilder.IsValidHiveId(hive.id))
        {
            throw new ConsoleInstallUnavailableError(TenantConsoleInstaller.UnsafeIdMessage)
        }
        const channelUrl = this.agentChannelUrl
        if (channelUrl === undefined)
        {
            throw new ConsoleInstallUnavailableError(TenantConsoleInstaller.ChannelOffMessage)
        }
        if (this.IsInstalling(hiveId))
        {
            throw new ConsoleInstallInProgressError(hiveId)
        }
        const tenant = this.directory.GetTenant(hive.tenantId)
        if (tenant === undefined)
        {
            throw new UnknownTenantError(hive.tenantId)
        }
        const run = new ConsoleInstallRun(hiveId, new Date(this.clock.Now()).toISOString())
        this.runs.set(hiveId, run)
        run.settled = this.Run(run, hive, tenant, spec, channelUrl)
        return run.Snapshot()
    }

    /** The latest install's status for the hive; undefined when none has run since the control plane started. */
    public StatusFor(hiveId: string): ConsoleInstallStatus | undefined
    {
        return this.runs.get(hiveId)?.Snapshot()
    }

    public IsInstalling(hiveId: string): boolean
    {
        return this.runs.get(hiveId)?.state === ConsoleInstallState.Installing
    }

    /** Resolves once the hive's latest install has settled, with its final status. For tests and tooling. */
    public async WhenSettled(hiveId: string): Promise<ConsoleInstallStatus | undefined>
    {
        const run = this.runs.get(hiveId)
        if (run === undefined)
        {
            return undefined
        }
        await run.settled
        return run.Snapshot()
    }

    /**
     * Deletes TenantConsoleRemovalManifest objects (the console, its grants and the in-hive IdP's serving objects) and this hive's TLS
     * key copies in the IdP namespace, then returns what it kept that exists: the console's and the IdP's data and Secrets
     * (ConsoleRetention) and the environment namespaces the console created, which keep running unmanaged until a reinstall adopts
     * them (or the hive delete removes them). Leaves a console another hive owns (its Deployment carries another hive's label)
     * untouched and returns nothing. A KubectlError propagates.
     */
    public async Uninstall(hive: HiveRecord): Promise<string[]>
    {
        const C = TenantConsoleInstaller
        const kubectl = this.orchestrators.For(hive).Kubectl
        const deployment = await kubectl.Find(K8sManifestBuilder.SystemNamespace, C.DeploymentPrefix + K8sManifestBuilder.TenantAdminNameOf(hive.tenantId))
        if (deployment !== undefined && K8sManifestBuilder.HiveOf(JSON.parse(deployment)) !== hive.id)
        {
            return []
        }
        await kubectl.DeleteManifest(this.manifests.TenantConsoleRemovalManifest(hive.tenantId, hive.id, await TenantConsoleAdmission.ServedBy(kubectl)))
        // The IdP Ingress is gone, so the private-key copies it served are swept too.
        await kubectl.DeleteBySelector(K8sManifestBuilder.IdpNameOf(hive.tenantId), C.SecretResource, C.TlsCopySelectorOf(hive.id))
        const kept = await ConsoleRetention.ExistingOf(kubectl, hive.tenantId)
        const environments = await kubectl.ListNamespacesBySelector(K8sManifestBuilder.HiveLabelSelectorOf(hive.id), K8sManifestBuilder.EnvNamespacePrefix)
        return [...kept, ...environments]
    }

    /**
     * On hive delete: drops the hive's fingerprint key and, when it is the tenant's console hive, the in-hive IdP credentials. Those
     * are keyed by tenant: deleting another hive of the same tenant must not strand the console hive's IdP.
     */
    public async Forget(hive: HiveRecord): Promise<void>
    {
        await this.fingerprints.Remove(hive.id)
        await this.ForgetConsoleCredentials(hive)
    }

    /** On console removal (and console-hive delete): drops the tenant's in-hive IdP credentials; a hive without a console has none. */
    public async ForgetConsoleCredentials(hive: HiveRecord): Promise<void>
    {
        if (hive.console !== undefined)
        {
            await this.idpAdmin.Forget(hive.tenantId)
        }
    }

    /** Sets a fresh in-hive Owner password and returns it once. Refused while an install runs or before the console is configured. */
    public async ResetOwnerPassword(hiveId: string): Promise<InHiveOwnerPassword>
    {
        const hive = this.directory.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        if (hive.console === undefined)
        {
            throw new ConsoleNotConfiguredError()
        }
        if (this.IsInstalling(hiveId))
        {
            throw new ConsoleInstallInProgressError(hiveId)
        }
        const tenant = this.directory.GetTenant(hive.tenantId)
        if (tenant === undefined)
        {
            throw new UnknownTenantError(hive.tenantId)
        }
        return this.idpAdmin.ResetOwnerPassword(hive, tenant)
    }

    /** Runs the steps; never rejects: a failure is recorded on the run. */
    private async Run(run: ConsoleInstallRun, hive: HiveRecord, tenant: TenantRecord, spec: HiveConsoleSpec, channelUrl: string): Promise<void>
    {
        // Yield first, so Start returns before any step runs.
        await Promise.resolve()
        const C = TenantConsoleInstaller
        const t = tenant.id
        const system = K8sManifestBuilder.SystemNamespace
        const idpName = K8sManifestBuilder.IdpNameOf(t)
        try
        {
            const kubectl = this.orchestrators.For(hive).Kubectl
            const host = HiveConsoleSpecs.HostOf(spec, t)
            this.Enter(run, ConsoleInstallStep.CheckingAgent)
            if (await kubectl.Find(system, C.SecretPrefix + K8sManifestBuilder.AgentTokenSecretNameOf(hive.id)) === undefined)
            {
                throw new ConsoleInstallStepError(C.AgentMissingMessage)
            }
            // Without the admission fence the console's cluster-wide grants would be unfenced: refuse the cluster before any apply.
            if (!await TenantConsoleAdmission.ServedBy(kubectl))
            {
                throw new ConsoleInstallStepError(C.AdmissionUnservedMessage)
            }
            this.Enter(run, ConsoleInstallStep.PreparingCertificates)
            const trustRootRef = hive.trustRootRef
            if (trustRootRef === undefined || trustRootRef.length === 0)
            {
                throw new ConsoleInstallStepError(C.NoTrustRootMessage)
            }
            // A legacy record may predate today's console rules (e.g. a TLS Secret named like the IdP's own): refuse it here too.
            HiveConsoleSpecs.Validate(spec, t)
            const tlsCopy = await this.TlsMaterial(run, kubectl, spec, t, host)
            const approved = await this.images.Approve(hive, K8sManifestBuilder.AgentImage)
            const fingerprintKey = await this.fingerprints.Ensure(hive.id)
            C.Remember(run, fingerprintKey)
            // Minted here on a first install (not inside the bootstrap), so it is in the scrub list either way.
            const masterKey = await C.ExistingMasterKey(kubectl, t) ?? randomBytes(C.MasterKeyBytes)
            C.Remember(run, masterKey)
            const idp = await this.IdpMaterialOf(kubectl, t, spec.baseDomain)
            run.secrets.push(idp.adminToken, ...idp.scrub)
            // Read before the Apply rewrites it: the copy the IdP Ingress served until now (installs before copies were labelled).
            const legacyCopies = C.LegacyTlsCopies(await kubectl.Find(idpName, C.IngressPrefix + idpName), spec, t)
            const bootstrap = await this.bootstrap.GenerateBootstrap({
                tenant,
                hive,
                tenantAdminImage: K8sManifestBuilder.AgentImage,
                tenantPlanePort: C.ConsolePort,
                baseDomain: spec.baseDomain,
                externalScheme: C.HttpsScheme,
                channelUrl,
                reuseAgentToken: true,
                console: { host, ingressTls: spec.tls },
                fingerprintKey,
                masterKey,
                verifiedImages: [approved],
                idp: {
                    image: K8sManifestBuilder.AgentImage,
                    port: C.IdpPort,
                    tlsSecretName: InClusterIdpSeedSource.TlsSecretNameOf(t),
                    adminTokenSecretName: InClusterIdpSeedSource.AdminSecretNameOf(t),
                    adminTokenRef: InClusterIdpSeedSource.AdminTokenKey,
                    ca: idp.ca,
                    adminToken: idp.adminToken,
                    ingressTls: spec.tls,
                },
                trustRootPublicKey: await this.trustRoots.PublicKey(trustRootRef),
            })
            this.Enter(run, ConsoleInstallStep.ApplyingConsole)
            const stale = this.StaleTlsObjects(spec, t, hive.id)
            if (stale !== undefined)
            {
                await kubectl.DeleteManifest(stale)
            }
            await kubectl.Apply(bootstrap.manifest)
            this.Enter(run, ConsoleInstallStep.StoringSecrets)
            await kubectl.ApplyServerSide(bootstrap.secrets.RenderManifest())
            if (idp.secretsManifest !== undefined)
            {
                await kubectl.ApplyServerSide(idp.secretsManifest)
            }
            // Earlier TLS copies in the IdP namespace (another source, another existing-secret name) hold a private key nothing
            // references any more; the current copy is re-applied right below.
            await kubectl.DeleteBySelector(idpName, C.SecretResource, C.TlsCopySelectorOf(hive.id))
            if (legacyCopies.length > 0)
            {
                await kubectl.DeleteManifest(C.SecretIdentities(idpName, legacyCopies))
            }
            if (spec.tls.source === IngressTlsSource.Development && tlsCopy !== undefined)
            {
                await kubectl.ApplyServerSide(C.TlsSecretManifest(K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf(t), system, tlsCopy, hive.id))
                await kubectl.ApplyServerSide(C.TlsSecretManifest(IngressTlsPolicy.DevelopmentSecretName, idpName, tlsCopy, hive.id))
            }
            else if (spec.tls.source === IngressTlsSource.ExistingSecret && tlsCopy !== undefined)
            {
                await kubectl.ApplyServerSide(C.TlsSecretManifest(spec.tls.secretName as string, idpName, tlsCopy, hive.id))
            }
            await this.idpAdmin.Remember(t, idp.ca, idp.adminToken)
            // A reinstall must pick up the new Secrets: both Deployments restart.
            await kubectl.RolloutRestart(idpName, idpName)
            await kubectl.RolloutRestart(system, K8sManifestBuilder.TenantAdminNameOf(t))
            this.Enter(run, ConsoleInstallStep.WaitingForRollout)
            await kubectl.RolloutStatus(idpName, idpName)
            await kubectl.RolloutStatus(system, K8sManifestBuilder.TenantAdminNameOf(t))
            this.Enter(run, ConsoleInstallStep.SeedingOwner)
            await this.idpAdmin.SeedOwner(hive, tenant)
            run.state = ConsoleInstallState.Deployed
            run.consoleUrl = C.HttpsPrefix + host
            if (spec.tls.source === IngressTlsSource.Development)
            {
                run.devCaFile = this.devCa.CaFileOf(spec.baseDomain)
            }
            run.finishedAt = new Date(this.clock.Now()).toISOString()
        }
        catch (err)
        {
            this.Fail(run, err)
        }
        finally
        {
            run.secrets.splice(0)
        }
    }

    /**
     * The certificate to copy into pragmatic-system / the IdP namespace: development issues a leaf for the wildcard, the base domain
     * and the exact console and IdP hosts (a host deeper than one label under the base domain is not covered by the wildcard);
     * existing-secret reads the operator's Secret (which must be a kubernetes.io/tls Secret with both keys); cert-manager needs none.
     */
    private async TlsMaterial(run: ConsoleInstallRun, kubectl: IKubectl, spec: HiveConsoleSpec, tenantId: string, host: string): Promise<IssuedCertificate | undefined>
    {
        const C = TenantConsoleInstaller
        switch (spec.tls.source)
        {
            case IngressTlsSource.Development:
            {
                const bd = spec.baseDomain
                const hosts = [C.WildcardPrefix + bd, bd]
                for (const exact of [host, K8sManifestBuilder.IdpBrowserHostOf(tenantId, bd)])
                {
                    if (!C.CoveredBy(exact, bd) && !hosts.includes(exact))
                    {
                        hosts.push(exact)
                    }
                }
                const issued = await this.devCa.Issue(bd, hosts)
                C.RememberTlsKey(run, issued)
                return issued
            }
            case IngressTlsSource.ExistingSecret:
            {
                const name = spec.tls.secretName as string
                const issued = C.TlsSecretOf(await kubectl.Find(K8sManifestBuilder.SystemNamespace, C.SecretPrefix + name))
                if (issued === undefined)
                {
                    throw new ConsoleInstallStepError(C.TlsSecretPrefix + name + C.TlsSecretSuffix)
                }
                C.RememberTlsKey(run, issued)
                return issued
            }
            default:
                return undefined
        }
    }

    /** Whether the base domain's wildcard covers `host` (exactly one label under it). */
    private static CoveredBy(host: string, baseDomain: string): boolean
    {
        const suffix = TenantConsoleInstaller.Dot + baseDomain
        return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(TenantConsoleInstaller.Dot)
    }

    /** The cert + key of a kubernetes.io/tls Secret (as kubectl returns it), or undefined when absent, of another type or incomplete. */
    private static TlsSecretOf(json: string | undefined): IssuedCertificate | undefined
    {
        const C = TenantConsoleInstaller
        if (json === undefined)
        {
            return undefined
        }
        const doc = JSON.parse(json) as { type?: unknown; data?: Record<string, unknown> }
        const cert = doc.data?.[C.TlsCertKey]
        const key = doc.data?.[C.TlsKeyKey]
        if (doc.type !== IngressTlsPolicy.TlsSecretType || typeof cert !== 'string' || typeof key !== 'string' || cert.length === 0 || key.length === 0)
        {
            return undefined
        }
        return { cert: Buffer.from(cert, C.Base64), key: Buffer.from(key, C.Base64) }
    }

    /** The master key of the console's existing seed Secret (a reinstall keeps the data PVC readable), or undefined on a first install. */
    private static async ExistingMasterKey(kubectl: IKubectl, tenantId: string): Promise<Buffer | undefined>
    {
        const C = TenantConsoleInstaller
        const json = await kubectl.Find(K8sManifestBuilder.SystemNamespace, C.SecretPrefix + K8sManifestBuilder.TenantAdminSeedSecretNameOf(tenantId))
        const value = C.DataOf(json, TenantAdminBootstrap.MasterKeyKey)
        return value === undefined ? undefined : Buffer.from(value, C.Base64)
    }

    /**
     * The running IdP's CA and admin token when both its Secrets exist (a reinstall must not rotate them: every environment's IdP CA
     * copy and the console's admin client depend on them; the caller refreshes the sealed copy from what is read here); freshly minted
     * material plus the Secrets to apply (one server-side apply of both, so a half pair is unlikely) when neither exists. Exactly one
     * present: after a completed install (its credentials are sealed) environments may already trust that CA, so minting would silently
     * rotate it and the install fails with a sentence naming the missing Secret; with nothing sealed it is the leftover of a first install
     * that never completed, so it is deleted and the IdP minted fresh.
     */
    private async IdpMaterialOf(kubectl: IKubectl, tenantId: string, baseDomain: string): Promise<IdpMaterial>
    {
        const C = TenantConsoleInstaller
        const ns = K8sManifestBuilder.IdpNameOf(tenantId)
        const tlsName = InClusterIdpSeedSource.TlsSecretNameOf(tenantId)
        const adminName = InClusterIdpSeedSource.AdminSecretNameOf(tenantId)
        const ca = C.DataOf(await kubectl.Find(ns, C.SecretPrefix + tlsName), C.IdpCaKey)
        const token = C.DataOf(await kubectl.Find(ns, C.SecretPrefix + adminName), InClusterIdpSeedSource.AdminTokenKey)
        if (ca !== undefined && token !== undefined)
        {
            return { ca: Buffer.from(ca, C.Base64), adminToken: Buffer.from(token, C.Base64).toString(C.Utf8), secretsManifest: undefined, scrub: [] }
        }
        if (ca !== undefined || token !== undefined)
        {
            const [missing, present] = ca === undefined ? [tlsName, adminName] : [adminName, tlsName]
            if (await this.idpAdmin.Holds(tenantId))
            {
                throw new ConsoleInstallStepError(C.PartialIdpPrefix + missing + C.PartialIdpInfix + ns + C.PartialIdpWhile + present + C.PartialIdpSuffix)
            }
            await kubectl.DeleteManifest(C.SecretIdentities(ns, [present]))
        }
        const seeds = new InClusterIdpSeedSource(undefined, baseDomain)
        const seed = seeds.SeedFor(tenantId)
        const manifest = seeds.SecretsManifestFor(tenantId)
        return { ca: seed.ca, adminToken: seed.adminToken, secretsManifest: manifest, scrub: C.ServerKeyFormsOf(manifest) }
    }

    /** The freshly minted IdP server key's printable forms (base64 as the Secret carries it, and the PEM text), for scrubbing. */
    private static ServerKeyFormsOf(manifest: string): string[]
    {
        const C = TenantConsoleInstaller
        const items = (JSON.parse(manifest) as { items?: Array<{ data?: Record<string, string> }> }).items ?? []
        return items.flatMap(i =>
        {
            const key = i.data?.[C.IdpServerKeyKey]
            return key === undefined ? [] : [key, Buffer.from(key, C.Base64).toString(C.Utf8).trim()]
        })
    }

    /**
     * Unlabelled TLS copies in the IdP namespace an install from before copies were labelled may have left: the Secret the IdP Ingress
     * named until now and, unless the new source is development, pragmatic-dev-tls. Never the copy the new choice uses, and never the
     * IdP's own TLS or admin Secrets.
     */
    private static LegacyTlsCopies(ingressJson: string | undefined, spec: HiveConsoleSpec, tenantId: string): string[]
    {
        const idpName = K8sManifestBuilder.IdpNameOf(tenantId)
        const names = new Set<string>()
        if (ingressJson !== undefined)
        {
            const tls = (JSON.parse(ingressJson) as { spec?: { tls?: Array<{ secretName?: unknown }> } }).spec?.tls ?? []
            for (const entry of tls)
            {
                if (typeof entry.secretName === 'string' && entry.secretName.length > 0)
                {
                    names.add(entry.secretName)
                }
            }
        }
        if (spec.tls.source !== IngressTlsSource.Development)
        {
            names.add(IngressTlsPolicy.DevelopmentSecretName)
        }
        for (const kept of [IngressTlsPolicy.SecretNameFor(spec.tls, idpName), InClusterIdpSeedSource.TlsSecretNameOf(tenantId), InClusterIdpSeedSource.AdminSecretNameOf(tenantId)])
        {
            names.delete(kept)
        }
        return [...names]
    }

    /** A v1 List of Secret identities (name + namespace only) to delete by name; absent ones are tolerated. */
    private static SecretIdentities(namespace: string, names: readonly string[]): string
    {
        const C = TenantConsoleInstaller
        const items = names.map(name => ({ [C.ApiVersionKey]: C.ApiVersionCore, [C.KindKey]: C.SecretKind, [C.MetadataKey]: { [C.NameKey]: name, [C.NamespaceKey]: namespace } }))
        return JSON.stringify({ [C.ApiVersionKey]: C.ApiVersionCore, [C.KindKey]: C.ListKind, [C.ItemsKey]: items })
    }

    /** Selects this hive's TLS key copies (in the IdP namespace: the ones a TLS-source switch leaves behind). */
    private static TlsCopySelectorOf(hiveId: string): string
    {
        const C = TenantConsoleInstaller
        return K8sManifestBuilder.HiveLabelSelectorOf(hiveId) + C.SelectorSeparator + C.TlsCopyLabel + C.LabelAssign + C.TlsCopyValue
    }

    /** A non-empty base64 `data` entry of a Secret's JSON, or undefined. */
    private static DataOf(json: string | undefined, key: string): string | undefined
    {
        if (json === undefined)
        {
            return undefined
        }
        const value = (JSON.parse(json) as { data?: Record<string, unknown> }).data?.[key]
        return typeof value === 'string' && value.length > 0 ? value : undefined
    }

    /**
     * Objects an earlier install with another TLS source may have left that this one does not render: the TLS-read Role and RoleBinding
     * (cert-manager copies no Secret) and this tenant's development TLS copy (any non-development source). Undefined when none.
     */
    private StaleTlsObjects(spec: HiveConsoleSpec, tenantId: string, hiveId: string): string | undefined
    {
        const C = TenantConsoleInstaller
        const names = new Set<string>()
        if (spec.tls.source !== IngressTlsSource.Development)
        {
            names.add(K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf(tenantId))
        }
        if (!IngressTlsPolicy.CopiesSecret(spec.tls))
        {
            names.add(K8sManifestBuilder.TenantConsoleTlsRoleNameOf(tenantId))
        }
        const removal = JSON.parse(this.manifests.TenantConsoleRemovalManifest(tenantId, hiveId)) as { items: Array<{ metadata: { name: string } }> }
        const items = removal.items.filter(i => names.has(i.metadata.name))
        return items.length === 0 ? undefined : JSON.stringify({ [C.ApiVersionKey]: C.ApiVersionCore, [C.KindKey]: C.ListKind, [C.ItemsKey]: items })
    }

    /**
     * A hive-labelled kubernetes.io/tls Secret manifest, also labelled as a TLS copy (so a later TLS-source switch can sweep it); applied
     * server-side through kubectl's stdin, never written anywhere else.
     */
    private static TlsSecretManifest(name: string, namespace: string, tls: IssuedCertificate, hiveId: string): string
    {
        const C = TenantConsoleInstaller
        const labels = { ...K8sManifestBuilder.HiveLabelsOf(hiveId), [C.TlsCopyLabel]: C.TlsCopyValue }
        return JSON.stringify({
            [C.ApiVersionKey]: C.ApiVersionCore,
            [C.KindKey]: C.SecretKind,
            [C.TypeKey]: IngressTlsPolicy.TlsSecretType,
            [C.MetadataKey]: { [C.NameKey]: name, [C.NamespaceKey]: namespace, [C.LabelsKey]: labels },
            [C.DataKey]: { [C.TlsCertKey]: tls.cert.toString(C.Base64), [C.TlsKeyKey]: tls.key.toString(C.Base64) },
        })
    }

    /** Records a key's printable forms (base64 and hex) for scrubbing. */
    private static Remember(run: ConsoleInstallRun, key: Buffer): void
    {
        run.secrets.push(key.toString(TenantConsoleInstaller.Base64), key.toString(TenantConsoleInstaller.Hex))
    }

    /** Records a TLS private key's printable forms (PEM text and the base64 a Secret carries) for scrubbing. */
    private static RememberTlsKey(run: ConsoleInstallRun, tls: IssuedCertificate): void
    {
        run.secrets.push(tls.key.toString(TenantConsoleInstaller.Utf8), tls.key.toString(TenantConsoleInstaller.Base64))
    }

    /** Moves the run to its next step; stops it (throws) when the hive was deleted meanwhile. */
    private Enter(run: ConsoleInstallRun, step: ConsoleInstallStep): void
    {
        run.step = step
        if (this.directory.GetHive(run.hiveId) === undefined)
        {
            throw new ConsoleInstallStepError(TenantConsoleInstaller.HiveGoneMessage)
        }
    }

    /** Records a failed step: the fixed step message (or the step's own sentence), plus a showable error's text, every secret scrubbed. */
    private Fail(run: ConsoleInstallRun, err: unknown): void
    {
        const C = TenantConsoleInstaller
        let message = err instanceof ConsoleInstallStepError ? err.message : C.StepFailureMessages[run.step]
        if (C.ShowableErrors.some(ctor => err instanceof ctor))
        {
            message += C.DetailSeparator + (err as Error).message
        }
        for (const secret of run.secrets)
        {
            if (secret.length > 0)
            {
                message = message.split(secret).join(C.Redacted)
            }
        }
        run.state = ConsoleInstallState.Failed
        run.error = message
        run.finishedAt = new Date(this.clock.Now()).toISOString()
        // The error's name only: a raw message may carry cluster output.
        const name = err instanceof Error ? err.name : C.UnknownErrorName
        console.error(C.LogPrefix + run.hiveId + C.LogStepInfix + run.step + C.LogErrorInfix + name)
    }
}
