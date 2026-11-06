import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantApiError } from '../../tenant-api-client.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { DomainApprovalState, type DomainVerificationDto, type EmailDomainsDto } from '../../tenant-types.js'

// One claimed domain on the Email domains tab: its state, whether its DNS TXT record was seen and when it was last
// looked up, the record to add at the DNS provider, and a Verify button for the Owner. A domain takes effect once the
// platform operator approves it, or once it is verified and no other tenant claims it.
export class DomainVerificationRowViewModel extends Observable
{
    private static readonly ApprovedLabel = 'Approved'
    private static readonly VerifiedLabel = 'Verified'
    private static readonly VerifiedContestedLabel = 'Verified, contested - needs approval'
    private static readonly RevokedLabel = 'Revoked'
    private static readonly PendingLabel = 'Pending'
    private static readonly NotVerifiedLabel = 'Not verified'
    private static readonly LastCheckedPrefix = 'Last checked '
    private static readonly LastCheckedSuffix = ' UTC'
    private static readonly NotCheckedLabel = 'Not checked yet'
    private static readonly MinuteLength = 16
    private static readonly IsoSeparator = 'T'
    private static readonly DisplaySeparator = ' '

    private readonly verifyCommand: RelayCommand

    public constructor(private readonly owner: EmailDomainsEditorViewModel, private readonly verification: DomainVerificationDto)
    {
        super()
        this.verifyCommand = new RelayCommand(() => { void this.owner.VerifyDomain(this.verification.domain) },
            () => this.CanVerify && !this.owner.IsVerifying && !this.owner.IsSaving)
    }

    public get Domain(): string
    {
        return this.verification.domain
    }

    // The domain's state in words: Approved, Verified, Verified but contested, Revoked or Pending.
    public get StatusLabel(): string
    {
        const R = DomainVerificationRowViewModel
        switch (this.verification.state)
        {
            case DomainApprovalState.Approved:
                return R.ApprovedLabel
            case DomainApprovalState.Verified:
                return R.VerifiedLabel
            case DomainApprovalState.VerifiedContested:
                return R.VerifiedContestedLabel
            case DomainApprovalState.Revoked:
                return R.RevokedLabel
            default:
                return R.PendingLabel
        }
    }

    // 'Verified' when the TXT record was last seen, else 'Not verified'.
    public get VerificationLabel(): string
    {
        const R = DomainVerificationRowViewModel
        return this.verification.verified ? R.VerifiedLabel : R.NotVerifiedLabel
    }

    // The TXT record name to add at the DNS provider.
    public get RecordName(): string
    {
        return this.verification.recordName
    }

    // The TXT record value to add (the token in it is public by design).
    public get RecordValue(): string
    {
        return this.verification.recordValue
    }

    // 'Last checked 2026-11-06 09:30 UTC' or 'Not checked yet'.
    public get LastCheckedText(): string
    {
        const R = DomainVerificationRowViewModel
        const checked = this.verification.lastCheckedAt
        if (checked === undefined)
        {
            return R.NotCheckedLabel
        }
        return R.LastCheckedPrefix + checked.slice(0, R.MinuteLength).replace(R.IsoSeparator, R.DisplaySeparator) + R.LastCheckedSuffix
    }

    // Whether Verify is offered: only to the Owner (the profile's settings capability).
    public get CanVerify(): boolean
    {
        return this.owner.CanVerify
    }

    public get VerifyCommand(): RelayCommand
    {
        return this.verifyCommand
    }

    // Re-evaluates the Verify button after the owner's state moved.
    public RaiseCanVerifyChanged(): void
    {
        this.verifyCommand.RaiseCanExecuteChanged()
    }
}

// The Settings page's Email domains tab: the tenant Owner edits the domains whose
// people are sent to this console at sign-in. Anyone else (or a store that does not
// allow edits) sees the list read-only with one sentence saying why. Never throws:
// a refusal shows its sentence in ErrorText, a 401 expires the session.
export class EmailDomainsEditorViewModel extends Observable
{
    private static readonly DomainSeparator = ', '
    private static readonly DomainSplitter = /[\s,;]+/
    private static readonly SavedLabel = 'Saved.'
    private static readonly OwnerOnlyText = 'Only the tenant Owner can change the email domains.'
    private static readonly InHiveText = "This tenant's email domains are set in its in-hive console."
    private static readonly UnavailableText = 'Email domains are not available here.'
    private static readonly ApprovalSentence = 'A domain takes effect once the platform operator approves it, or once its DNS TXT record is verified and no other tenant claims it.'
    private static readonly PendingPrefix = 'Not in effect yet: '
    private static readonly PendingSuffix = '. '
    private static readonly NoRecordNotice = 'No matching TXT record was found yet. DNS changes can take a while to appear; try again later.'
    private static readonly NoText = ''
    // What the tab shows when no list could be read.
    private static readonly Nothing: EmailDomainsDto = { domains: [], editable: false, inHive: false, pending: [] }
    // Every bound value a change can move, raised when it did; typed so a renamed member fails typecheck.
    private static readonly BoundProperties: ReadonlyArray<keyof EmailDomainsEditorViewModel> = [
        'DomainsText', 'IsEditable', 'IsInHive', 'ApprovalText', 'ReadOnlyText', 'ErrorText', 'SavedText', 'IsSaving',
        'HasVerifications', 'VerifyNoticeText', 'IsVerifying',
    ]

    private readonly saveCommand: RelayCommand
    private readonly verifications = new ObservableCollection<DomainVerificationRowViewModel>()
    private canVerify = false
    private verifying = false
    private verifyNoticeText = ''
    private domains: readonly string[] = []
    private text = ''
    private editable = false
    private inHive = false
    private pending: readonly string[] = []
    private readOnlyText = ''
    private errorText = ''
    private savedText = ''
    private saving = false

    public constructor(private readonly session: TenantSessionService)
    {
        super()
        this.saveCommand = new RelayCommand(() => { void this.Save() }, () => this.CanSave)
    }

    // The domains as typed, comma-separated (two-way).
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
            this.savedText = EmailDomainsEditorViewModel.NoText
        })
    }

    // Whether the list can be edited here (the server's `editable`, for a caller who may change settings).
    public get IsEditable(): boolean
    {
        return this.editable
    }

    // Whether the tenant's console runs in its own hive (the server's `inHive`).
    public get IsInHive(): boolean
    {
        return this.inHive
    }

    // The not-in-effect sentence: naming the domains not in effect yet where the server knows them, else the general
    // sentence in an in-hive console; '' when every domain is in effect.
    public get ApprovalText(): string
    {
        const E = EmailDomainsEditorViewModel
        if (this.pending.length > 0)
        {
            return E.PendingPrefix + this.pending.join(E.DomainSeparator) + E.PendingSuffix + E.ApprovalSentence
        }
        return this.inHive ? E.ApprovalSentence : E.NoText
    }

    // Why the list is read-only; '' while it is editable.
    public get ReadOnlyText(): string
    {
        return this.readOnlyText
    }

    // Why the last read or save failed; '' otherwise.
    public get ErrorText(): string
    {
        return this.errorText
    }

    // 'Saved.' after a save, until the Owner types again.
    public get SavedText(): string
    {
        return this.savedText
    }

    public get IsSaving(): boolean
    {
        return this.saving
    }

    public get SaveCommand(): RelayCommand
    {
        return this.saveCommand
    }

    // One row per claimed domain with its TXT record and state; empty where the server sends none.
    public get Verifications(): ObservableCollection<DomainVerificationRowViewModel>
    {
        return this.verifications
    }

    public get HasVerifications(): boolean
    {
        return this.verifications.Count > 0
    }

    // Whether Verify is offered: the profile's settings capability (the Owner), whether or not the list itself is editable.
    public get CanVerify(): boolean
    {
        return this.canVerify
    }

    // True while a Verify is in flight.
    public get IsVerifying(): boolean
    {
        return this.verifying
    }

    // 'No matching TXT record was found yet...' after a Verify that left the domain Not verified; '' otherwise.
    public get VerifyNoticeText(): string
    {
        return this.verifyNoticeText
    }

    private get CanSave(): boolean
    {
        return this.editable && !this.saving && !this.verifying && this.IsDirty
    }

    // Whether the typed list differs from the last-saved one.
    private get IsDirty(): boolean
    {
        return !EmailDomainsEditorViewModel.SameList(this.Parsed(), this.domains)
    }

    // Shows what the server reported. `canChangeSettings` is the profile's settings capability.
    public Apply(dto: EmailDomainsDto, canChangeSettings: boolean): void
    {
        const E = EmailDomainsEditorViewModel
        this.Change(() =>
        {
            this.canVerify = canChangeSettings
            this.Show(dto)
            this.editable = dto.editable && canChangeSettings
            this.readOnlyText = this.editable ? E.NoText : canChangeSettings ? E.InHiveText : E.OwnerOnlyText
            this.errorText = E.NoText
        })
    }

    // The email-domain route is missing here (a 404): the tab stays read-only and says so.
    public ApplyUnavailable(): void
    {
        const E = EmailDomainsEditorViewModel
        this.Change(() =>
        {
            this.Show(E.Nothing)
            this.canVerify = false
            this.editable = false
            this.readOnlyText = E.UnavailableText
            this.errorText = E.NoText
        })
    }

    // The read failed for another reason: its sentence shows in this tab only, read-only.
    public ApplyFailure(message: string): void
    {
        this.Change(() =>
        {
            this.Show(EmailDomainsEditorViewModel.Nothing)
            this.canVerify = false
            this.editable = false
            this.readOnlyText = EmailDomainsEditorViewModel.NoText
            this.errorText = message
        })
    }

    // Stores the typed list. Never throws: a refusal shows its sentence in ErrorText.
    public async Save(): Promise<void>
    {
        if (!this.CanSave)
        {
            return
        }
        const list = this.Parsed()
        this.Change(() =>
        {
            this.saving = true
            this.errorText = EmailDomainsEditorViewModel.NoText
            this.savedText = EmailDomainsEditorViewModel.NoText
        })
        try
        {
            const reply = await this.session.Client.SetEmailDomains(list)
            this.Change(() =>
            {
                this.Show(reply)
                this.savedText = EmailDomainsEditorViewModel.SavedLabel
            })
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                this.session.Expire()
            }
            else
            {
                this.Change(() => { this.errorText = e instanceof Error ? e.message : String(e) })
            }
        }
        finally
        {
            this.Change(() => { this.saving = false })
        }
    }

    // Checks the domain's DNS TXT record now. Never throws: a refusal shows its sentence in ErrorText, a 401 expires the
    // session, and a domain still Not verified afterwards shows the no-record notice. Refused while a Save runs (and Save
    // while a Verify runs), so their replies cannot land out of order; text the Owner typed but has not saved stays.
    public async VerifyDomain(domain: string): Promise<void>
    {
        if (!this.canVerify || this.verifying || this.saving)
        {
            return
        }
        this.Change(() =>
        {
            this.verifying = true
            this.errorText = EmailDomainsEditorViewModel.NoText
            this.verifyNoticeText = EmailDomainsEditorViewModel.NoText
        })
        try
        {
            const reply = await this.session.Client.VerifyEmailDomain(domain)
            const row = (reply.verifications ?? []).find(v => v.domain === domain)
            this.Change(() =>
            {
                this.ShowKeepingUnsaved(reply)
                this.verifyNoticeText = row !== undefined && !row.verified ? EmailDomainsEditorViewModel.NoRecordNotice : EmailDomainsEditorViewModel.NoText
            })
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                this.session.Expire()
            }
            else
            {
                this.Change(() => { this.errorText = e instanceof Error ? e.message : String(e) })
            }
        }
        finally
        {
            this.Change(() => { this.verifying = false })
        }
    }

    // Shows a reply: the list, where the console runs, the domains not in effect yet, and each domain's TXT record.
    private Show(dto: EmailDomainsDto): void
    {
        this.domains = [...dto.domains]
        this.text = dto.domains.join(EmailDomainsEditorViewModel.DomainSeparator)
        this.inHive = dto.inHive
        this.pending = [...dto.pending]
        this.verifications.Clear()
        for (const verification of dto.verifications ?? [])
        {
            this.verifications.Add(new DomainVerificationRowViewModel(this, verification))
        }
    }

    // Shows a Verify reply: the server-owned parts (the saved list, the verifications, the pending domains and so the
    // approval text), keeping the text the Owner typed when it differs from the last-saved list.
    private ShowKeepingUnsaved(dto: EmailDomainsDto): void
    {
        const typed = this.IsDirty ? this.text : undefined
        this.Show(dto)
        if (typed !== undefined)
        {
            this.text = typed
        }
    }

    // The typed text as a list; the server normalises and validates each domain.
    private Parsed(): string[]
    {
        return this.text.split(EmailDomainsEditorViewModel.DomainSplitter).filter(d => d.length > 0)
    }

    private static SameList(a: readonly string[], b: readonly string[]): boolean
    {
        return a.length === b.length && a.every((d, i) => d === b[i])
    }

    // Applies a change, then raises each bound value it moved and re-evaluates Save.
    private Change(apply: () => void): void
    {
        const before = this.BoundValues()
        apply()
        const after = this.BoundValues()
        EmailDomainsEditorViewModel.BoundProperties.forEach((name, i) =>
        {
            if (before[i] !== after[i])
            {
                this.RaisePropertyChanged(name, before[i], after[i])
            }
        })
        this.saveCommand.RaiseCanExecuteChanged()
        this.verifications.ToArray().forEach(row => row.RaiseCanVerifyChanged())
    }

    private BoundValues(): unknown[]
    {
        return EmailDomainsEditorViewModel.BoundProperties.map(name => this[name])
    }
}
