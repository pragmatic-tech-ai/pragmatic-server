import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import type { ManifestDto } from '../../../portal-types.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { ReleaseDetailPageViewModel } from '../release-detail-page-view-model.js'
import { ReleasesPageViewModel } from '../releases-page-view-model.js'
import { ReleasesSectionService } from '../releases-section-service.js'

// Manifest records as the control plane imports them from the release registry.
class ReleaseFixtures
{
    public static readonly ServerCommit = '0123456789abcdef0123456789abcdef01234567'
    public static readonly Apps = [
        'pragmatic-platform-admin', 'pragmatic-platform-edge', 'pragmatic-env-server', 'pragmatic-env-gateway',
        'pragmatic-hive-agent', 'pragmatic-tenant-admin', 'pragmatic-tenant-idp', 'pragmatic-ui-unpack',
    ]

    // A distinct digest per app index.
    public static Digest(index: number): string
    {
        return 'sha256:' + (index + 1).toString(16).repeat(64)
    }

    // A verified release: the env-server image is the version's image (by digest), as the catalogue records it.
    public static Verified(version: string): ManifestDto
    {
        // Deliberately not in release order: the detail orders the rows itself.
        const images: Record<string, { repository: string; digest: string }> = {}
        for (const i of [7, 3, 0, 5, 1, 6, 2, 4])
        {
            images[ReleaseFixtures.Apps[i]!] = { repository: 'ghcr.io/pragmatic-tech-ai/' + ReleaseFixtures.Apps[i], digest: ReleaseFixtures.Digest(i) }
        }
        return {
            id: version,
            channel: 'stable',
            image: 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@' + ReleaseFixtures.Digest(2),
            digest: ReleaseFixtures.Digest(2),
            signed: true,
            publishedAt: '2026-11-09T14:30:00.000Z',
            release: {
                state: 'verified',
                serverCommit: ReleaseFixtures.ServerCommit,
                siblingCommits: { todl: 'a'.repeat(40), Mural: 'b'.repeat(40) },
                builtAt: '2026-11-09T14:30:00.000Z',
                signingKeyId: 'release-2026',
                images,
            },
        } as ManifestDto
    }

    // A rejected release: no image, only the reason.
    public static Rejected(version: string): ManifestDto
    {
        return {
            id: version,
            channel: 'stable',
            image: '',
            signed: false,
            publishedAt: '2026-11-10T00:00:00.000Z',
            release: { state: 'rejected', rejectedReason: 'signature did not verify for image: pragmatic-env-server' },
        } as ManifestDto
    }
}

// A Registry & Releases section over a fake control plane and fake dialogs.
class ReleasesFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Section: ReleasesSectionService

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod', [true, false])
            .WithManifest('1.4.0', 'img:0', { publishedAt: '2026-10-12T00:00:00.000Z', notes: 'Faster graphs', digest: 'sha256:abcdef0123456789abcdef' })
            .WithManifest('1.3.0', 'img:old', { publishedAt: '2026-10-01T00:00:00.000Z', channel: 'early', signed: false })
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Section = new ReleasesSectionService(this.Host.Provider)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async List(): Promise<ReleasesPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        assert.ok(this.Content instanceof ReleasesPageViewModel)
        return this.Content
    }

    public async Detail(index: number = 0): Promise<ReleaseDetailPageViewModel>
    {
        const list = await this.List()
        list.Rows.Get(index)?.OpenCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof ReleaseDetailPageViewModel)
        return this.Content
    }

    public async DetailOf(version: string): Promise<ReleaseDetailPageViewModel>
    {
        const list = await this.List()
        const index = list.Rows.ToArray().findIndex(r => r.Version === version)
        assert.notEqual(index, -1)
        return await this.Detail(index)
    }
}

describe('Registry & Releases section', () =>
{
    it('the list shows each version newest first with channel, signature, status and adoption', async () =>
    {
        const fx = new ReleasesFixture()
        const list = await fx.List()
        assert.equal(list.State, PageState.Populated)
        assert.deepEqual(list.Rows.ToArray().map(r => [r.Version, r.ChannelLabel, r.SignatureLabel, r.StatusLabel, r.PublishedLabel, r.AdoptionLabel]), [
            ['1.4.0', 'Stable', 'Signed', 'Published', '2026-10-12', '1 environment'],
            ['1.3.0', 'Early access', 'Unsigned', 'Published', '2026-10-01', 'Not running anywhere'],
        ])
        assert.deepEqual(list.Rows.ToArray().map(r => r.Image), ['img:0', 'img:old'])
    })

    it('no versions -> Empty', async () =>
    {
        const fx = new ReleasesFixture()
        fx.Api.Manifests = []
        const list = await fx.List()
        assert.equal(list.State, PageState.Empty)
    })

    it('list -> detail: manifest, digest, notes and where it runs; Back returns', async () =>
    {
        const fx = new ReleasesFixture()
        const detail = await fx.Detail()
        assert.equal(detail.State, PageState.Populated)
        assert.equal(detail.Version, '1.4.0')
        assert.equal(detail.Image, 'img:0')
        assert.equal(detail.DigestLabel, 'abcdef012345')
        assert.equal(detail.NotesLabel, 'Faster graphs')
        assert.equal(detail.ChannelLabel, 'Stable')
        assert.equal(detail.IsWithdrawn, false)
        assert.deepEqual(detail.AdoptionRows.ToArray().map(r => [r.HiveName, r.OwnerLabel, r.Environment, r.ReadyLabel]), [
            ['Hive acme-hive', 'Acme / Acme Production', 'env0', 'Ready'],
        ])
        assert.equal(detail.HasAdoption, true)
        detail.BackCommand.Execute()
        assert.ok(fx.Content instanceof ReleasesPageViewModel)
    })

    it('loading the detail raises HasAdoption and HasNoAdoption once the adoption rows are filled', async () =>
    {
        const fx = new ReleasesFixture()
        await fx.List()
        const detail = new ReleaseDetailPageViewModel(fx.Host.Session, fx.Section, '1.4.0')
        const seen: Array<[string, unknown]> = []
        detail.PropertyChanged('HasAdoption').subscribe(e => seen.push(['HasAdoption', e.newValue]))
        detail.PropertyChanged('HasNoAdoption').subscribe(e => seen.push(['HasNoAdoption', e.newValue]))
        await detail.Refresh()
        assert.equal(detail.AdoptionRows.Count, 1)
        assert.deepEqual(seen, [['HasAdoption', true], ['HasNoAdoption', false]])
    })

    it('Withdraw asks for the version and a reason, then records the reason', async () =>
    {
        const fx = new ReleasesFixture()
        const detail = await fx.Detail()
        assert.equal(detail.RestoreCommand.CanExecute(), false)
        detail.WithdrawCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        assert.equal(confirm.ConfirmLabel, 'Withdraw')
        assert.equal(confirm.RequiresReason, true)
        confirm.Typed = '1.4.0'
        assert.equal(confirm.ConfirmCommand.CanExecute(), false)
        confirm.Reason = 'Breaks graph export'
        assert.equal(confirm.ConfirmCommand.CanExecute(), true)
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Withdrawals, [['1.4.0', true, 'Breaks graph export']])
        assert.equal(fx.Content, detail)
        assert.equal(detail.IsWithdrawn, true)
        assert.equal(detail.StatusLabel, 'Withdrawn')
        assert.match(detail.WithdrawnText, /Breaks graph export/)
        assert.equal(detail.WithdrawCommand.CanExecute(), false)
        assert.equal(detail.RestoreCommand.CanExecute(), true)
    })

    it('after a withdrawal, Back shows the list reloaded with the version withdrawn', async () =>
    {
        const fx = new ReleasesFixture()
        const detail = await fx.Detail()
        detail.WithdrawCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last as NameConfirmDialogViewModel
        confirm.Typed = '1.4.0'
        confirm.Reason = 'Broken'
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        detail.BackCommand.Execute()
        await Tick.Settle()
        const list = fx.Content
        assert.ok(list instanceof ReleasesPageViewModel)
        assert.equal(list.Rows.ToArray().find(r => r.Version === '1.4.0')?.StatusLabel, 'Withdrawn')
    })

    it('Restore returns a withdrawn version to offers', async () =>
    {
        const fx = new ReleasesFixture()
        fx.Api.Manifests[0].withdrawn = true
        const detail = await fx.Detail()
        detail.RestoreCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Withdrawals, [['1.4.0', false, undefined]])
        assert.equal(detail.IsWithdrawn, false)
    })

    it('a published version offers Withdraw; a withdrawn one offers Restore instead', async () =>
    {
        const fx = new ReleasesFixture()
        fx.Api.Manifests[1].withdrawn = true
        const published = await fx.Detail(0)
        assert.equal(published.IsPublished, true)
        published.BackCommand.Execute()
        const withdrawn = await fx.Detail(1)
        assert.equal(withdrawn.IsPublished, false)
        assert.equal(withdrawn.IsWithdrawn, true)
    })

    it('Observer: Refresh from registry and Withdraw (published) are disabled and do nothing', async () =>
    {
        const fx = new ReleasesFixture(OperatorContext.ReadOnlyWireRole)
        const list = await fx.List()
        assert.equal(list.RefreshFromRegistryCommand.CanExecute(), false)
        assert.notEqual(list.DeniedReason, '')
        list.RefreshFromRegistryCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Api.ReleaseRefreshes, 0)
        assert.equal(list.RefreshResultText, '')
        const detail = await fx.Detail()
        assert.equal(detail.WithdrawCommand.CanExecute(), false)
        detail.WithdrawCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
        assert.deepEqual(fx.Api.Withdrawals, [])
    })

    it('Observer: Restore of a withdrawn version is disabled and does nothing', async () =>
    {
        const fx = new ReleasesFixture(OperatorContext.ReadOnlyWireRole)
        fx.Api.Manifests[0].withdrawn = true
        const detail = await fx.Detail()
        assert.equal(detail.IsWithdrawn, true)
        assert.equal(detail.RestoreCommand.CanExecute(), false)
        detail.RestoreCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Withdrawals, [])
    })

    it('Refresh from registry calls the control plane, reports the counts and reloads the list', async () =>
    {
        const fx = new ReleasesFixture()
        const list = await fx.List()
        assert.equal(list.RefreshFromRegistryCommand.CanExecute(), true)
        // Disjoint, as the server reports them: imported lists the verified versions only.
        fx.Api.ReleaseRefreshResult = { imported: ['1.5.0', '1.7.0'], rejected: ['1.6.0'], unchanged: 3, shadowed: [] }
        fx.Api.ReleaseRefreshImports = [ReleaseFixtures.Verified('1.5.0'), ReleaseFixtures.Rejected('1.6.0')]
        list.RefreshFromRegistryCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Api.ReleaseRefreshes, 1)
        assert.equal(list.RefreshResultText, 'Imported 2, rejected 1')
        assert.equal(list.CommandErrorText, '')
        assert.deepEqual(list.Rows.ToArray().map(r => [r.Version, r.VerificationLabel, r.Image]), [
            ['1.6.0', 'Rejected', '—'],
            ['1.5.0', 'Verified', 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@' + ReleaseFixtures.Digest(2)],
            ['1.4.0', '—', 'img:0'],
            ['1.3.0', '—', 'img:old'],
        ])
    })

    it('Refresh from registry appends the shadowed count only when some versions were shadowed', async () =>
    {
        const fx = new ReleasesFixture()
        const list = await fx.List()
        fx.Api.ReleaseRefreshResult = { imported: [], rejected: [], unchanged: 2, shadowed: ['1.4.0'] }
        list.RefreshFromRegistryCommand.Execute()
        await Tick.Settle()
        assert.equal(list.RefreshResultText, 'Imported 0, rejected 0, shadowed 1')
    })

    it('Refresh from registry shows the server sentence for a 409 or 502 and no stale counts', async () =>
    {
        const fx = new ReleasesFixture()
        const list = await fx.List()
        list.RefreshFromRegistryCommand.Execute()
        await Tick.Settle()
        assert.equal(list.RefreshResultText, 'Imported 0, rejected 0')
        for (const [status, sentence] of [[409, 'No release registry is configured.'], [502, 'The release registry is unavailable.']] as const)
        {
            fx.Api.ReleaseRefreshFailure = new ApiError(status, sentence)
            list.RefreshFromRegistryCommand.Execute()
            await Tick.Settle()
            assert.equal(list.CommandErrorText, sentence)
            assert.equal(list.RefreshResultText, '')
            assert.equal(list.State, PageState.Populated)
        }
    })

    it('a Verified release shows built-at, commits, signer and its eight images in release order', async () =>
    {
        const fx = new ReleasesFixture()
        fx.Api.Manifests.push(ReleaseFixtures.Verified('1.5.0'))
        const detail = await fx.DetailOf('1.5.0')
        assert.equal(detail.HasRelease, true)
        assert.equal(detail.IsRejected, false)
        assert.equal(detail.IsVerified, true)
        assert.equal(detail.VerificationLabel, 'Verified')
        assert.equal(detail.BuiltAtLabel, '2026-11-09 14:30')
        assert.equal(detail.ServerCommit, ReleaseFixtures.ServerCommit)
        assert.equal(detail.ServerCommitShort, ReleaseFixtures.ServerCommit.slice(0, 7))
        assert.equal(detail.SigningKeyId, 'release-2026')
        assert.equal(detail.RejectedReason, '')
        assert.deepEqual(detail.ImageRows.ToArray().map(r => r.App), [
            'pragmatic-platform-admin', 'pragmatic-platform-edge', 'pragmatic-env-server', 'pragmatic-env-gateway',
            'pragmatic-hive-agent', 'pragmatic-tenant-admin', 'pragmatic-tenant-idp', 'pragmatic-ui-unpack',
        ])
        assert.deepEqual(detail.ImageRows.ToArray().map(r => r.DigestLabel), ReleaseFixtures.Apps.map((_, i) => ReleaseFixtures.Digest(i).slice(7, 19)))
        assert.equal(detail.ImageRows.Get(2)?.Digest, ReleaseFixtures.Digest(2))
        assert.equal(detail.ImageRows.Get(2)?.Repository, 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server')
        assert.deepEqual(detail.SiblingCommitRows.ToArray().map(r => [r.Repo, r.CommitShort, r.Commit]), [
            ['Mural', 'b'.repeat(7), 'b'.repeat(40)],
            ['todl', 'a'.repeat(7), 'a'.repeat(40)],
        ])
    })

    it('a Rejected release shows its reason, no image reference, and the list says Rejected', async () =>
    {
        const fx = new ReleasesFixture()
        fx.Api.Manifests.push(ReleaseFixtures.Rejected('1.6.0'))
        const list = await fx.List()
        assert.equal(list.Rows.ToArray().find(r => r.Version === '1.6.0')?.VerificationLabel, 'Rejected')
        const detail = await fx.DetailOf('1.6.0')
        assert.equal(detail.IsRejected, true)
        assert.equal(detail.IsVerified, false)
        assert.equal(detail.VerificationLabel, 'Rejected')
        assert.equal(detail.DigestLabel, '—')
        assert.equal(detail.RejectedReason, 'signature did not verify for image: pragmatic-env-server')
        assert.equal(detail.Image, '—')
        assert.equal(detail.ImageRows.Count, 0)
        assert.equal(detail.HasImages, false)
        assert.equal(detail.AdoptionRows.Count, 0)
    })

    it('a local manifest without release provenance keeps the plain detail', async () =>
    {
        const fx = new ReleasesFixture()
        const detail = await fx.Detail()
        assert.equal(detail.HasRelease, false)
        assert.equal(detail.IsRejected, false)
        assert.equal(detail.ImageRows.Count, 0)
        assert.equal(detail.SiblingCommitRows.Count, 0)
        assert.equal(detail.Image, 'img:0')
    })

    it('the publish dialog is gone: no view-model file and no Publish command on the list', async () =>
    {
        const fx = new ReleasesFixture()
        const list = await fx.List()
        assert.equal('PublishCommand' in list, false)
        assert.equal(existsSync(fileURLToPath(new URL('../publish-dialog-view-model.ts', import.meta.url))), false)
    })
})
