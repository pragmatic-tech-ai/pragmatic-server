import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { HiveRecord } from './platform-records.js'
import type { ManifestRecord, ManifestRegistry } from './manifest-record.js'
import type { GatingRegistry } from './gating-record.js'
import type { SelectionRegistry } from './selection-record.js'
import type { RolloutReportRegistry } from './rollout-report-record.js'
import type { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { AgentUnauthorizedError, HiveNotRegisteredError, ManifestExistsError, ManifestNotGatedError, UnknownHiveError, UnknownManifestError } from './rollout-errors.js'

export interface IHiveLookup
{
    GetHive(id: string): HiveRecord | undefined
}

export type RolloutTarget = { version: string; image: string }

export type EnvironmentRolloutStatus = { environmentName: string; runningImage: string; obsolete: boolean; ready: boolean }

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
        private readonly reports: RolloutReportRegistry,
        private readonly registrations: RolloutRegistrationRegistry,
        private readonly hives: IHiveLookup)
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

    public async SelectTarget(hiveId: string, version: string): Promise<void>
    {
        const hive = this.hives.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        if (this.manifests.Get(version) === undefined)
        {
            throw new UnknownManifestError(version)
        }
        if (this.gating.Get(this.GateId(hive.tenantId, version)) === undefined)
        {
            throw new ManifestNotGatedError(version)
        }
        await this.selections.Put({ id: hiveId, hiveId, targetVersion: version, selectedAt: new Date().toISOString() })
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

    public async Report(hiveId: string, environmentName: string, runningImage: string, ready: boolean): Promise<void>
    {
        await this.reports.Put({ id: this.ReportId(hiveId, environmentName), hiveId, environmentName, runningImage, ready, reportedAt: new Date().toISOString() })
    }

    public StatusFor(hiveId: string): HiveRolloutStatus
    {
        const target = this.TargetFor(hiveId)
        const environments = this.reports.List()
            .filter(r => r.hiveId === hiveId)
            .map(r => ({
                environmentName: r.environmentName,
                runningImage: r.runningImage,
                obsolete: target !== undefined && r.runningImage !== target.image,
                ready: r.ready
            }))
        return { targetVersion: target?.version, environments }
    }

    public async RegisterHive(hiveId: string): Promise<string>
    {
        const token = randomBytes(PlatformDeploymentRegistry.TokenBytes).toString(PlatformDeploymentRegistry.TokenEncoding)
        await this.registrations.Put({ id: hiveId, hiveId, agentTokenHash: this.HashToken(token), registeredAt: new Date().toISOString() })
        return token
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

    private ReportId(hiveId: string, environmentName: string): string
    {
        return hiveId + PlatformDeploymentRegistry.KeySeparator + environmentName
    }
}
