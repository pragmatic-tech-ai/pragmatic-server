import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'

// A row of tabs shown as a SegmentedButton over their labels: the labels,
// the selected label (two-way with the SegmentedButton) and the tab it maps to.
export class TabSelection<T>
{
    public readonly Labels = new ObservableCollection<string>()
    private current: T

    public constructor(private readonly entries: ReadonlyArray<readonly [T, string]>)
    {
        for (const [, label] of entries)
        {
            this.Labels.Add(label)
        }
        this.current = entries[0][0]
    }

    public get Current(): T
    {
        return this.current
    }

    public get Label(): string
    {
        return this.entries.find(e => e[0] === this.current)?.[1] ?? this.entries[0][1]
    }

    // Selects the tab labelled `label`; true when the selection changed. An
    // unknown label (or none: a SegmentedButton clearing) is ignored.
    public Select(label: unknown): boolean
    {
        const entry = this.entries.find(e => e[1] === label)
        if (entry === undefined || entry[0] === this.current)
        {
            return false
        }
        this.current = entry[0]
        return true
    }

    public Is(tab: T): boolean
    {
        return this.current === tab
    }
}
