import { KitGlyph, ScreenHost } from './kit/index.js'
import type { EmptyStateConfig } from './kit/index.js'
import { TenantViewBase } from './tenant-view-base.js'

// Placeholder for screens that arrive in a later release (Overview, Releases, Settings, Connection status).
export class ComingSoonView extends TenantViewBase
{
    public static readonly BodyText = 'This screen arrives in a later release.'

    private readonly host: ScreenHost

    public constructor(title: string)
    {
        super()
        const empty: EmptyStateConfig = { glyph: KitGlyph.CircleDashed, title, body: ComingSoonView.BodyText }
        this.host = new ScreenHost({ loading: false, allowed: true, isEmpty: true, error: false, empty })
        this.AddChild(this.host)
    }

    // Test seam: the kit screen host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    public Refresh(): void
    {
    }

    public Dispose(): void
    {
    }
}
