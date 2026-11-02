import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { PolicyDto } from '../../portal-types.js'
import { ReleaseChannel } from '../../release-channel.js'
import { PortalDialogViewModel } from '../../shell/portal-dialog-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import type { PolicyTarget } from './policy-target.js'

// Edit one release-policy rule (a tenant's, or one hive's): the channels it
// may adopt from (none ticked = no channel limit), a minimum version (blank =
// none) and a hold (a change freeze, with its reason). Save writes only what
// changed, through the target's policy methods; hives receive the updated
// offers on their next check-in.
export class PolicyEditDialogViewModel extends PortalDialogViewModel<boolean>
{
    private static readonly StableProperty = 'Stable'
    private static readonly EarlyAccessProperty = 'EarlyAccess'
    private static readonly MinVersionProperty = 'MinVersion'
    private static readonly IsHeldProperty = 'IsHeld'
    private static readonly HoldReasonProperty = 'HoldReason'
    private static readonly Saved = true
    private static readonly NoText = ''

    // What the control plane holds: the rule as loaded, advanced past each
    // write that succeeds (see SubmitCore).
    private initialStable: boolean
    private initialEarly: boolean
    private initialMinVersion: string
    private initialHeld: boolean
    private initialReason: string
    private stable: boolean
    private earlyAccess: boolean
    private minVersion: string
    private isHeld: boolean
    private holdReason: string

    public constructor(session: PortalSessionService, dialogs: DialogService, private readonly target: PolicyTarget, current: PolicyDto | undefined)
    {
        super(session, dialogs)
        const channels: readonly string[] = current?.channels ?? []
        this.initialStable = channels.includes(ReleaseChannel.Stable)
        this.initialEarly = channels.includes(ReleaseChannel.Early)
        this.initialMinVersion = current?.minVersion ?? PolicyEditDialogViewModel.NoText
        this.initialHeld = current?.hold !== undefined
        this.initialReason = current?.hold?.reason ?? PolicyEditDialogViewModel.NoText
        this.stable = this.initialStable
        this.earlyAccess = this.initialEarly
        this.minVersion = this.initialMinVersion
        this.isHeld = this.initialHeld
        this.holdReason = this.initialReason
    }

    // What the rule applies to, and how far it reaches.
    public get TargetLabel(): string
    {
        return this.target.Label
    }

    public get ScopeLabel(): string
    {
        return this.target.ScopeLabel
    }

    public get Stable(): boolean
    {
        return this.stable
    }

    public set Stable(value: boolean)
    {
        this.SetField(PolicyEditDialogViewModel.StableProperty, this.stable, value, v => { this.stable = v })
    }

    public get EarlyAccess(): boolean
    {
        return this.earlyAccess
    }

    public set EarlyAccess(value: boolean)
    {
        this.SetField(PolicyEditDialogViewModel.EarlyAccessProperty, this.earlyAccess, value, v => { this.earlyAccess = v })
    }

    public get MinVersion(): string
    {
        return this.minVersion
    }

    public set MinVersion(value: string)
    {
        this.SetField(PolicyEditDialogViewModel.MinVersionProperty, this.minVersion, value, v => { this.minVersion = v })
    }

    public get IsHeld(): boolean
    {
        return this.isHeld
    }

    public set IsHeld(value: boolean)
    {
        this.SetField(PolicyEditDialogViewModel.IsHeldProperty, this.isHeld, value, v => { this.isHeld = v })
    }

    public get HoldReason(): string
    {
        return this.holdReason
    }

    public set HoldReason(value: string)
    {
        this.SetField(PolicyEditDialogViewModel.HoldReasonProperty, this.holdReason, value, v => { this.holdReason = v })
    }

    // A hold records why; the reason is required while held.
    protected override get CanConfirm(): boolean
    {
        return !this.isHeld || this.holdReason.trim().length > 0
    }

    // The control plane has no multi-field policy write, so a save is up to
    // three separate writes and is not atomic. Each write that succeeds
    // advances the matching initial value, so when a later write is refused
    // the dialog stays open and a retry sends only what is still unsaved.
    protected override async SubmitCore(): Promise<boolean>
    {
        const api = this.Session.Client
        if (this.stable !== this.initialStable || this.earlyAccess !== this.initialEarly)
        {
            const stable = this.stable
            const early = this.earlyAccess
            await this.target.SetChannels(api, this.Channels())
            this.initialStable = stable
            this.initialEarly = early
        }
        const minVersion = this.minVersion.trim()
        if (minVersion !== this.initialMinVersion)
        {
            await (minVersion.length > 0 ? this.target.SetMinVersion(api, minVersion) : this.target.ClearMinVersion(api))
            this.initialMinVersion = minVersion
        }
        const reason = this.holdReason.trim()
        if (this.isHeld && (!this.initialHeld || reason !== this.initialReason))
        {
            await this.target.SetHold(api, reason)
            this.initialHeld = true
            this.initialReason = reason
        }
        else if (!this.isHeld && this.initialHeld)
        {
            await this.target.ClearHold(api)
            this.initialHeld = false
            this.initialReason = PolicyEditDialogViewModel.NoText
        }
        return PolicyEditDialogViewModel.Saved
    }

    private Channels(): string[]
    {
        const channels: string[] = []
        if (this.stable)
        {
            channels.push(ReleaseChannel.Stable)
        }
        if (this.earlyAccess)
        {
            channels.push(ReleaseChannel.Early)
        }
        return channels
    }
}
