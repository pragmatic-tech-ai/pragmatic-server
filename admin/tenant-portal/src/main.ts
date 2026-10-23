import { Application, ThemeManager, Density } from '@pragmatic-tech-ai/mural/runtime'
import { HtmlTarget } from '@pragmatic-tech-ai/mural/visual-engine'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { TenantApp } from './tenant-app.js'

// Boots Mural into a plain browser tab: theme first, then the view tree,
// then mount on an HtmlTarget bound to the root element.
export class TenantPortalMain
{
    private static readonly RootId = 'app'
    private static readonly MissingRootMessage = 'TenantPortalMain: root element missing'

    public static Run(): void
    {
        const root = document.getElementById(TenantPortalMain.RootId)
        if (root === null)
        {
            throw new Error(TenantPortalMain.MissingRootMessage)
        }
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
        ThemeManager.Density = Density.Compact
        const target = new HtmlTarget(root)
        const shell = new TenantApp()
        target.Content = shell
        void shell.Boot()
    }
}

if (typeof document !== 'undefined')
{
    TenantPortalMain.Run()
}
