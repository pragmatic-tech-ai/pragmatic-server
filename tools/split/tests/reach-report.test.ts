import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { AssignmentRules, SplitHome } from '../assignment-rules.js'
import { ReachReport, SplitAssignment } from '../reach-report.js'

/** The real repository, measured once for the whole file (esbuild over every app and test). */
class Measured
{
    public static readonly Root = join(import.meta.dirname, '..', '..', '..')
    public static Assignment: SplitAssignment
    /** A test that reaches the env-server and the env-gateway with no subject of its own. */
    public static readonly KnownCrossHome = 'src/cluster/tests/cluster-e2e.test.ts'
}

describe('AssignmentRules', () =>
{
    const rules = new AssignmentRules()

    it('a file reached by one image goes to that image\'s repository', () =>
    {
        assert.equal(rules.Assign('src/agent/agent-main.ts', [ReleaseApp.HiveAgent]).Home, SplitHome.HiveAgent)
        assert.equal(rules.Assign('src/idp/token-endpoint.ts', [ReleaseApp.TenantIdp]).Home, SplitHome.TenantIdp)
    })

    it('a file the platform admin console and the edge both reach, which no rule names, is refused (it belongs in the link)', () =>
    {
        assert.throws(() => rules.Assign('admin/control-plane/client-registry.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.PlatformEdge]), /client-registry\.ts/)
    })

    it('a file reached by tenant-admin and platform-admin goes to pragmatic-tenant-plane unless a rule names it', () =>
    {
        assert.equal(rules.Assign('admin/control-plane/tenant-api/tenant-api-endpoint.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin]).Home, SplitHome.TenantPlane)
        assert.equal(rules.Assign('admin/control-plane/k8s-manifest-builder.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin]).Home, SplitHome.TenantPlane)
        assert.equal(rules.Assign('admin/control-plane/release/release-components.ts', [ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin]).Home, SplitHome.Archive)
    })

    it('the postgres image\'s tests go to pragmatic-postgres', () =>
    {
        assert.equal(rules.Assign('docker/postgres/tests/image.test.sh', []).Home, SplitHome.Postgres)
        assert.equal(rules.Assign('docker/images/tests/postgres-image.test.ts', []).Home, SplitHome.Postgres)
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
        assert.equal(rules.Assign('admin/control-plane/descriptors/digests.json', []).Home, SplitHome.TenantAdmin)
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

    it('assigns every tracked source file exactly once, and known files to their homes', () =>
    {
        const tracked = execFileSync('git', ['-C', Measured.Root, 'ls-files', ...SplitAssignment.Roots], { encoding: 'utf8' }).split('\n').filter(line => line.length > 0)
        assert.deepEqual(Object.keys(Measured.Assignment.Homes).sort(), [...tracked].sort())
        const homes = Measured.Assignment.Homes
        assert.equal(homes['src/idp/token-endpoint.ts'], SplitHome.TenantIdp)
        assert.equal(homes['admin/control-plane/edge-host.ts'], SplitHome.PlatformEdge)
        // lifted into pragmatic-shared by Task 4 (pragmatic-tenant-plane): no longer tracked here
        assert.equal(homes['admin/control-plane/k8s-manifest-builder.ts'], undefined)
        // lifted into pragmatic-shared by Task 3: no longer tracked here
        assert.equal(homes['src/agent/kube-https-transport.ts'], undefined)
        assert.equal(homes['admin/control-plane/release/release-tag.ts'], undefined)
        assert.equal(homes['admin/control-plane/descriptors/digests.json'], SplitHome.TenantAdmin)
        assert.equal(homes['src/bin/gateway-main.ts'], SplitHome.EnvGateway)
    })

    it('tests follow their subject', () =>
    {
        const homes = Measured.Assignment.Homes
        assert.equal(homes['src/idp/tests/tenant-idp-protocol.test.ts'], homes['src/idp/token-endpoint.ts'])
        assert.equal(homes['admin/control-plane/tests/client-registry.test.ts'], homes['admin/control-plane/client-registry.ts'])
        // an explicit exception names a test's home before its subject or its reach does
        assert.equal(homes['admin/control-plane/tests/agent-channel-host.test.ts'], SplitHome.PlatformAdmin)
        assert.equal(homes['admin/control-plane/release/tests/component-descriptor-set.test.ts'], SplitHome.Archive)
    })

    it('a test whose subject is shared but whose imports, types included, need container files goes to that container, or to pragmatic-e2e for several', () =>
    {
        const homes = Measured.Assignment.Homes
        // their subjects now live in pragmatic-tenant-plane (Task 4); the tests stay where their container imports are
        assert.equal(homes['admin/control-plane/tests/tenant-account-index.test.ts'], SplitHome.PlatformAdmin)
        assert.equal(homes['admin/control-plane/tests/desktop-relay.test.ts'], SplitHome.E2e)
        assert.ok(Measured.Assignment.CrossHomeTests.includes('admin/control-plane/tests/desktop-relay.test.ts'))
    })

    it('lists the tests whose imports span containers with no subject to follow, and not a one-container test', () =>
    {
        const cross = Measured.Assignment.CrossHomeTests
        assert.ok(cross.every(test => test.endsWith('.test.ts')))
        assert.ok(cross.includes(Measured.KnownCrossHome), Measured.KnownCrossHome)
        assert.ok(!cross.includes('admin/control-plane/tests/edge-composition.test.ts'))
    })

    it('a test with no subject that reaches none of the repository\'s files goes by its path, not to pragmatic-e2e', () =>
    {
        assert.equal(Measured.Assignment.Homes['src/packaging/tests/helm.test.ts'], SplitHome.EnvServer)
    })

    it('a test-support file goes where the tests naming it go (each descriptor golden with its component)', () =>
    {
        const homes = Measured.Assignment.Homes
        assert.equal(homes['admin/control-plane/tests/fixtures/pragmatic-platform-edge.component.json'], SplitHome.PlatformEdge)
        assert.equal(homes['admin/control-plane/tests/fixtures/pragmatic-tenant-admin.component.json'], SplitHome.TenantAdmin)
        assert.equal(homes['src/bin/tests/fixtures/pragmatic-env-gateway.component.json'], SplitHome.EnvGateway)
    })
})
