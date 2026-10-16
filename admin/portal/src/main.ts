import { Application, ThemeManager, Density } from '@pragmatic-tech-ai/mural/runtime'
import { HtmlTarget } from '@pragmatic-tech-ai/mural/visual-engine'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { SpikeView } from './spike-view.js'

// Boots Mural into a plain browser tab: theme first, then the view tree,
// then mount on an HtmlTarget bound to the root element.
export class PortalMain
{
    private static readonly RootId = 'app'

    public static Run(): void
    {
        const root = document.getElementById(PortalMain.RootId)
        if (root === null)
        {
            throw new Error('PortalMain: root element missing')
        }
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
        ThemeManager.Density = Density.Compact
        const target = new HtmlTarget(root)
        target.Content = new SpikeView()
    }
}

PortalMain.Run()
