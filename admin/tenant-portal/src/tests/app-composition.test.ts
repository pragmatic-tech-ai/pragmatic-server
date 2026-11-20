import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { ContentControl } from '@pragmatic-tech-ai/mural/framework/base/content-control.js'
import { Border } from '@pragmatic-tech-ai/mural/basic'
import { EditorShell } from '@pragmatic-tech-ai/mural/framework/shell/editor-shell.js'
import { NavigationService, type NavigationDestination } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { Geometry } from '@pragmatic-tech-ai/mural/visual-engine'
import { OneTimeSecretPageViewModel, SignInPageViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { app } from '../app.mu.js'
import { app as signIn } from '../sign-in.mu.js'
import { TenantSessionService } from '../shell/tenant-session-service.js'
import { TenantSignInHost } from '../shell/tenant-sign-in-host.js'

// The compiled app.mu: the sections in rail order (Configuration among them), the shared shell's views merged.
describe('app.mu composition', () =>
{
    const shell = app.Resources.Root as Visual

    it('lists the sections in rail order, each with an icon', () =>
    {
        const nav = (shell as EditorShell).Services.get(NavigationService.Key)
        assert.ok(nav !== undefined)
        const items = nav.Items.ToArray().map(i => i as NavigationDestination)
        assert.deepEqual(items.map(i => i.Label), ['Overview', 'Environments', 'Users & Access', 'Releases', 'Settings', 'Configuration', 'Connection status'])
        for (const item of items)
        {
            assert.ok(item.Icon instanceof Geometry, item.Label + ' has no icon')
        }
    })

    it('registers the session and merges the shell views', () =>
    {
        assert.ok(app.Services.get(TenantSessionService.Key) instanceof TenantSessionService)
        assert.ok(app.Resources.Get(OneTimeSecretPageViewModel) !== undefined)
        assert.ok(app.Resources.Get(TenantSessionService) !== undefined, 'the console keeps its own header')
    })
})

// The compiled sign-in.mu: the shell's sign-in page over the console's host, OIDC only.
describe('sign-in.mu composition', () =>
{
    it('registers the sign-in host and presents its page through the shell view', () =>
    {
        const host = signIn.Services.getRequired(TenantSignInHost.Key)
        assert.ok(host.Page instanceof SignInPageViewModel)
        assert.equal(host.Page.OffersOidc, true)
        assert.equal(host.Page.OffersPassword, false)
        assert.ok(signIn.Resources.Get(SignInPageViewModel) !== undefined)
        assert.ok(signIn.Resources.Root instanceof Border)
        assert.ok((signIn.Resources.Root as Border).ContentChild instanceof ContentControl, 'a root ContentControl would render empty')
    })
})
