import { Observable } from '@pragmatic-tech-ai/todl-runtime'

// One ComboBox choice: a value and the text shown for it (the ComboBox
// displays an item's Label by convention).
export class OptionViewModel<T> extends Observable
{
    public constructor(public readonly Value: T, private readonly label: string)
    {
        super()
    }

    public get Label(): string
    {
        return this.label
    }
}
