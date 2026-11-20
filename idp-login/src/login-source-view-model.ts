import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { IPageNavigator } from './page-navigator.js'

// One upstream source's button: its label, and a command that navigates the
// whole page to the source's broker login with the authorize request appended.
export class LoginSourceViewModel extends Observable
{
    private readonly signInCommand: RelayCommand

    public constructor(public readonly Id: string, public readonly Label: string, public readonly Url: string, navigator: IPageNavigator)
    {
        super()
        this.signInCommand = new RelayCommand(() => navigator.Assign(this.Url), undefined, { Text: Label })
    }

    public get SignInCommand(): RelayCommand
    {
        return this.signInCommand
    }
}
