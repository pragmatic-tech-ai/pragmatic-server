import { Button } from '@pragmatic-tech-ai/mural/framework'
import type { RelayCommand, Visual } from '@pragmatic-tech-ai/mural/runtime'

// Shared dialog helpers. Mural's Button gates clicks on CanExecute but does not
// dim itself, so dialogs locate the rendered button for a command and mirror state.
export class DialogButtons
{
    public static FindByCommand(root: Visual, command: RelayCommand): Button | undefined
    {
        if (root instanceof Button && root.Command === command)
        {
            return root
        }
        for (const child of (root as unknown as { visualChildren?: readonly Visual[] }).visualChildren ?? [])
        {
            const found = DialogButtons.FindByCommand(child, command)
            if (found !== undefined)
            {
                return found
            }
        }
        return undefined
    }
}
