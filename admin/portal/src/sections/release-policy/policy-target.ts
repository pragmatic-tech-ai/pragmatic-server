import type { ControlPlaneClient } from '../../api-client.js'
import type { PolicyDto } from '../../portal-types.js'

// The subject of a release-policy rule, and the control-plane writes that
// change it. A tenant rule applies to every hive of the tenant; a hive rule
// narrows it for one hive (an unset value inherits the tenant's).
export abstract class PolicyTarget
{
    protected constructor(public readonly Id: string, public readonly Label: string)
    {
    }

    // Which hives the rule reaches.
    public abstract get ScopeLabel(): string

    // The labels for the channels and the minimum version this rule leaves unset.
    public abstract get UnsetChannelsLabel(): string
    public abstract get UnsetMinVersionLabel(): string

    // This target's rule among all policies; undefined when it has none.
    public abstract Find(policies: readonly PolicyDto[]): PolicyDto | undefined

    public abstract SetChannels(client: ControlPlaneClient, channels: string[]): Promise<PolicyDto>
    public abstract SetMinVersion(client: ControlPlaneClient, version: string): Promise<PolicyDto>
    public abstract ClearMinVersion(client: ControlPlaneClient): Promise<PolicyDto>
    public abstract SetHold(client: ControlPlaneClient, reason: string): Promise<PolicyDto>
    public abstract ClearHold(client: ControlPlaneClient): Promise<PolicyDto>
}

// A tenant's rule: applies to every hive of the tenant.
export class TenantPolicyTarget extends PolicyTarget
{
    private static readonly AllChannelsLabel = 'All channels'
    private static readonly NoMinimumLabel = 'No minimum'
    private static readonly EveryHiveLabel = 'Every hive of this tenant'

    public constructor(tenantId: string, label: string)
    {
        super(tenantId, label)
    }

    public get ScopeLabel(): string
    {
        return TenantPolicyTarget.EveryHiveLabel
    }

    public get UnsetChannelsLabel(): string
    {
        return TenantPolicyTarget.AllChannelsLabel
    }

    public get UnsetMinVersionLabel(): string
    {
        return TenantPolicyTarget.NoMinimumLabel
    }

    public Find(policies: readonly PolicyDto[]): PolicyDto | undefined
    {
        return policies.find(p => p.tenantId === this.Id && p.hiveId === undefined)
    }

    public SetChannels(client: ControlPlaneClient, channels: string[]): Promise<PolicyDto>
    {
        return client.SetTenantChannels(this.Id, channels)
    }

    public SetMinVersion(client: ControlPlaneClient, version: string): Promise<PolicyDto>
    {
        return client.SetTenantMinVersion(this.Id, version)
    }

    public ClearMinVersion(client: ControlPlaneClient): Promise<PolicyDto>
    {
        return client.ClearTenantMinVersion(this.Id)
    }

    public SetHold(client: ControlPlaneClient, reason: string): Promise<PolicyDto>
    {
        return client.SetTenantHold(this.Id, reason)
    }

    public ClearHold(client: ControlPlaneClient): Promise<PolicyDto>
    {
        return client.ClearTenantHold(this.Id)
    }
}

// One hive's rule: narrows its tenant's rule for that hive.
export class HivePolicyTarget extends PolicyTarget
{
    private static readonly InheritsLabel = 'Inherits tenant'
    private static readonly OneHiveLabel = 'One hive'

    public constructor(hiveId: string, label: string)
    {
        super(hiveId, label)
    }

    public get ScopeLabel(): string
    {
        return HivePolicyTarget.OneHiveLabel
    }

    public get UnsetChannelsLabel(): string
    {
        return HivePolicyTarget.InheritsLabel
    }

    public get UnsetMinVersionLabel(): string
    {
        return HivePolicyTarget.InheritsLabel
    }

    public Find(policies: readonly PolicyDto[]): PolicyDto | undefined
    {
        return policies.find(p => p.hiveId === this.Id)
    }

    public SetChannels(client: ControlPlaneClient, channels: string[]): Promise<PolicyDto>
    {
        return client.SetHiveChannels(this.Id, channels)
    }

    public SetMinVersion(client: ControlPlaneClient, version: string): Promise<PolicyDto>
    {
        return client.SetHiveMinVersion(this.Id, version)
    }

    public ClearMinVersion(client: ControlPlaneClient): Promise<PolicyDto>
    {
        return client.ClearHiveMinVersion(this.Id)
    }

    public SetHold(client: ControlPlaneClient, reason: string): Promise<PolicyDto>
    {
        return client.SetHiveHold(this.Id, reason)
    }

    public ClearHold(client: ControlPlaneClient): Promise<PolicyDto>
    {
        return client.ClearHiveHold(this.Id)
    }
}
