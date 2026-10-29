import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ManifestDto } from './portal-types.js'

// The slice of ControlPlaneClient the publish-manifest form needs.
export interface ICreateManifestSink
{
    PublishManifest(version: string, image: string, notes?: string): Promise<ManifestDto>
}

// Publish-version form submit: validation, busy flag, error message.
export class CreateManifestViewModel extends Observable
{
    public static readonly BusyProperty = 'Busy'
    public static readonly ErrorMessageProperty = 'ErrorMessage'
    private static readonly Empty = ''

    private busy = false
    private errorMessage = CreateManifestViewModel.Empty

    public constructor(private readonly sink: ICreateManifestSink)
    {
        super()
    }

    public get Busy(): boolean
    {
        return this.busy
    }

    public get ErrorMessage(): string
    {
        return this.errorMessage
    }

    public CanSubmit(version: string, image: string): boolean
    {
        return version.trim().length > 0 && image.trim().length > 0
    }

    public async Submit(version: string, image: string, notes: string): Promise<ManifestDto>
    {
        const trimmedNotes = notes.trim()
        this.SetError(CreateManifestViewModel.Empty)
        this.SetBusy(true)
        try
        {
            return await this.sink.PublishManifest(version.trim(), image.trim(), trimmedNotes.length > 0 ? trimmedNotes : undefined)
        }
        catch (e)
        {
            this.SetError(e instanceof Error ? e.message : String(e))
            throw e
        }
        finally
        {
            this.SetBusy(false)
        }
    }

    private SetBusy(value: boolean): void
    {
        const old = this.busy
        this.busy = value
        this.RaisePropertyChanged(CreateManifestViewModel.BusyProperty, old, value)
    }

    private SetError(value: string): void
    {
        const old = this.errorMessage
        this.errorMessage = value
        this.RaisePropertyChanged(CreateManifestViewModel.ErrorMessageProperty, old, value)
    }
}
