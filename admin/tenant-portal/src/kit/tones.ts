import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Brush } from '@pragmatic-tech-ai/mural/visual-engine'

export enum PillTone
{
    Success,
    Warning,
    Danger,
    Info,
    Neutral,
}

// Resolves a PillTone to the active Pragmatic theme's brush resources (no hex literals).
export class Tones
{
    // Neutral has no state token: it uses the muted/secondary foreground (Fg2) and the hovered surface (Bg2).
    private static readonly Keys: Readonly<Record<PillTone, string>> = {
        [PillTone.Success]: 'StateSuccess',
        [PillTone.Warning]: 'StateWarning',
        [PillTone.Danger]: 'StateDanger',
        [PillTone.Info]: 'StateInfo',
        [PillTone.Neutral]: 'Fg2',
    }

    private static readonly SoftKeys: Readonly<Record<PillTone, string>> = {
        [PillTone.Success]: 'StateSuccessSoft',
        [PillTone.Warning]: 'StateWarningSoft',
        [PillTone.Danger]: 'StateDangerSoft',
        [PillTone.Info]: 'StateInfoSoft',
        [PillTone.Neutral]: 'Bg2',
    }

    public static Brush(tone: PillTone): Brush
    {
        return Application.ResolveDefaultResource<Brush>(Tones.Keys[tone]) as Brush
    }

    public static SoftBrush(tone: PillTone): Brush
    {
        return Application.ResolveDefaultResource<Brush>(Tones.SoftKeys[tone]) as Brush
    }
}
