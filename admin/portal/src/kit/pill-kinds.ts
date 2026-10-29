import { KitGlyph } from './icon-catalog.js'
import { PillTone } from './tones.js'

export enum PillKind
{
    Connected = 'connected',
    Quiet = 'quiet',
    Awaiting = 'awaiting',
    Disconnected = 'disconnected',
    Healthy = 'healthy',
    Degraded = 'degraded',
    Failing = 'failing',
    Unknown = 'unknown',
    Published = 'published',
    Signing = 'signing',
    Withdrawn = 'withdrawn',
    Held = 'held',
    Rolling = 'rolling',
    Paused = 'paused',
    Updated = 'updated',
    Pending = 'pending',
    Failed = 'failed',
    Observed = 'observed',
    Stable = 'stable',
    EarlyAccess = 'early-access',
    Signed = 'signed',
    Unsigned = 'unsigned',
}

export interface PillEntry
{
    readonly glyph: KitGlyph
    readonly label: string
    readonly tone: PillTone
}

// Status-pill vocabulary for the Platform Admin: kind -> glyph, label, tone.
export class PillKinds
{
    private static readonly MissingKindMessage = 'PillKinds: no registry entry for kind: '
    private static readonly LabelConnected = 'Connected'
    private static readonly LabelQuiet = 'Quiet'
    private static readonly LabelAwaiting = 'Awaiting first dial-in'
    private static readonly LabelDisconnected = 'Disconnected'
    private static readonly LabelHealthy = 'Healthy'
    private static readonly LabelDegraded = 'Degraded'
    private static readonly LabelFailing = 'Failing'
    private static readonly LabelUnknown = 'Unknown'
    private static readonly LabelPublished = 'Published'
    private static readonly LabelSigning = 'Signing'
    private static readonly LabelWithdrawn = 'Withdrawn'
    private static readonly LabelHeld = 'Held'
    private static readonly LabelRolling = 'Rolling'
    private static readonly LabelPaused = 'Paused'
    private static readonly LabelUpdated = 'Updated'
    private static readonly LabelPending = 'Pending'
    private static readonly LabelFailed = 'Failed'
    private static readonly LabelObserved = 'Observed'
    private static readonly LabelStable = 'Stable'
    private static readonly LabelEarlyAccess = 'Early access'
    private static readonly LabelSigned = 'Signed'
    private static readonly LabelUnsigned = 'Unsigned'

    private static readonly Registry: ReadonlyMap<PillKind, PillEntry> = new Map<PillKind, PillEntry>([
        [PillKind.Connected, { glyph: KitGlyph.RadioTower, label: PillKinds.LabelConnected, tone: PillTone.Success }],
        [PillKind.Quiet, { glyph: KitGlyph.WifiOff, label: PillKinds.LabelQuiet, tone: PillTone.Warning }],
        [PillKind.Awaiting, { glyph: KitGlyph.Hourglass, label: PillKinds.LabelAwaiting, tone: PillTone.Info }],
        [PillKind.Disconnected, { glyph: KitGlyph.Ban, label: PillKinds.LabelDisconnected, tone: PillTone.Danger }],
        [PillKind.Healthy, { glyph: KitGlyph.CircleCheck, label: PillKinds.LabelHealthy, tone: PillTone.Success }],
        [PillKind.Degraded, { glyph: KitGlyph.TriangleAlert, label: PillKinds.LabelDegraded, tone: PillTone.Warning }],
        [PillKind.Failing, { glyph: KitGlyph.CircleAlert, label: PillKinds.LabelFailing, tone: PillTone.Danger }],
        [PillKind.Unknown, { glyph: KitGlyph.CircleDashed, label: PillKinds.LabelUnknown, tone: PillTone.Neutral }],
        [PillKind.Published, { glyph: KitGlyph.CircleCheck, label: PillKinds.LabelPublished, tone: PillTone.Success }],
        [PillKind.Signing, { glyph: KitGlyph.Hourglass, label: PillKinds.LabelSigning, tone: PillTone.Info }],
        [PillKind.Withdrawn, { glyph: KitGlyph.Ban, label: PillKinds.LabelWithdrawn, tone: PillTone.Danger }],
        [PillKind.Held, { glyph: KitGlyph.CirclePause, label: PillKinds.LabelHeld, tone: PillTone.Warning }],
        [PillKind.Rolling, { glyph: KitGlyph.RefreshCw, label: PillKinds.LabelRolling, tone: PillTone.Info }],
        [PillKind.Paused, { glyph: KitGlyph.CirclePause, label: PillKinds.LabelPaused, tone: PillTone.Warning }],
        [PillKind.Updated, { glyph: KitGlyph.CircleCheck, label: PillKinds.LabelUpdated, tone: PillTone.Success }],
        [PillKind.Pending, { glyph: KitGlyph.Hourglass, label: PillKinds.LabelPending, tone: PillTone.Info }],
        [PillKind.Failed, { glyph: KitGlyph.CircleX, label: PillKinds.LabelFailed, tone: PillTone.Danger }],
        [PillKind.Observed, { glyph: KitGlyph.Eye, label: PillKinds.LabelObserved, tone: PillTone.Neutral }],
        [PillKind.Stable, { glyph: KitGlyph.CircleCheck, label: PillKinds.LabelStable, tone: PillTone.Neutral }],
        [PillKind.EarlyAccess, { glyph: KitGlyph.CircleDashed, label: PillKinds.LabelEarlyAccess, tone: PillTone.Info }],
        [PillKind.Signed, { glyph: KitGlyph.Shield, label: PillKinds.LabelSigned, tone: PillTone.Success }],
        [PillKind.Unsigned, { glyph: KitGlyph.TriangleAlert, label: PillKinds.LabelUnsigned, tone: PillTone.Warning }],
    ])

    public static For(kind: PillKind): PillEntry
    {
        const entry = PillKinds.Registry.get(kind)
        if (entry === undefined)
        {
            throw new Error(PillKinds.MissingKindMessage + String(kind))
        }
        return entry
    }
}
