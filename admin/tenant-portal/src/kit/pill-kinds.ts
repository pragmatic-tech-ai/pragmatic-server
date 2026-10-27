import { KitGlyph } from './icon-catalog.js'
import { PillTone } from './tones.js'

export enum PillKind
{
    Connected = 'connected',
    Quiet = 'quiet',
    Never = 'never',
    Awaiting = 'awaiting',
    Disconnected = 'disconnected',
    Healthy = 'healthy',
    Degraded = 'degraded',
    Failing = 'failing',
    Unknown = 'unknown',
    Running = 'running',
    Stopped = 'stopped',
    Provisioning = 'provisioning',
    Starting = 'starting',
    Stopping = 'stopping',
    Restarting = 'restarting',
    Deleting = 'deleting',
    Rolling = 'rolling',
    Signed = 'signed',
    Signing = 'signing',
    Published = 'published',
    Withdrawn = 'withdrawn',
    Draft = 'draft',
    Adopted = 'adopted',
    Gated = 'gated',
    Rollfailed = 'rollfailed',
    Verifyfailed = 'verifyfailed',
    Pending = 'pending',
    Updated = 'updated',
    Failed = 'failed',
    Paused = 'paused',
    Active = 'active',
    Revoked = 'revoked',
    Rotating = 'rotating',
    Expired = 'expired',
    Disabled = 'disabled',
    Invited = 'invited',
    Observed = 'observed',
    Offered = 'offered',
    Current = 'current',
    Allowed = 'allowed',
    Blocked = 'blocked',
    Held = 'held',
}

export interface PillEntry
{
    readonly tone: PillTone
    readonly glyph: KitGlyph
    readonly label: string
}

// Status-pill vocabulary: kind -> tone, glyph, label (from the admin-apps design PILLS table).
export class PillKinds
{
    private static readonly Registry: ReadonlyMap<PillKind, PillEntry> = new Map<PillKind, PillEntry>([
        [PillKind.Connected, { tone: PillTone.Success, glyph: KitGlyph.RadioTower, label: 'Connected' }],
        [PillKind.Quiet, { tone: PillTone.Warning, glyph: KitGlyph.WifiOff, label: 'Quiet' }],
        [PillKind.Never, { tone: PillTone.Neutral, glyph: KitGlyph.CircleDashed, label: 'Never dialled in' }],
        [PillKind.Awaiting, { tone: PillTone.Info, glyph: KitGlyph.Hourglass, label: 'Awaiting first dial-in' }],
        [PillKind.Disconnected, { tone: PillTone.Danger, glyph: KitGlyph.Ban, label: 'Disconnected' }],
        [PillKind.Healthy, { tone: PillTone.Success, glyph: KitGlyph.CircleCheck, label: 'Healthy' }],
        [PillKind.Degraded, { tone: PillTone.Warning, glyph: KitGlyph.TriangleAlert, label: 'Degraded' }],
        [PillKind.Failing, { tone: PillTone.Danger, glyph: KitGlyph.CircleAlert, label: 'Failing' }],
        [PillKind.Unknown, { tone: PillTone.Neutral, glyph: KitGlyph.CircleDashed, label: 'Unknown' }],
        [PillKind.Running, { tone: PillTone.Success, glyph: KitGlyph.Play, label: 'Running' }],
        [PillKind.Stopped, { tone: PillTone.Neutral, glyph: KitGlyph.Square, label: 'Stopped' }],
        [PillKind.Provisioning, { tone: PillTone.Info, glyph: KitGlyph.Hourglass, label: 'Provisioning' }],
        [PillKind.Starting, { tone: PillTone.Info, glyph: KitGlyph.Hourglass, label: 'Starting' }],
        [PillKind.Stopping, { tone: PillTone.Info, glyph: KitGlyph.Hourglass, label: 'Stopping' }],
        [PillKind.Restarting, { tone: PillTone.Info, glyph: KitGlyph.RefreshCw, label: 'Restarting' }],
        [PillKind.Deleting, { tone: PillTone.Info, glyph: KitGlyph.Hourglass, label: 'Deleting' }],
        [PillKind.Rolling, { tone: PillTone.Info, glyph: KitGlyph.RefreshCw, label: 'Rolling out' }],
        [PillKind.Signed, { tone: PillTone.Success, glyph: KitGlyph.ShieldCheck, label: 'Signed' }],
        [PillKind.Signing, { tone: PillTone.Info, glyph: KitGlyph.Hourglass, label: 'Signing' }],
        [PillKind.Published, { tone: PillTone.Success, glyph: KitGlyph.CircleCheck, label: 'Published' }],
        [PillKind.Withdrawn, { tone: PillTone.Danger, glyph: KitGlyph.Ban, label: 'Withdrawn' }],
        [PillKind.Draft, { tone: PillTone.Neutral, glyph: KitGlyph.CircleDashed, label: 'Draft' }],
        [PillKind.Adopted, { tone: PillTone.Success, glyph: KitGlyph.CircleCheck, label: 'Adopted' }],
        [PillKind.Gated, { tone: PillTone.Warning, glyph: KitGlyph.Shield, label: 'Gated out' }],
        [PillKind.Rollfailed, { tone: PillTone.Danger, glyph: KitGlyph.CircleX, label: 'Roll failed' }],
        [PillKind.Verifyfailed, { tone: PillTone.Danger, glyph: KitGlyph.Shield, label: 'Verification failed' }],
        [PillKind.Pending, { tone: PillTone.Info, glyph: KitGlyph.Hourglass, label: 'Pending check-in' }],
        [PillKind.Updated, { tone: PillTone.Success, glyph: KitGlyph.CircleCheck, label: 'Updated' }],
        [PillKind.Failed, { tone: PillTone.Danger, glyph: KitGlyph.CircleX, label: 'Failed' }],
        [PillKind.Paused, { tone: PillTone.Warning, glyph: KitGlyph.CirclePause, label: 'Paused' }],
        [PillKind.Active, { tone: PillTone.Success, glyph: KitGlyph.CircleCheck, label: 'Active' }],
        [PillKind.Revoked, { tone: PillTone.Danger, glyph: KitGlyph.Ban, label: 'Revoked' }],
        [PillKind.Rotating, { tone: PillTone.Info, glyph: KitGlyph.RefreshCw, label: 'Rotation pending' }],
        [PillKind.Expired, { tone: PillTone.Warning, glyph: KitGlyph.Clock, label: 'Expired' }],
        [PillKind.Disabled, { tone: PillTone.Neutral, glyph: KitGlyph.UserX, label: 'Disabled' }],
        [PillKind.Invited, { tone: PillTone.Info, glyph: KitGlyph.Clock, label: 'Invited' }],
        [PillKind.Observed, { tone: PillTone.Neutral, glyph: KitGlyph.Eye, label: 'Observed \u2014 read-only' }],
        [PillKind.Offered, { tone: PillTone.Info, glyph: KitGlyph.Package, label: 'Offered' }],
        [PillKind.Current, { tone: PillTone.Success, glyph: KitGlyph.CircleCheck, label: 'Current' }],
        [PillKind.Allowed, { tone: PillTone.Success, glyph: KitGlyph.CircleCheck, label: 'Allowed' }],
        [PillKind.Blocked, { tone: PillTone.Danger, glyph: KitGlyph.Ban, label: 'Blocked' }],
        [PillKind.Held, { tone: PillTone.Warning, glyph: KitGlyph.CirclePause, label: 'On hold' }],
    ])

    public static Entry(kind: PillKind): PillEntry
    {
        return PillKinds.Registry.get(kind) ?? { tone: PillTone.Neutral, glyph: KitGlyph.CircleDashed, label: String(kind) }
    }
}
