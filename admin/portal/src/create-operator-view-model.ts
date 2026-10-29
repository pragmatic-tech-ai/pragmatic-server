import { Observable } from '@pragmatic-tech-ai/todl-runtime'

// The slice of ControlPlaneClient the invite-operator form needs.
export interface ICreateOperatorSink
{
    CreateOperator(email: string, password: string, role: string): Promise<void>
}

// Invite-operator form submit: validation, busy flag, error message.
// The password is never trimmed or transformed; the server owns its rules.
export class CreateOperatorViewModel extends Observable
{
    public static readonly BusyProperty = 'Busy'
    public static readonly ErrorMessageProperty = 'ErrorMessage'
    private static readonly Empty = ''

    private busy = false
    private errorMessage = CreateOperatorViewModel.Empty

    public constructor(private readonly sink: ICreateOperatorSink)
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

    public CanSubmit(email: string, password: string, role: string): boolean
    {
        return email.trim().length > 0 && password.length > 0 && role.length > 0
    }

    public async Submit(email: string, password: string, role: string): Promise<void>
    {
        this.SetError(CreateOperatorViewModel.Empty)
        this.SetBusy(true)
        try
        {
            await this.sink.CreateOperator(email.trim(), password, role)
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
        this.RaisePropertyChanged(CreateOperatorViewModel.BusyProperty, old, value)
    }

    private SetError(value: string): void
    {
        const old = this.errorMessage
        this.errorMessage = value
        this.RaisePropertyChanged(CreateOperatorViewModel.ErrorMessageProperty, old, value)
    }
}
