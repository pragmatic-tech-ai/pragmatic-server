import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvironmentTone, type EnvironmentRow } from '../../environment-row.js'

// A status or health pill: its text and the tone it is drawn in. Rendered by
// its implicit-by-type template (environments.resources.mu) through a
// ContentControl, so every table, card and header draws pills the same way.
export class EnvironmentPillViewModel extends Observable
{
    public constructor(private readonly label: string, private readonly tone: EnvironmentTone)
    {
        super()
    }

    public static Status(row: EnvironmentRow): EnvironmentPillViewModel
    {
        return new EnvironmentPillViewModel(row.StatusLabel, row.StatusTone)
    }

    public static Health(row: EnvironmentRow): EnvironmentPillViewModel
    {
        return new EnvironmentPillViewModel(row.HealthLabel, row.HealthTone)
    }

    public get Label(): string
    {
        return this.label
    }

    public get IsSuccess(): boolean
    {
        return this.tone === EnvironmentTone.Success
    }

    public get IsWarning(): boolean
    {
        return this.tone === EnvironmentTone.Warning
    }

    public get IsDanger(): boolean
    {
        return this.tone === EnvironmentTone.Danger
    }

    public get IsNeutral(): boolean
    {
        return this.tone === EnvironmentTone.Neutral
    }
}
