import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application, NoModifiers } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { TreeView, TreeViewItem } from '@pragmatic-tech-ai/mural/framework'
import { TenantTreeView } from '../src/tenant-tree-view.js'
import { TenantTreeViewModel } from '../src/tenant-tree-view-model.js'
import type { ITreeSource } from '../src/tenant-tree-view-model.js'
import { EnvStatus, EnvType, Template, TenantEventType } from '../src/tenant-types.js'
import type { EnvironmentDto, HiveDto, ITenantNavigator } from '../src/tenant-types.js'

class Src implements ITreeSource
{
    public async ListHives(): Promise<HiveDto[]>
    {
        return ['h1', 'h2'].map(id => ({ id, tenantId: 't', displayName: id, cluster: { backend: 'd', mode: 'm' }, registry: { mode: 'l' }, createdAt: '' }))
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return [{ name: 'e1', template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'e1', hiveId: 'h1', hostPort: 1, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }]
    }
}

class Nav implements ITenantNavigator
{
    public Hive = 0
    public Env = 0
    public ShowLogin(): void {}
    public ShowTree(): void {}
    public ShowHiveDetail(): void { this.Hive++ }
    public ShowEnvironmentDetail(): void { this.Env++ }
    public ShowUsersAccess(): void {}
    public ShowServiceTokens(): void {}
    public ShowRolesPrivileges(): void {}
    public ShowFieldSecurity(): void {}
    public ShowSection(_section: unknown): void {}
    public get Profile(): undefined { return undefined }
    public get Capabilities(): undefined { return undefined }
    public get OwnerContact(): undefined { return undefined }
}

describe('TenantTreeView', () =>
{
    it('keeps collapsed hives and the selection across a live rebuild without re-navigating', async () =>
    {
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
        const vm = new TenantTreeViewModel(new Src())
        const view = new TenantTreeView(vm)
        const nav = new Nav()
        view.AttachNavigator(nav)
        await view.Refresh()
        const items = (): TreeViewItem[] =>
        {
            const tree = [...view.Children].find(c => c instanceof TreeView) as TreeView
            return [...tree.RootItems]
        }
        const [h1, h2] = items()
        assert.ok(h1!.IsExpanded && h2!.IsExpanded)
        h2!.IsExpanded = false
        const tree = [...view.Children].find(c => c instanceof TreeView) as TreeView
        tree.HandleRowClick(h1!.SubItems[0]!, NoModifiers)
        assert.equal(nav.Env, 1)
        await view.ApplyEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'e1' })
        await new Promise(r => setTimeout(r, 0))
        const [n1, n2] = items()
        assert.notEqual(n1, h1)
        assert.equal(n1!.IsExpanded, true)
        assert.equal(n2!.IsExpanded, false)
        assert.equal(n1!.SubItems[0]!.IsSelected, true)
        assert.equal(nav.Env, 1)
        assert.equal(nav.Hive, 0)
    })
})
