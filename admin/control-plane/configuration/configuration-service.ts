import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import {
    AppliedConfiguration,
    ApplyOutcome,
    ApplyRequest,
    ConfigurationSaveRequest,
    ConfigurationScope,
    type ApplyRecord,
    type ApplyTarget,
    type ConfigurationVersion,
    type IConfigurationRepository,
} from '@pragmatic-tech-ai/pragmatic-configuration'
import type { ConsoleComponents } from './console-components.js'
import { ConfigurationDiff, type ConfigurationChange } from './configuration-diff.js'
import { ConfigurationTargets, type ConfigurationTargetDto } from './configuration-targets.js'
import { ConfigurationApplyUnavailableError, type IConfigurationApplier } from './kube-configuration-applier.js'

/** One saved version as the console lists it (no document). */
export type ConfigurationVersionSummaryDto = { version: number; componentVersion: string; descriptorDigest: string; author: string; createdAt: string; comment: string }

/** One saved version with its document as authored. */
export type ConfigurationVersionDto = ConfigurationVersionSummaryDto & { document: unknown }

/** One apply as the console lists it. */
export type ConfigurationApplyDto = { id: number; version: number; environment: string; outcome: string; requestedBy: string; requestedAt: string; completedAt: string | null; detail: string }

/** One setting of a component's option, as the editor shows it (a secret setting takes a secret reference). */
export type ConfigurationSettingDto = { name: string; type: string; description: string; required: boolean; secret: boolean; default?: unknown }

/** A component in the list: its descriptor, its newest version and where it can be applied (with what runs there). */
export type ConfigurationComponentSummaryDto = { component: string; componentVersion: string; descriptorDigest: string; head: number | null; targets: (ConfigurationTargetDto & { applied: number | null })[] }

/** A component's page: its options, its versions and its applies. */
export type ConfigurationComponentDto = {
    component: string
    componentVersion: string
    descriptorDigest: string
    options: { name: string; description: string; settings: ConfigurationSettingDto[] }[]
    versions: ConfigurationVersionSummaryDto[]
    applies: ConfigurationApplyDto[]
}

/** The console does not configure that component, or the scope has no such version or environment. */
export class ConfigurationNotFoundError extends Error
{
    private static readonly ErrorName = 'ConfigurationNotFoundError'
    public static readonly ComponentMessage = 'This console does not configure that component.'
    public static readonly VersionMessage = 'That configuration version does not exist.'
    public static readonly EnvironmentMessage = 'That environment does not exist.'

    public constructor(message: string)
    {
        super(message)
        this.name = ConfigurationNotFoundError.ErrorName
    }
}

/** The component has no deployment this console writes in that environment. */
export class ConfigurationNoTargetError extends Error
{
    private static readonly ErrorName = 'ConfigurationNoTargetError'
    private static readonly Text = 'This component has no deployment the console can configure in that environment.'

    public constructor()
    {
        super(ConfigurationNoTargetError.Text)
        this.name = ConfigurationNoTargetError.ErrorName
    }
}

/**
 * The tenant admin console's configuration repository (stage C step 1, server side): per component of its hive, the
 * versions of its configuration in the console's Postgres (pragmatic-configuration), each validated on save against the
 * descriptor of the container version it runs with (ConsoleComponents); a version is applied by writing the
 * `pragmatic-config-<component>` ConfigMap next to the deployment and the content hash on its pod template, recorded as
 * an apply (pending, then applied or failed with a fixed detail). The realm is the tenant's (one realm per tenant). Secret
 * settings are secret references only: the validator refuses a literal secret.
 */
export class ConfigurationService
{
    public static readonly WriteFailedDetail = 'The cluster refused the write.'
    public static readonly DescriptorChangedDetail = 'The version was validated for another component version; save it again for this one.'
    private static readonly NoDetail = ''

    public constructor(
        private readonly repository: IConfigurationRepository,
        private readonly components: ConsoleComponents,
        private readonly targets: ConfigurationTargets,
        private readonly applier: IConfigurationApplier)
    {
    }

    /** Every component the console configures, with its head and its targets (what is applied at each). */
    public async List(tenantId: string): Promise<ConfigurationComponentSummaryDto[]>
    {
        const out: ConfigurationComponentSummaryDto[] = []
        for (const name of this.components.Names())
        {
            const descriptor = this.DescriptorOf(name)
            const scope = new ConfigurationScope(tenantId, name)
            const head = await this.repository.Head(scope)
            const targets: ConfigurationComponentSummaryDto['targets'] = []
            for (const t of this.targets.For(name, tenantId))
            {
                const applied = await this.repository.Applied(scope, t.target)
                targets.push({ ...ConfigurationTargets.ToDto(t.environment, t.target), applied: applied === null ? null : applied.Version })
            }
            out.push({ component: name, componentVersion: descriptor.Version, descriptorDigest: descriptor.ContentDigest(), head: head === null ? null : head.Number, targets })
        }
        return out
    }

    /** A component's options, versions (oldest first) and applies (oldest first). */
    public async Component(tenantId: string, component: string): Promise<ConfigurationComponentDto>
    {
        const descriptor = this.DescriptorOf(component)
        const scope = new ConfigurationScope(tenantId, component)
        const targets = this.targets.For(component, tenantId)
        return {
            component,
            componentVersion: descriptor.Version,
            descriptorDigest: descriptor.ContentDigest(),
            options: descriptor.Options.map(o => ({ name: o.Name, description: o.Description, settings: o.Settings.map(s => ConfigurationService.SettingDto(s)) })),
            versions: (await this.repository.Versions(scope)).map(v => ConfigurationService.SummaryOf(v)),
            applies: (await this.repository.Applies(scope)).map(a => ConfigurationService.ApplyDto(a, targets)),
        }
    }

    public async Version(tenantId: string, component: string, version: number): Promise<ConfigurationVersionDto>
    {
        const found = await this.VersionOf(tenantId, component, version)
        return { ...ConfigurationService.SummaryOf(found), document: found.Document }
    }

    /** What changed from version `from` (0: the empty document) to version `to`. */
    public async Diff(tenantId: string, component: string, from: number, to: number): Promise<{ from: number; to: number; changes: ConfigurationChange[] }>
    {
        const before = from === 0 ? {} : (await this.VersionOf(tenantId, component, from)).Document
        const after = (await this.VersionOf(tenantId, component, to)).Document
        return { from, to, changes: ConfigurationDiff.Between(before, after) }
    }

    /**
     * Saves `document` as the next version (validated against the component's descriptor; based on version `basedOn`).
     * The repository's errors pass through: ConfigurationRejectedError (invalid, literal secrets), ConfigurationHeadMovedError
     * (another save landed first), ConfigurationRequestError.
     */
    public async Save(tenantId: string, component: string, basedOn: number, document: unknown, author: string, comment: string): Promise<ConfigurationVersionSummaryDto>
    {
        const descriptor = this.DescriptorOf(component)
        const saved = await this.repository.Save(new ConfigurationSaveRequest(new ConfigurationScope(tenantId, component), basedOn, document, descriptor, author, comment))
        return ConfigurationService.SummaryOf(saved)
    }

    /**
     * Applies version `version` to the component's deployment in `environment`: recorded pending, written, then completed
     * applied or failed (a fixed detail; the cluster's own text is not kept). Refused before anything is recorded when the
     * console cannot reach its cluster (ConfigurationApplyUnavailableError), the version or environment is unknown
     * (ConfigurationNotFoundError) or the component has no target there (ConfigurationNoTargetError).
     */
    public async Apply(tenantId: string, component: string, version: number, environment: string, requestedBy: string): Promise<ConfigurationApplyDto>
    {
        const descriptor = this.DescriptorOf(component)
        const saved = await this.VersionOf(tenantId, component, version)
        const targets = this.targets.For(component, tenantId)
        if (!this.targets.Has(tenantId, environment))
        {
            throw new ConfigurationNotFoundError(ConfigurationNotFoundError.EnvironmentMessage)
        }
        const target = targets.find(t => t.environment === environment)?.target
        if (target === undefined)
        {
            throw new ConfigurationNoTargetError()
        }
        if (!this.applier.Available)
        {
            throw new ConfigurationApplyUnavailableError()
        }
        const scope = new ConfigurationScope(tenantId, component)
        const pending = await this.repository.BeginApply(new ApplyRequest(scope, saved.Number, target, requestedBy))
        const outcome = await this.Write(saved, descriptor, target)
        const record = await this.repository.CompleteApply(scope, pending.Id, outcome.outcome, outcome.detail)
        return ConfigurationService.ApplyDto(record, targets)
    }

    private async Write(saved: ConfigurationVersion, descriptor: ComponentDescriptor, target: ApplyTarget): Promise<{ outcome: ApplyOutcome; detail: string }>
    {
        let applied: AppliedConfiguration
        try
        {
            applied = AppliedConfiguration.From(saved, descriptor)
        }
        catch
        {
            return { outcome: ApplyOutcome.Failed, detail: ConfigurationService.DescriptorChangedDetail }
        }
        try
        {
            await this.applier.Apply(applied, target)
            return { outcome: ApplyOutcome.Applied, detail: ConfigurationService.NoDetail }
        }
        catch
        {
            return { outcome: ApplyOutcome.Failed, detail: ConfigurationService.WriteFailedDetail }
        }
    }

    private DescriptorOf(component: string): ComponentDescriptor
    {
        const descriptor = this.components.Of(component)
        if (descriptor === undefined)
        {
            throw new ConfigurationNotFoundError(ConfigurationNotFoundError.ComponentMessage)
        }
        return descriptor
    }

    private async VersionOf(tenantId: string, component: string, version: number): Promise<ConfigurationVersion>
    {
        this.DescriptorOf(component)
        const found = Number.isSafeInteger(version) && version > 0 ? await this.repository.Version(new ConfigurationScope(tenantId, component), version) : null
        if (found === null)
        {
            throw new ConfigurationNotFoundError(ConfigurationNotFoundError.VersionMessage)
        }
        return found
    }

    private static SummaryOf(v: ConfigurationVersion): ConfigurationVersionSummaryDto
    {
        return { version: v.Number, componentVersion: v.ComponentVersion, descriptorDigest: v.DescriptorDigest, author: v.Author, createdAt: v.CreatedAt.toISOString(), comment: v.Comment }
    }

    private static ApplyDto(a: ApplyRecord, targets: readonly { environment: string; target: ApplyTarget }[]): ConfigurationApplyDto
    {
        const environment = targets.find(t => t.target.Equals(a.Target))?.environment ?? a.Target.Namespace
        return {
            id: a.Id, version: a.Version, environment, outcome: a.Outcome, requestedBy: a.RequestedBy, requestedAt: a.RequestedAt.toISOString(),
            completedAt: a.CompletedAt === undefined ? null : a.CompletedAt.toISOString(), detail: a.Detail,
        }
    }

    private static SettingDto(s: { Name: string; Type: string; Description: string; Required: boolean; Secret: boolean; Default: unknown }): ConfigurationSettingDto
    {
        const dto: ConfigurationSettingDto = { name: s.Name, type: s.Type, description: s.Description, required: s.Required, secret: s.Secret }
        if (s.Default !== undefined)
        {
            dto.default = s.Default
        }
        return dto
    }
}
