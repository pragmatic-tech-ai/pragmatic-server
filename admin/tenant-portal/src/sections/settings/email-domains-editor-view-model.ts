import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantApiError } from '../../tenant-api-client.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import type { EmailDomainsDto } from '../../tenant-types.js'

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
    private static readonly NoText = ''
    // Every bound value a change can move, raised when it did.
    private static readonly BoundProperties: readonly string[] = [
        'DomainsText', 'IsEditable', 'ReadOnlyText', 'ErrorText', 'SavedText', 'IsSaving',
    ]

    private readonly saveCommand: RelayCommand
    private domains: readonly string[] = []
    private text = ''
    private editable = false
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

    private get CanSave(): boolean
    {
        return this.editable && !this.saving && !EmailDomainsEditorViewModel.SameList(this.Parsed(), this.domains)
    }

    // Shows what the server reported. `canChangeSettings` is the profile's settings capability.
    public Apply(dto: EmailDomainsDto, canChangeSettings: boolean): void
    {
        const E = EmailDomainsEditorViewModel
        this.Change(() =>
        {
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
            this.Show({ domains: [], editable: false })
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
            this.Show({ domains: [], editable: false })
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

    private Show(dto: EmailDomainsDto): void
    {
        this.domains = [...dto.domains]
        this.text = dto.domains.join(EmailDomainsEditorViewModel.DomainSeparator)
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
    }

    private BoundValues(): unknown[]
    {
        return EmailDomainsEditorViewModel.BoundProperties.map(name => Reflect.get(this, name) as unknown)
    }
}
