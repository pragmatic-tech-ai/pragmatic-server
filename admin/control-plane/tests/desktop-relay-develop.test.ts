import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApplicationDeployProtocol, GraphProtocol, LanguageProtocol, SolutionProtocol, StorageProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DesktopAction } from '../tenant-auth/desktop-targets.js'
import { DesktopRelayAllowlist } from '../tenant-auth/desktop-relay.js'
import { TokenScope, TokenScopeGate } from '../../../src/host/token-scope.js'

class DevelopFixture
{
    public static readonly Admitted: readonly string[] = [
        SolutionProtocol.ListSolutions.method, SolutionProtocol.SelectAuthoring.method, SolutionProtocol.ActiveSolution.method,
        StorageProtocol.ReadText.method, StorageProtocol.ReadBytes.method, StorageProtocol.WriteText.method, StorageProtocol.WriteBytes.method,
        StorageProtocol.Exists.method, StorageProtocol.Delete.method, StorageProtocol.CreateDirectory.method, StorageProtocol.Rename.method,
        LanguageProtocol.CompletionsAt.method, LanguageProtocol.HoverAt.method, LanguageProtocol.DefinitionAt.method, LanguageProtocol.ReferencesAt.method,
        LanguageProtocol.PrepareRename.method, LanguageProtocol.RenameEdits.method, LanguageProtocol.DocumentSymbols.method, LanguageProtocol.FoldingRanges.method,
        LanguageProtocol.WorkspaceSymbols.method, LanguageProtocol.SemanticTokens.method, LanguageProtocol.SignatureHelpAt.method, LanguageProtocol.CodeActions.method,
        LanguageProtocol.FormatDocument.method, LanguageProtocol.DiagnosticsFor.method, LanguageProtocol.DidChange.method,
        GraphProtocol.List.method, GraphProtocol.Contribute.method,
    ]

    public static readonly Denied: readonly string[] = [
        GraphProtocol.Create.method, GraphProtocol.Delete.method, GraphProtocol.Load.method, GraphProtocol.Loaded.method, GraphProtocol.Get.method,
        GraphProtocol.Export.method, ApplicationDeployProtocol.Deploy.method, SolutionProtocol.OpenSolution.method,
        SolutionProtocol.GraphChanged.method, StorageProtocol.List.method,
    ]
}

test('the develop wire values are develop and environment-develop', () =>
{
    assert.equal(TokenScope.Develop, 'environment-develop')
    assert.equal(DesktopAction.Develop, 'develop')
})

test('the develop relay allowlist is exactly the develop method set', () =>
{
    const allowed = DesktopRelayAllowlist.For(DesktopAction.Develop)
    assert.deepEqual(new Set(allowed), new Set(DevelopFixture.Admitted))
    for (const method of DevelopFixture.Denied)
    {
        assert.equal(allowed.has(method), false, method)
    }
})

test('the develop relay allowlist admits graph/contribute, storage/writeText and solution/selectAuthoring', () =>
{
    const allowed = DesktopRelayAllowlist.For(DesktopAction.Develop)
    assert.ok(allowed.has(GraphProtocol.Contribute.method))
    assert.ok(allowed.has(StorageProtocol.WriteText.method))
    assert.ok(allowed.has(SolutionProtocol.SelectAuthoring.method))
})

test('the develop relay allowlist rejects graph/delete, application/deploy, solution/open and graph/load', () =>
{
    const allowed = DesktopRelayAllowlist.For(DesktopAction.Develop)
    assert.equal(allowed.has(GraphProtocol.Delete.method), false)
    assert.equal(allowed.has(ApplicationDeployProtocol.Deploy.method), false)
    assert.equal(allowed.has(SolutionProtocol.OpenSolution.method), false)
    assert.equal(allowed.has(GraphProtocol.Load.method), false)
})

test('the develop token scope gate admits the develop set and denies the rest', () =>
{
    const gate = TokenScopeGate.For([TokenScope.Develop])
    for (const method of DevelopFixture.Admitted)
    {
        assert.equal(gate.Allows(method), true, method)
    }
    for (const method of DevelopFixture.Denied)
    {
        assert.equal(gate.Allows(method), false, method)
    }
})
