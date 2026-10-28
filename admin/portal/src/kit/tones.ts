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

    public static readonly MissingBrushMessage = 'Tones: theme brush resource not found: '

    private static readonly SoftKeys: Readonly<Record<PillTone, string>> = {
        [PillTone.Success]: 'StateSuccessSoft',
        [PillTone.Warning]: 'StateWarningSoft',
        [PillTone.Danger]: 'StateDangerSoft',
        [PillTone.Info]: 'StateInfoSoft',
        [PillTone.Neutral]: 'Bg2',
    }

    public static Brush(tone: PillTone): Brush
    {
        return Tones.Resolve(Tones.Keys[tone])
    }

    public static SoftBrush(tone: PillTone): Brush
    {
        return Tones.Resolve(Tones.SoftKeys[tone])
    }

    private static Resolve(key: string): Brush
    {
        const brush = Application.ResolveDefaultResource<Brush>(key)
        if (brush === undefined)
        {
            throw new Error(Tones.MissingBrushMessage + key)
        }
        return brush
    }
}
