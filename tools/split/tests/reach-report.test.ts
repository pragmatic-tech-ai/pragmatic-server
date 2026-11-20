import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import { ReleaseApp } from '../../../admin/control-plane/release/release-tag.js'
import { AssignmentRules, SplitHome } from '../assignment-rules.js'
import { ReachReport, SplitAssignment } from '../reach-report.js'

/** The real repository, measured once for the whole file (esbuild over every app and test). */
class Measured
{
    public static readonly Root = join(import.meta.dirname, '..', '..', '..')
    public static Assignment: SplitAssignment

    public static Tracked(): string[]
    {
        return SplitAssignment.Files(Measured.Root)
    }
}

describe('AssignmentRules', () =>
{
    const rules = new AssignmentRules()

    it('a file reached by one image goes to that image\'s repository', () =>
    {
        assert.equal(rules.Assign('src/agent/agent-main.ts', [ReleaseApp.HiveAgent]).Home, SplitHome.HiveAgent)
        assert.equal(rules.Assign('src/idp/token-endpoint.ts', [ReleaseApp.TenantIdp]).Home, SplitHome.TenantIdp)
    })

    it('a file the platform admin console and the edge reach (one entry until the edge has its own) goes to platform-admin', () =>
    {
        assert.equal(rules.Assign('admin/control-plane/client-registry.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.PlatformEdge]).Home, SplitHome.PlatformAdmin)
    })

    it('a file reached by tenant-admin and platform-admin goes to pragmatic-tenant-plane unless a kube/release/link rule claims it', () =>
    {
        assert.equal(rules.Assign('admin/control-plane/tenant-api/tenant-api-endpoint.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.PlatformEdge, ReleaseApp.TenantAdmin]).Home, SplitHome.TenantPlane)
        assert.equal(rules.Assign('admin/control-plane/kube-api-client.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.PlatformEdge, ReleaseApp.TenantAdmin]).Home, SplitHome.Kube)
        assert.equal(rules.Assign('admin/control-plane/oci-registry-client.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin, ReleaseApp.UiUnpack]).Home, SplitHome.ReleaseToolkit)
        assert.equal(rules.Assign('admin/control-plane/internal-api-routes.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.PlatformEdge]).Home, SplitHome.PlatformLink)
    })

    it('src/agent/kube-https-transport.ts goes to pragmatic-kube', () =>
    {
        assert.equal(rules.Assign('src/agent/kube-https-transport.ts', [ReleaseApp.HiveAgent, ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin]).Home, SplitHome.Kube)
    })

    it('the env-server and the env-gateway share pragmatic-env-cluster; the edge files go to the edge', () =>
    {
        assert.equal(rules.Assign('src/cluster/cluster-keys.ts', [ReleaseApp.EnvServer, ReleaseApp.EnvGateway]).Home, SplitHome.EnvCluster)
        assert.equal(rules.Assign('admin/control-plane/edge-host.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.PlatformEdge]).Home, SplitHome.PlatformEdge)
    })

    it('a file no image reaches is placed by its prefix; one no rule places is refused, naming it', () =>
    {
        assert.equal(rules.Assign('admin/tenant-portal/src/app.ts', []).Home, SplitHome.TenantAdmin)
        assert.equal(rules.Assign('docker/postgres/Dockerfile', []).Home, SplitHome.Postgres)
        assert.equal(rules.Assign('admin/control-plane/live-loop/loop-orchestrator.ts', []).Home, SplitHome.E2e)
        assert.throws(() => rules.Assign('nowhere/file.ts', []), /nowhere\/file\.ts/)
    })

    it('two images no rule joins are refused, naming the file and the images', () =>
    {
        assert.throws(() => rules.Assign('src/odd.ts', [ReleaseApp.HiveAgent, ReleaseApp.TenantIdp]), /src\/odd\.ts.*pragmatic-hive-agent.*pragmatic-tenant-idp/)
    })
})

describe('ReachReport over the repository', () =>
{
    before(async () =>
    {
        Measured.Assignment = await new ReachReport(Measured.Root).Assignment()
    })

    it('assigns every tracked source file exactly once', () =>
    {
        const tracked = Measured.Tracked()
        assert.deepEqual(Object.keys(Measured.Assignment.Homes).sort(), [...tracked].sort())
    })

    it('tests follow their subject', () =>
    {
        const homes = Measured.Assignment.Homes
        assert.equal(homes['src/idp/tests/tenant-idp-protocol.test.ts'], homes['src/idp/token-endpoint.ts'])
        assert.equal(homes['admin/control-plane/tests/desktop-relay.test.ts'], homes['admin/control-plane/tenant-auth/desktop-relay.ts'])
    })

    it('lists the tests whose imports span homes with no subject to follow', () =>
    {
        for (const test of Measured.Assignment.CrossHomeTests)
        {
            assert.match(test, /\.test\.ts$/)
        }
    })
})
