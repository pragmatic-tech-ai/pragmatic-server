import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../tenant-api-client.js'
import type { ConfigurationValidationErrorDto } from '../../tenant-types.js'
import { ConfigurationErrorRowViewModel, ConfigurationText } from './configuration-rows.js'

// A new version in the making: the document as JSON text, started from the version it is based on (the head when it
// was loaded), and a comment. The text must parse as a JSON object before it can be saved. What the server refused
// shows here: a 422's validation errors by path (until the next edit), or a 409's "the head moved" (until the editor
// is started again from the new head). Secret settings hold secret references, never values: the server refuses a
// literal, and the form never asks for one.
export class ConfigurationEditorViewModel extends Observable
{
    private static readonly TextProperty = 'Text'
    private static readonly CommentProperty = 'Comment'
    private static readonly BasedOnProperty = 'BasedOn'
    private static readonly BasedOnTextProperty = 'BasedOnText'
    private static readonly ParseErrorTextProperty = 'ParseErrorText'
    private static readonly IsDirtyProperty = 'IsDirty'
    private static readonly ErrorRowsProperty = 'ErrorRows'
    private static readonly HasErrorsProperty = 'HasErrors'
    private static readonly ConflictTextProperty = 'ConflictText'
    private static readonly HasConflictProperty = 'HasConflict'
    private static readonly NotJsonText = 'This is not valid JSON yet.'
    private static readonly NotObjectText = 'The document must be a JSON object.'
    private static readonly FirstVersionText = 'The first version.'
    private static readonly BasedOnPrefix = 'Based on version '
    private static readonly SentenceEnd = '.'
    private static readonly ConflictPrefix = 'Someone saved version '
    private static readonly ConflictSuffix = ' while you were editing. Start again from it to keep both changes.'
    private static readonly ConflictUnknown = 'Someone saved a newer version while you were editing. Start again from it to keep both changes.'
    private static readonly ErrorsField = 'errors'
    private static readonly HeadField = 'head'
    private static readonly UnprocessableStatus = 422
    private static readonly EmptyDocument = {}
    private static readonly NoText = ''

    private text = ConfigurationText.Document(ConfigurationEditorViewModel.EmptyDocument)
    private baseline = this.text
    private comment = ConfigurationEditorViewModel.NoText
    private basedOn = 0
    private errorRows = new ObservableCollection<ConfigurationErrorRowViewModel>()
    private conflictText = ConfigurationEditorViewModel.NoText

    public get Text(): string
    {
        return this.text
    }

    public set Text(next: string)
    {
        if (next === this.text)
        {
            return
        }
        const before = [this.ParseErrorText, this.IsDirty] as const
        const old = this.text
        this.text = next
        this.RaisePropertyChanged(ConfigurationEditorViewModel.TextProperty, old, next)
        this.RaiseIfChanged(ConfigurationEditorViewModel.ParseErrorTextProperty, before[0], this.ParseErrorText)
        this.RaiseIfChanged(ConfigurationEditorViewModel.IsDirtyProperty, before[1], this.IsDirty)
        this.SetErrors([])
    }

    public get Comment(): string
    {
        return this.comment
    }

    public set Comment(next: string)
    {
        const old = this.comment
        if (old === next)
        {
            return
        }
        this.comment = next
        this.RaisePropertyChanged(ConfigurationEditorViewModel.CommentProperty, old, next)
    }

    // The version the edit started from (0: none yet); a save is based on it.
    public get BasedOn(): number
    {
        return this.basedOn
    }

    public get BasedOnText(): string
    {
        return this.basedOn === 0
            ? ConfigurationEditorViewModel.FirstVersionText
            : ConfigurationEditorViewModel.BasedOnPrefix + String(this.basedOn) + ConfigurationEditorViewModel.SentenceEnd
    }

    // The parsed document; undefined while the text is not a JSON object.
    public get Document(): Record<string, unknown> | undefined
    {
        const parsed = ConfigurationEditorViewModel.Parse(this.text)
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    }

    // Why the text cannot be saved as it is; '' when it parses as a JSON object.
    public get ParseErrorText(): string
    {
        const parsed = ConfigurationEditorViewModel.Parse(this.text)
        if (parsed === undefined)
        {
            return ConfigurationEditorViewModel.NotJsonText
        }
        return this.Document === undefined ? ConfigurationEditorViewModel.NotObjectText : ConfigurationEditorViewModel.NoText
    }

    public get IsDirty(): boolean
    {
        return this.text !== this.baseline
    }

    // Whether there is something to save: an edited JSON object.
    public get CanSave(): boolean
    {
        return this.IsDirty && this.Document !== undefined
    }

    // The server's validation errors for the last save, by path.
    public get ErrorRows(): ObservableCollection<ConfigurationErrorRowViewModel>
    {
        return this.errorRows
    }

    public get HasErrors(): boolean
    {
        return this.errorRows.Count > 0
    }

    // Set when the head moved under the edit (409); '' otherwise.
    public get ConflictText(): string
    {
        return this.conflictText
    }

    public get HasConflict(): boolean
    {
        return this.conflictText.length > 0
    }

    // Starts the editor from `document`, the content of version `basedOn` (0 and an empty object for the first).
    public Reset(basedOn: number, document: unknown): void
    {
        const before = [this.BasedOn, this.BasedOnText] as const
        this.basedOn = basedOn
        this.baseline = ConfigurationText.Document(document)
        const wasDirty = this.IsDirty
        this.Text = this.baseline
        this.Comment = ConfigurationEditorViewModel.NoText
        this.RaiseIfChanged(ConfigurationEditorViewModel.BasedOnProperty, before[0], this.BasedOn)
        this.RaiseIfChanged(ConfigurationEditorViewModel.BasedOnTextProperty, before[1], this.BasedOnText)
        this.RaiseIfChanged(ConfigurationEditorViewModel.IsDirtyProperty, wasDirty, this.IsDirty)
        this.SetErrors([])
        this.SetConflict(ConfigurationEditorViewModel.NoText)
    }

    // Shows what the server said about a refused save: true for a 422 (validation errors) or a 409 (the head moved),
    // false for anything else (the page reports it).
    public ShowRefusal(error: unknown): boolean
    {
        if (ApiError.Is(error, ConfigurationEditorViewModel.UnprocessableStatus))
        {
            this.SetErrors(ConfigurationEditorViewModel.ErrorsOf((error as ApiError).Body))
            return true
        }
        if (ApiError.Is(error, ApiError.ConflictStatus))
        {
            const head = (error as ApiError).Body?.[ConfigurationEditorViewModel.HeadField]
            this.SetConflict(typeof head === 'number'
                ? ConfigurationEditorViewModel.ConflictPrefix + String(head) + ConfigurationEditorViewModel.ConflictSuffix
                : ConfigurationEditorViewModel.ConflictUnknown)
            return true
        }
        return false
    }

    private static Parse(text: string): unknown
    {
        try
        {
            return JSON.parse(text)
        }
        catch
        {
            return undefined
        }
    }

    private static ErrorsOf(body: Readonly<Record<string, unknown>> | undefined): ConfigurationValidationErrorDto[]
    {
        const errors = body?.[ConfigurationEditorViewModel.ErrorsField]
        if (!Array.isArray(errors))
        {
            return []
        }
        return errors.filter((e): e is ConfigurationValidationErrorDto =>
            typeof e === 'object' && e !== null && typeof (e as ConfigurationValidationErrorDto).path === 'string'
            && typeof (e as ConfigurationValidationErrorDto).message === 'string')
    }

    private SetErrors(errors: readonly ConfigurationValidationErrorDto[]): void
    {
        if (errors.length === 0 && this.errorRows.Count === 0)
        {
            return
        }
        const before = this.HasErrors
        const old = this.errorRows
        this.errorRows = new ObservableCollection<ConfigurationErrorRowViewModel>()
        for (const error of errors)
        {
            this.errorRows.Add(new ConfigurationErrorRowViewModel(error))
        }
        this.RaisePropertyChanged(ConfigurationEditorViewModel.ErrorRowsProperty, old, this.errorRows)
        this.RaiseIfChanged(ConfigurationEditorViewModel.HasErrorsProperty, before, this.HasErrors)
    }

    private SetConflict(next: string): void
    {
        const before = this.HasConflict
        const old = this.conflictText
        this.conflictText = next
        this.RaiseIfChanged(ConfigurationEditorViewModel.ConflictTextProperty, old, next)
        this.RaiseIfChanged(ConfigurationEditorViewModel.HasConflictProperty, before, this.HasConflict)
    }

    private RaiseIfChanged<T>(name: string, old: T, next: T): void
    {
        if (old !== next)
        {
            this.RaisePropertyChanged(name, old, next)
        }
    }
}
