import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import { PageHeader } from './kit/page-header.js'
import { ScreenHost } from './kit/screen-host.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'

// Placeholder for a section whose screen has not shipped: page header over an empty-state body.
export class ComingSoonView extends StackPanel implements IPortalView
{
    public static readonly ComingSoonText = 'This screen arrives in a later release.'

    private readonly header: PageHeader
    private readonly host: ScreenHost

    public constructor(breadcrumb: readonly string[], title: string, sub?: string)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.header = new PageHeader({ breadcrumb, title, sub })
        this.host = new ScreenHost({
            loading: false,
            allowed: true,
            error: false,
            isEmpty: true,
            empty: { title: ComingSoonView.ComingSoonText },
        })
        this.AddChild(this.header)
        this.AddChild(this.host)
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the page header.
    public get Header(): PageHeader
    {
        return this.header
    }

    public AttachNavigator(_nav: IPortalNavigator): void
    {
    }

    public Refresh(): Promise<void>
    {
        return Promise.resolve()
    }
}
