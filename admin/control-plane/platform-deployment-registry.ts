import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { HiveRecord } from './platform-records.js'
import type { ManifestRecord, ManifestRegistry } from './manifest-record.js'
import type { GatingRecord, GatingRegistry } from './gating-record.js'
import type { SelectionRecord, SelectionRegistry } from './selection-record.js'
import type { HiveObservationRegistry } from './hive-observation-record.js'
import type { HiveHealthDto } from './hive-health-producer.js'
import type { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import type { IEnvironmentLookup } from './platform-directory.js'
import type { EnvironmentRecord } from './environment-record.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import { Channel } from './channel.js'
import type { IManifestSigner } from './manifest-signer.js'
import { ReleasePolicyRegistry } from './release-policy-record.js'
import type { ReleasePolicyRecord } from './release-policy-record.js'
import { PolicyStoreUnavailableError, AgentUnauthorizedError, HiveNotRegisteredError, ManifestExistsError, ManifestNotGatedError, UnknownHiveError, UnknownManifestError, ManifestWithdrawnError, TenantOnHoldError, ChannelNotSubscribedError, VersionBelowFloorError } from './rollout-errors.js'
import type { AdoptionLedgerRegistry, AdoptionLedgerRecord, LedgerAction } from './adoption-ledger-record.js'
import { VersionOrder } from './version-order.js'

type PolicyBlock = 'not-gated' | 'withdrawn' | 'held' | 'channel' | 'floor'

export interface IHiveLookup
{
    GetHive(id: string): HiveRecord | undefined
}

export interface IWorkloadPlacement
{
    WorkloadFor(record: EnvironmentRecord): EnvironmentWorkload
}

export type RolloutTarget = { version: string; image: string }

export type EnvironmentRolloutStatus = { environmentName: string; runningImage: string | undefined; obsolete: boolean; ready: boolean }

export type HiveRolloutStatus = { targetVersion: string | undefined; environments: EnvironmentRolloutStatus[] }

export class PlatformDeploymentRegistry
{
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HashEncoding = 'hex'
    private static readonly KeySeparator = ':'
    private static readonly LedgerFailureMessage = 'adoption ledger append failed:'

    public constructor(
        private readonly manifests: ManifestRegistry,
        private readonly gating: GatingRegistry,
        private readonly selections: SelectionRegistry,
        private readonly registrations: RolloutRegistrationRegistry,
        private readonly hives: IHiveLookup,
        private readonly orchestrators: HiveOrchestratorFactory,
        private readonly environments: IEnvironmentLookup,
        private readonly placement: IWorkloadPlacement,
        private readonly observations: HiveObservationRegistry,
        private readonly signer?: IManifestSigner,
        private readonly policies?: ReleasePolicyRegistry,
        private readonly ledger?: AdoptionLedgerRegistry)
    {
    }

    public async Publish(version: string, image: string, notes?: string, channel?: Channel): Promise<ManifestRecord>
    {
        if (this.manifests.Get(version) !== undefined)
        {
            throw new ManifestExistsError(version)
        }
        const record: ManifestRecord = { id: version, image, publishedAt: new Date().toISOString(), channel: channel ?? Channel.Stable }
        if (notes !== undefined)
        {
            record.notes = notes
        }
        if (this.signer !== undefined)
        {
            const { digest, signed } = await this.signer.SignForPublish(image)
            if (digest !== undefined)
            {
                record.digest = digest
            }
            record.signed = signed
        }
        await this.manifests.Put(record)
        return record
    }

    /** Every published manifest, including withdrawn versions. */
    public AllManifests(): readonly ManifestRecord[]
    {
        return this.manifests.List()
    }

    /** Every gating allowlist record, across all tenants. */
    public AllGating(): readonly GatingRecord[]
    {
        return this.gating.List()
    }

    /** Every per-hive selection record. */
    public AllSelections(): readonly SelectionRecord[]
    {
        return this.selections.List()
    }

    /** Marks a published version withdrawn (or restores it). A withdrawn version stays published and gated but is flagged for the UI. */
    public async SetWithdrawn(version: string, withdrawn: boolean, reason?: string, actor?: string): Promise<ManifestRecord>
    {
        const manifest = this.manifests.Get(version)
        if (manifest === undefined)
        {
            throw new UnknownManifestError(version)
        }
        const { withdrawal: _previous, ...rest } = manifest
        const updated: ManifestRecord = withdrawn
            ? { ...rest, withdrawn, withdrawal: { reason: reason!, actor: actor!, at: new Date().toISOString() } }
            : { ...rest, withdrawn }
        await this.manifests.Put(updated)
        await this.RecordLedger({ version, action: withdrawn ? 'withdrawn' : 'restored' })
        return updated
    }

    /** Every per-tenant release-policy record. */
    public AllPolicies(): readonly ReleasePolicyRecord[]
    {
        return this.policies?.List() ?? []
    }

    public async SetChannels(tenantId: string, channels: Channel[]): Promise<ReleasePolicyRecord>
    {
        return this.SavePolicy(tenantId, { ...this.PolicyBase(tenantId), channels: [...channels] })
    }

    public async SetMinVersion(tenantId: string, version: string): Promise<ReleasePolicyRecord>
    {
        return this.SavePolicy(tenantId, { ...this.PolicyBase(tenantId), minVersion: version })
    }

    public async ClearMinVersion(tenantId: string): Promise<ReleasePolicyRecord>
    {
        const { minVersion: _removed, ...rest } = this.PolicyBase(tenantId)
        return this.SavePolicy(tenantId, rest)
    }

    public async SetHold(tenantId: string, reason: string, actor: string): Promise<ReleasePolicyRecord>
    {
        return this.SavePolicy(tenantId, { ...this.PolicyBase(tenantId), hold: { reason, actor, at: new Date().toISOString() } })
    }

    public async ClearHold(tenantId: string): Promise<ReleasePolicyRecord>
    {
        const { hold: _removed, ...rest } = this.PolicyBase(tenantId)
        return this.SavePolicy(tenantId, rest)
    }

    private PolicyBase(tenantId: string): ReleasePolicyRecord
    {
        if (this.policies === undefined)
        {
            throw new PolicyStoreUnavailableError(tenantId)
        }
        return this.policies.Get(tenantId) ?? { id: tenantId, tenantId }
    }

    private async SavePolicy(tenantId: string, record: ReleasePolicyRecord): Promise<ReleasePolicyRecord>
    {
        const updated: ReleasePolicyRecord = { ...record, id: tenantId, tenantId }
        await this.policies!.Put(updated)
        return updated
    }

    public ManifestsFor(tenantId: string): readonly ManifestRecord[]
    {
        const result: ManifestRecord[] = []
        for (const gate of this.gating.List())
        {
            if (gate.tenantId !== tenantId)
            {
                continue
            }
            const manifest = this.manifests.Get(gate.version)
            if (manifest !== undefined)
            {
                result.push(manifest)
            }
        }
        return result
    }

    public async Gate(tenantId: string, version: string): Promise<void>
    {
        if (this.manifests.Get(version) === undefined)
        {
            throw new UnknownManifestError(version)
        }
        const existed = this.gating.Get(this.GateId(tenantId, version)) !== undefined
        await this.gating.Put({ id: this.GateId(tenantId, version), tenantId, version, gatedAt: new Date().toISOString() })
        if (!existed)
        {
            await this.RecordLedger({ tenantId, version, action: 'gated' })
        }
    }

    public async Ungate(tenantId: string, version: string): Promise<void>
    {
        const existed = this.gating.Get(this.GateId(tenantId, version)) !== undefined
        await this.gating.Remove(this.GateId(tenantId, version))
        if (existed)
        {
            await this.RecordLedger({ tenantId, version, action: 'ungated' })
        }
    }

    /** Records the selection (after the gating check) and pushes the roll to the hive's orchestrator. */
    public async SelectTarget(hiveId: string, version: string): Promise<void>
    {
        const recorded = await this.Record(hiveId, version, 'selected')
        await this.Push(recorded.hive, recorded.image)
    }

    /** Records the selection after the same gating check as SelectTarget but does NOT push: the hive's own agent rolls locally by polling the target. */
    public async RecordAdoption(hiveId: string, version: string): Promise<void>
    {
        await this.Record(hiveId, version, 'adopted')
    }

    /** The versions gated for the tenant that owns the hive. */
    public AdoptableFor(hiveId: string): readonly ManifestRecord[]
    {
        const hive = this.hives.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        return this.AdoptableForTenant(hive.tenantId)
    }

    /** Gated versions that also pass every release-policy rule (withdrawn, hold, channels, floor). */
    public AdoptableForTenant(tenantId: string): readonly ManifestRecord[]
    {
        return this.ManifestsFor(tenantId).filter(m => this.BlockReasonFor(tenantId, m) === undefined)
    }

    /** First failing rule in fixed order, or undefined when the version may be adopted. */
    private BlockReasonFor(tenantId: string, manifest: ManifestRecord): PolicyBlock | undefined
    {
        const gate = this.gating.Get(this.GateId(tenantId, manifest.id))
        if (gate === undefined || gate.tenantId !== tenantId)
        {
            return 'not-gated'
        }
        if (manifest.withdrawn === true)
        {
            return 'withdrawn'
        }
        const policy = this.policies?.Get(tenantId)
        if (policy === undefined)
        {
            return undefined
        }
        if (policy.hold !== undefined)
        {
            return 'held'
        }
        if (policy.channels !== undefined && policy.channels.length > 0 && !policy.channels.includes(manifest.channel ?? Channel.Stable))
        {
            return 'channel'
        }
        if (policy.minVersion !== undefined && VersionOrder.Compare(manifest.id, policy.minVersion) < 0)
        {
            return 'floor'
        }
        return undefined
    }

    private BlockError(reason: PolicyBlock, version: string): Error
    {
        switch (reason)
        {
            case 'not-gated':
                return new ManifestNotGatedError(version)
            case 'withdrawn':
                return new ManifestWithdrawnError(version)
            case 'held':
                return new TenantOnHoldError(version)
            case 'channel':
                return new ChannelNotSubscribedError(version)
            case 'floor':
                return new VersionBelowFloorError(version)
        }
    }

    /** Validates hive, published and gated-for-the-hive's-tenant, then writes the selection; returns what a push needs. */
    private async Record(hiveId: string, version: string, source: LedgerAction): Promise<{ hive: HiveRecord; image: string }>
    {
        const hive = this.hives.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        const manifest = this.manifests.Get(version)
        if (manifest === undefined)
        {
            throw new UnknownManifestError(version)
        }
        const reason = this.BlockReasonFor(hive.tenantId, manifest)
        if (reason !== undefined)
        {
            throw this.BlockError(reason, version)
        }
        await this.selections.Put({ id: hiveId, hiveId, targetVersion: version, selectedAt: new Date().toISOString() })
        await this.RecordLedger({ hiveId, tenantId: hive.tenantId, version, action: source })
        return { hive, image: manifest.image }
    }

    /** The hive's version-change timeline, newest first; empty when no ledger is configured. */
    public LedgerFor(hiveId: string, limit: number): readonly AdoptionLedgerRecord[]
    {
        return this.ledger?.ForHive(hiveId, limit) ?? []
    }

    /** Best-effort: a ledger failure never breaks the operation that already succeeded. */
    private async RecordLedger(entry: { tenantId?: string; hiveId?: string; version: string; action: LedgerAction }): Promise<void>
    {
        if (this.ledger === undefined)
        {
            return
        }
        try
        {
            await this.ledger.Append(entry)
        }
        catch (error)
        {
            console.error(PlatformDeploymentRegistry.LedgerFailureMessage, (error as Error).name)
        }
    }

    /** Rolls every environment bound to the hive; an unreachable backend leaves the recorded selection for the pull agent. */
    private async Push(hive: HiveRecord, image: string): Promise<void>
    {
        let orchestrator
        try
        {
            orchestrator = this.orchestrators.For(hive)
        }
        catch (error)
        {
            if (error instanceof UnsupportedBackendError)
            {
                return
            }
            throw error
        }
        for (const env of this.environments.List())
        {
            if (env.hiveId === hive.id)
            {
                await orchestrator.Roll(this.placement.WorkloadFor(env), image)
            }
        }
    }

    public TargetFor(hiveId: string): RolloutTarget | undefined
    {
        const selection = this.selections.Get(hiveId)
        if (selection === undefined)
        {
            return undefined
        }
        const manifest = this.manifests.Get(selection.targetVersion)
        return manifest === undefined ? undefined : { version: manifest.id, image: manifest.image }
    }

    /** The single whole-hive snapshot up-feed; replaces the hive's prior observation. The caller has already verified the bearer. */
    public async ReportSnapshot(hiveId: string, environments: HiveHealthDto[]): Promise<void>
    {
        await this.observations.RecordSnapshot(hiveId, environments)
    }

    public StatusFor(hiveId: string): HiveRolloutStatus
    {
        const target = this.TargetFor(hiveId)
        const environments = this.observations.LatestFor(hiveId)
            .map(h => ({
                environmentName: h.environmentName,
                runningImage: h.runningImage,
                obsolete: target !== undefined && h.runningImage !== target.image,
                ready: h.ready
            }))
        return { targetVersion: target?.version, environments }
    }

    public async RegisterHive(hiveId: string): Promise<string>
    {
        const token = randomBytes(PlatformDeploymentRegistry.TokenBytes).toString(PlatformDeploymentRegistry.TokenEncoding)
        await this.registrations.Put({ id: hiveId, hiveId, agentTokenHash: this.HashToken(token), registeredAt: new Date().toISOString() })
        return token
    }

    public async DeregisterHive(hiveId: string): Promise<void>
    {
        await this.registrations.Remove(hiveId)
    }

    public async VerifyAgentToken(hiveId: string, presentedToken: string): Promise<void>
    {
        const registration = this.registrations.Get(hiveId)
        if (registration === undefined)
        {
            throw new HiveNotRegisteredError(hiveId)
        }
        const expected = Buffer.from(registration.agentTokenHash, PlatformDeploymentRegistry.HashEncoding)
        const presented = Buffer.from(this.HashToken(presentedToken), PlatformDeploymentRegistry.HashEncoding)
        if (expected.length !== presented.length || !timingSafeEqual(expected, presented))
        {
            throw new AgentUnauthorizedError(hiveId)
        }
    }

    private HashToken(token: string): string
    {
        return createHash(PlatformDeploymentRegistry.HashAlgorithm).update(token).digest(PlatformDeploymentRegistry.HashEncoding)
    }

    private GateId(tenantId: string, version: string): string
    {
        return tenantId + PlatformDeploymentRegistry.KeySeparator + version
    }
}
