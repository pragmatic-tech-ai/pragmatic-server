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
import { AgentUnauthorizedError, HiveNotRegisteredError, ManifestExistsError, ManifestNotGatedError, UnknownHiveError, UnknownManifestError } from './rollout-errors.js'

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

    public constructor(
        private readonly manifests: ManifestRegistry,
        private readonly gating: GatingRegistry,
        private readonly selections: SelectionRegistry,
        private readonly registrations: RolloutRegistrationRegistry,
        private readonly hives: IHiveLookup,
        private readonly orchestrators: HiveOrchestratorFactory,
        private readonly environments: IEnvironmentLookup,
        private readonly placement: IWorkloadPlacement,
        private readonly observations: HiveObservationRegistry)
    {
    }

    public async Publish(version: string, image: string, notes?: string): Promise<ManifestRecord>
    {
        if (this.manifests.Get(version) !== undefined)
        {
            throw new ManifestExistsError(version)
        }
        const record: ManifestRecord = { id: version, image, publishedAt: new Date().toISOString() }
        if (notes !== undefined)
        {
            record.notes = notes
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
    public async SetWithdrawn(version: string, withdrawn: boolean): Promise<ManifestRecord>
    {
        const manifest = this.manifests.Get(version)
        if (manifest === undefined)
        {
            throw new UnknownManifestError(version)
        }
        const updated: ManifestRecord = { ...manifest, withdrawn }
        await this.manifests.Put(updated)
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
        await this.gating.Put({ id: this.GateId(tenantId, version), tenantId, version, gatedAt: new Date().toISOString() })
    }

    public async Ungate(tenantId: string, version: string): Promise<void>
    {
        await this.gating.Remove(this.GateId(tenantId, version))
    }

    /** Records the selection (after the gating check) and pushes the roll to the hive's orchestrator. */
    public async SelectTarget(hiveId: string, version: string): Promise<void>
    {
        const recorded = await this.Record(hiveId, version)
        await this.Push(recorded.hive, recorded.image)
    }

    /** Records the selection after the same gating check as SelectTarget but does NOT push: the hive's own agent rolls locally by polling the target. */
    public async RecordAdoption(hiveId: string, version: string): Promise<void>
    {
        await this.Record(hiveId, version)
    }

    /** The versions gated for the tenant that owns the hive. */
    public AdoptableFor(hiveId: string): readonly ManifestRecord[]
    {
        const hive = this.hives.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        return this.ManifestsFor(hive.tenantId)
    }

    /** Validates hive, published and gated-for-the-hive's-tenant, then writes the selection; returns what a push needs. */
    private async Record(hiveId: string, version: string): Promise<{ hive: HiveRecord; image: string }>
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
        const gate = this.gating.Get(this.GateId(hive.tenantId, version))
        if (gate === undefined || gate.tenantId !== hive.tenantId)
        {
            throw new ManifestNotGatedError(version)
        }
        await this.selections.Put({ id: hiveId, hiveId, targetVersion: version, selectedAt: new Date().toISOString() })
        return { hive, image: manifest.image }
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
