import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Key, type KeyEventArgs } from '@pragmatic-tech-ai/mural/runtime'

// Button that is a keyboard Tab stop and runs one activation path for pointer click AND Enter/Space.
// Mural's Button runs its pointer click handlers only on a pointer press and never on the keyboard,
// and is not focusable by default, so portal buttons that must be reachable derive from this.
export class KeyActivatedButton extends Button
{
    private readonly onActivate: (() => void) | undefined

    public constructor(onActivate?: () => void)
    {
        super()
        this.onActivate = onActivate
        this.Focusable = true
        this.AddClickHandler(() => this.Activate())
    }

    // Public activation: runs the same path a pointer click or Enter/Space uses (subclass gates apply).
    public Press(): void
    {
        this.Activate()
    }

    // The single activation path (pointer click and keyboard); subclasses may override.
    protected Activate(): void
    {
        this.onActivate?.()
    }

    protected override OnKeyDown(args: KeyEventArgs): void
    {
        super.OnKeyDown(args)
        if (args.Key === Key.Space || args.Key === Key.Return)
        {
            this.Activate()
        }
    }
}
