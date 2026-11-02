import { Density, ThemeManager } from '@pragmatic-tech-ai/mural/runtime'
import { HtmlTarget } from '@pragmatic-tech-ai/mural/visual-engine'

// Mounts the compiled sign-in application (login.mu) into #app.
export class IdpLoginBoot
{
    private static readonly RootId = 'app'
    private static readonly MissingRootMessage = 'IdP sign-in: #app is missing'

    public static async Run(): Promise<void>
    {
        const root = document.getElementById(IdpLoginBoot.RootId)
        if (root === null)
        {
            throw new Error(IdpLoginBoot.MissingRootMessage)
        }
        const { app } = await import('./login.mu.js')
        ThemeManager.Density = Density.Compact
        app.initialize(new HtmlTarget(root))
    }
}
