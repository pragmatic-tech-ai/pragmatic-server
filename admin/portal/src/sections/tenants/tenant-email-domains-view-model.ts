import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../api-client.js'
import { PortalDates } from '../../portal-dates.js'
import { EmailDomainSource, type EmailDomainApprovalDto, type TenantEmailDomainsDto } from '../../portal-types.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'

// One domain an in-hive tenant's console reports: Approved or Pending, who else claims it, and Approve / Revoke
// (offered to operators who may mutate; an approved domain is matched in sign-in discovery).
export class EmailDomainApprovalRowViewModel extends Observable
{
    private static readonly ApprovedLabel = 'Approved'
    private static readonly PendingLabel = 'Pending'

    private readonly approveCommand: RelayCommand
    private readonly revokeCommand: RelayCommand

    public constructor(private readonly owner: TenantEmailDomainsViewModel, private readonly approval: EmailDomainApprovalDto)
    {
        super()
        this.approveCommand = new RelayCommand(() => { void this.Approve() }, () => this.CanApprove && !this.owner.IsBusy)
        this.revokeCommand = new RelayCommand(() => { void this.Revoke() }, () => this.CanRevoke && !this.owner.IsBusy)
    }

    public get Domain(): string
    {
        return this.approval.domain
    }

    public get IsApproved(): boolean
    {
        return this.approval.approved
    }

    public get StatusLabel(): string
    {
        const R = EmailDomainApprovalRowViewModel
        return this.approval.approved ? R.ApprovedLabel : R.PendingLabel
    }

    // 'Also claimed by: a, b', or '' when no other tenant claims the domain.
    public get SharedWithText(): string
    {
        return TenantEmailDomainsViewModel.ClaimedByText(this.approval.sharedWith)
    }

    // Whether Approve is offered: a pending domain, for an operator who may mutate.
    public get CanApprove(): boolean
    {
        return this.owner.CanWrite && !this.approval.approved
    }

    // Whether Revoke is offered: an approved domain, for an operator who may mutate.
    public get CanRevoke(): boolean
    {
        return this.owner.CanWrite && this.approval.approved
    }

    public get ApproveCommand(): RelayCommand
    {
        return this.approveCommand
    }

    public get RevokeCommand(): RelayCommand
    {
        return this.revokeCommand
    }

    // Approves the domain. Never throws: a refusal shows in the block's ErrorText.
    public async Approve(): Promise<void>
    {
        if (this.approveCommand.CanExecute())
        {
            await this.owner.ApproveDomain(this.approval.domain)
        }
    }

    // Withdraws the domain's approval. Never throws.
    public async Revoke(): Promise<void>
    {
        if (this.revokeCommand.CanExecute())
        {
            await this.owner.RevokeDomain(this.approval.domain)
        }
    }

    // Re-evaluates both commands (the block went busy or idle).
    public RaiseCommandsChanged(): void
    {
        this.approveCommand.RaiseCanExecuteChanged()
        this.revokeCommand.RaiseCanExecuteChanged()
    }
}

// The tenant detail's Email domains block. A control-plane tenant's domains are edited here (one comma-separated
// list, Save). An in-hive tenant's domains are the ones its console reports, read-only here (the tenant Owner sets
// them in the console); each takes effect in sign-in discovery only once an operator approved it, so each is listed
// with Approved / Pending and Approve / Revoke. Read-only operators get no write action. A failed read never fails
// the page: a 404 (a control plane without the route) says the block is not available, any other failure shows its
// sentence here.
export class TenantEmailDomainsViewModel extends Observable
{
    private static readonly NoneDeclaredLabel = 'None declared.'
    private static readonly DomainSeparator = ', '
    private static readonly DomainSplitter = /[\s,;]+/
    private static readonly SourcePrefix = 'Reported by the tenant console in its hive on '
    private static readonly SourceSuffix = '. The tenant Owner changes them there.'
    private static readonly NotReportedText = 'The tenant console in its hive has not reported its email domains yet. The tenant Owner sets them there.'
    private static readonly ClaimedByPrefix = 'Also claimed by: '
    private static readonly SavedLabel = 'Saved.'
    private static readonly UnavailableText = 'Email domains are not available here.'
    private static readonly NoText = ''
    // Every bound value a change can move, raised when it did.
    private static readonly BoundProperties: readonly string[] = [
        'DomainsText', 'DomainsLabel', 'IsEditable', 'IsReadOnly', 'IsInHive', 'IsAvailable', 'HasDomainsLabel', 'HasApprovals',
        'SourceText', 'SharedWithText', 'HasSharedWithLine', 'NoticeText', 'ErrorText', 'SavedText', 'IsBusy',
    ]

    private readonly approvals = new ObservableCollection<EmailDomainApprovalRowViewModel>()
    private readonly saveCommand: RelayCommand
    private report: TenantEmailDomainsDto | undefined
    private text = ''
    // True once the operator typed since the list was last shown: a reload then keeps the typed text.
    private dirty = false
    private unavailable = false
    private busy = false
    private errorText = ''
    private savedText = ''
    // Bumped by each Load: a read that lands after a newer one started is dropped.
    private generation = 0

    public constructor(private readonly session: PortalSessionService, public readonly TenantId: string)
    {
        super()
        this.saveCommand = new RelayCommand(() => { void this.Save() }, () => this.CanSave)
    }

    // 'Also claimed by: a, b' for the given tenant ids, or '' for none.
    public static ClaimedByText(tenantIds: readonly string[]): string
    {
        const T = TenantEmailDomainsViewModel
        return tenantIds.length === 0 ? T.NoText : T.ClaimedByPrefix + tenantIds.join(T.DomainSeparator)
    }

    // The domains as typed (comma-separated); shows the loaded list until the operator types.
    public get DomainsText(): string
    {
        return this.text
    }

    public set DomainsText(value: string)
    {
        if (value === this.text)
        {
            return
        }
        this.Change(() =>
        {
            this.text = value
            this.dirty = true
            this.savedText = TenantEmailDomainsViewModel.NoText
        })
    }

    // The loaded domains as one line, or 'None declared.'.
    public get DomainsLabel(): string
    {
        const domains = this.report?.domains ?? []
        return domains.length === 0 ? TenantEmailDomainsViewModel.NoneDeclaredLabel : domains.join(TenantEmailDomainsViewModel.DomainSeparator)
    }

    // Whether the list is edited here: a control-plane tenant, for an operator who may mutate.
    public get IsEditable(): boolean
    {
        return this.report?.editable === true && this.session.CanMutate
    }

    public get IsReadOnly(): boolean
    {
        return !this.IsEditable
    }

    // Whether the tenant's console runs in its hive (its domains come from the console's report).
    public get IsInHive(): boolean
    {
        return this.report?.source === EmailDomainSource.Console
    }

    // False when this control plane does not serve email domains (the read answered 404).
    public get IsAvailable(): boolean
    {
        return !this.unavailable
    }

    // Whether the read-only one-line list shows: a loaded list not edited here and not shown as approval rows.
    public get HasDomainsLabel(): boolean
    {
        return this.report !== undefined && this.IsReadOnly && !this.HasApprovals
    }

    // The in-hive console's reported domains with their approvals (none for a control-plane tenant).
    public get Approvals(): ObservableCollection<EmailDomainApprovalRowViewModel>
    {
        return this.approvals
    }

    public get HasApprovals(): boolean
    {
        return this.approvals.Count > 0
    }

    // Where an in-hive tenant's domains come from and who changes them; '' for a control-plane tenant.
    public get SourceText(): string
    {
        const T = TenantEmailDomainsViewModel
        if (this.report?.source !== EmailDomainSource.Console)
        {
            return T.NoText
        }
        if (this.report.reportedAt === undefined)
        {
            return T.NotReportedText
        }
        return T.SourcePrefix + PortalDates.DateTimeLabel(this.report.reportedAt) + T.SourceSuffix
    }

    // 'Also claimed by: a, b' when other tenants claim any of these domains; '' otherwise.
    public get SharedWithText(): string
    {
        return TenantEmailDomainsViewModel.ClaimedByText(this.report?.sharedWith ?? [])
    }

    // Whether the block-wide "also claimed by" line shows (approval rows carry their own).
    public get HasSharedWithLine(): boolean
    {
        return this.SharedWithText.length > 0 && !this.HasApprovals
    }

    // 'Email domains are not available here.' after a 404; '' otherwise.
    public get NoticeText(): string
    {
        return this.unavailable ? TenantEmailDomainsViewModel.UnavailableText : TenantEmailDomainsViewModel.NoText
    }

    // Why the last read, save, approval or revoke failed; '' otherwise.
    public get ErrorText(): string
    {
        return this.errorText
    }

    // 'Saved.' after a save, until the operator types again.
    public get SavedText(): string
    {
        return this.savedText
    }

    // True while a save, approval or revoke is in flight.
    public get IsBusy(): boolean
    {
        return this.busy
    }

    // Whether the operator may write here at all (approval rows offer their actions only then).
    public get CanWrite(): boolean
    {
        return this.session.CanMutate
    }

    public get SaveCommand(): RelayCommand
    {
        return this.saveCommand
    }

    private get CanSave(): boolean
    {
        return this.IsEditable && !this.busy && !TenantEmailDomainsViewModel.SameList(this.Parsed(), this.report?.domains ?? [])
    }

    // Reads the tenant's email domains. Never throws: a 404 marks the block not available, a 401 expires the session,
    // any other failure shows its sentence in ErrorText (a list already shown stays).
    public async Load(): Promise<void>
    {
        const generation = ++this.generation
        let report: TenantEmailDomainsDto
        try
        {
            report = await this.session.Client.GetTenantEmailDomains(this.TenantId)
        }
        catch (e)
        {
            if (generation !== this.generation || this.Expired(e))
            {
                return
            }
            const notFound = e instanceof ApiError && e.Status === ApiError.NotFoundStatus
            this.Change(() =>
            {
                this.unavailable = notFound
                this.errorText = notFound ? TenantEmailDomainsViewModel.NoText : TenantEmailDomainsViewModel.MessageOf(e)
                if (notFound)
                {
                    this.Show(undefined)
                }
            })
            return
        }
        if (generation !== this.generation)
        {
            return
        }
        this.Change(() =>
        {
            this.unavailable = false
            this.errorText = TenantEmailDomainsViewModel.NoText
            this.Show(report)
        })
    }

    // Stores the typed list (a control-plane tenant). Never throws: a refusal shows its sentence in ErrorText.
    public async Save(): Promise<void>
    {
        if (!this.CanSave)
        {
            return
        }
        const domains = this.Parsed()
        await this.Request(async () =>
        {
            const report = await this.session.Client.SetTenantEmailDomains(this.TenantId, domains)
            this.Change(() =>
            {
                this.dirty = false
                this.Show(report)
                this.savedText = TenantEmailDomainsViewModel.SavedLabel
            })
        })
    }

    // Approves one domain the in-hive console reports. Never throws.
    public async ApproveDomain(domain: string): Promise<void>
    {
        await this.Act(() => this.session.Client.ApproveTenantEmailDomain(this.TenantId, domain))
    }

    // Withdraws one domain's approval. Never throws.
    public async RevokeDomain(domain: string): Promise<void>
    {
        await this.Act(() => this.session.Client.RevokeTenantEmailDomain(this.TenantId, domain))
    }

    private async Act(action: () => Promise<TenantEmailDomainsDto>): Promise<void>
    {
        if (!this.CanWrite || this.busy)
        {
            return
        }
        await this.Request(async () =>
        {
            const report = await action()
            this.Change(() => { this.Show(report) })
        })
    }

    // Runs one write: busy while it runs, its refusal in ErrorText, a 401 expires the session.
    private async Request(action: () => Promise<void>): Promise<void>
    {
        this.Change(() =>
        {
            this.busy = true
            this.errorText = TenantEmailDomainsViewModel.NoText
            this.savedText = TenantEmailDomainsViewModel.NoText
        })
        try
        {
            await action()
        }
        catch (e)
        {
            if (!this.Expired(e))
            {
                this.Change(() => { this.errorText = TenantEmailDomainsViewModel.MessageOf(e) })
            }
        }
        finally
        {
            this.Change(() => { this.busy = false })
        }
    }

    // Shows a report (none: nothing loaded): the typed text follows it unless the operator has typed, and the
    // approval rows are rebuilt.
    private Show(report: TenantEmailDomainsDto | undefined): void
    {
        this.report = report
        if (!this.dirty)
        {
            this.text = (report?.domains ?? []).join(TenantEmailDomainsViewModel.DomainSeparator)
        }
        this.approvals.Clear()
        for (const approval of report?.approvals ?? [])
        {
            this.approvals.Add(new EmailDomainApprovalRowViewModel(this, approval))
        }
    }

    // The typed text as a list; the server normalises and validates each domain.
    private Parsed(): string[]
    {
        return this.text.split(TenantEmailDomainsViewModel.DomainSplitter).filter(d => d.length > 0)
    }

    private static SameList(a: readonly string[], b: readonly string[]): boolean
    {
        return a.length === b.length && a.every((d, i) => d === b[i])
    }

    private Expired(e: unknown): boolean
    {
        if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
        {
            this.session.Expire()
            return true
        }
        return false
    }

    private static MessageOf(e: unknown): string
    {
        return e instanceof Error ? e.message : String(e)
    }

    // Applies a change, then raises each bound value it moved and re-evaluates every command.
    private Change(apply: () => void): void
    {
        const before = this.BoundValues()
        apply()
        const after = this.BoundValues()
        TenantEmailDomainsViewModel.BoundProperties.forEach((name, i) =>
        {
            if (before[i] !== after[i])
            {
                this.RaisePropertyChanged(name, before[i], after[i])
            }
        })
        this.saveCommand.RaiseCanExecuteChanged()
        for (const row of this.approvals.ToArray())
        {
            row.RaiseCommandsChanged()
        }
    }

    private BoundValues(): unknown[]
    {
        return TenantEmailDomainsViewModel.BoundProperties.map(name => Reflect.get(this, name) as unknown)
    }
}
