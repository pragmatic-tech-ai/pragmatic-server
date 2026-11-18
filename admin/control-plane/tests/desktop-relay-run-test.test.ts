import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApplicationDeployProtocol, GraphProtocol, PragmaticAppProtocol, RunTestProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DesktopAction } from '../tenant-auth/desktop-targets.js'
import { DesktopRelayAllowlist } from '../tenant-auth/desktop-relay.js'
import { RunTestMethods, TokenScope } from '../../../src/host/token-scope.js'

class RunTestRelayFixture
{
    /** The authoritative, hand-written wire strings: the run/test surface is exactly these three. */
    public static readonly ExpectedWire: readonly string[] = ['runtime/run-test', 'application/list', 'graph/loaded']

    /** Escalation paths that must never be reachable with a run/test credential. */
    public static readonly EscalationWire: readonly string[] = [
        'data/write', 'application/deploy', 'data/share', 'data/assign', 'graph/contribute', 'graph/create', 'graph/delete',
        'storage/writeText', 'admin/grantRole', 'admin/issueToken',
    ]
}

test('the run-test wire values are run-test and environment-run-test', () =>
{
    assert.equal(TokenScope.RunTest, 'environment-run-test')
    assert.equal(DesktopAction.RunTest, 'run-test')
})

test('the run-test relay allowlist is exactly the three run/test methods', () =>
{
    const allowed = DesktopRelayAllowlist.For(DesktopAction.RunTest)
    assert.deepEqual([...allowed].sort(), [...RunTestRelayFixture.ExpectedWire].sort())
    assert.deepEqual([...allowed].sort(), [RunTestProtocol.Load.method, PragmaticAppProtocol.List.method, GraphProtocol.Loaded.method].sort())
    assert.deepEqual(new Set(allowed), new Set(RunTestMethods.All))
})

test('the run-test relay allowlist refuses data/write, application/deploy, shares and assign', () =>
{
    const allowed = DesktopRelayAllowlist.For(DesktopAction.RunTest)
    for (const method of RunTestRelayFixture.EscalationWire)
    {
        assert.equal(allowed.has(method), false, method)
    }
    assert.equal(allowed.has(ApplicationDeployProtocol.Deploy.method), false)
})
