import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { LanguageProtocol, SolutionProtocol, ModelProtocol, ConnectorProtocol, CypherProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PolicyGate } from '../policy-gate.js'

class GateFixture
{
    public static ContextWith(role: Role | null): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = role === null ? [] : [new Grant('p1', role, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static Gate(role: Role | null): PolicyGate
    {
        return new PolicyGate(GateFixture.ContextWith(role), () => [])
    }

    public static ReadMethods(): readonly string[]
    {
        return [
            LanguageProtocol.CompletionsAt.method,
            LanguageProtocol.HoverAt.method,
            LanguageProtocol.DefinitionAt.method,
            LanguageProtocol.ReferencesAt.method,
            LanguageProtocol.PrepareRename.method,
            LanguageProtocol.RenameEdits.method,
            LanguageProtocol.DocumentSymbols.method,
            LanguageProtocol.FoldingRanges.method,
            LanguageProtocol.WorkspaceSymbols.method,
            LanguageProtocol.SemanticTokens.method,
            LanguageProtocol.SignatureHelpAt.method,
            LanguageProtocol.CodeActions.method,
            LanguageProtocol.FormatDocument.method,
            LanguageProtocol.DiagnosticsFor.method,
            SolutionProtocol.ActiveSolution.method,
            ModelProtocol.ModelView.method,
            ModelProtocol.Resources.method,
            CypherProtocol.Query.method,
        ]
    }
}

test('Viewer may read, is denied write and administer', () =>
{
    const gate = GateFixture.Gate(Role.Viewer)
    assert.equal(gate.Authorize(LanguageProtocol.CompletionsAt.method).Allowed, true)
    assert.equal(gate.Authorize(ModelProtocol.ModelView.method).Allowed, true)
    assert.equal(gate.Authorize(SolutionProtocol.ActiveSolution.method).Allowed, true)
    assert.equal(gate.Authorize(LanguageProtocol.DidChange.method).Allowed, false)
    assert.equal(gate.Authorize(SolutionProtocol.OpenSolution.method).Allowed, false)
    assert.equal(gate.CanRead(), true)
})

test('Editor may write but not administer', () =>
{
    const gate = GateFixture.Gate(Role.Editor)
    assert.equal(gate.Authorize(LanguageProtocol.DidChange.method).Allowed, true)
    assert.equal(gate.Authorize(SolutionProtocol.OpenSolution.method).Allowed, false)
})

test('Admin may administer (open)', () =>
{
    assert.equal(GateFixture.Gate(Role.Admin).Authorize(SolutionProtocol.OpenSolution.method).Allowed, true)
})

test('a principal with no grants is denied every method', () =>
{
    const gate = GateFixture.Gate(null)
    assert.equal(gate.Authorize(LanguageProtocol.CompletionsAt.method).Allowed, false)
    assert.equal(gate.Authorize(SolutionProtocol.ActiveSolution.method).Allowed, false)
    assert.equal(gate.CanRead(), false)
})

test('an untabled method is denied', () =>
{
    assert.equal(GateFixture.Gate(Role.Owner).Authorize('bogus/method').Allowed, false)
})

test('every tabled method is classified correctly (Viewer allows all reads, denies write and administer)', () =>
{
    const gate = GateFixture.Gate(Role.Viewer)
    for (const method of GateFixture.ReadMethods())
    {
        assert.equal(gate.Authorize(method).Allowed, true, method)
    }
    assert.equal(gate.Authorize(LanguageProtocol.DidChange.method).Allowed, false)
    assert.equal(gate.Authorize(SolutionProtocol.OpenSolution.method).Allowed, false)
})

test('cypher/query is allowed for a reader and denied with no role', () =>
{
    assert.equal(GateFixture.Gate(Role.Viewer).Authorize(CypherProtocol.Query.method).Allowed, true)
    assert.equal(GateFixture.Gate(null).Authorize(CypherProtocol.Query.method).Allowed, false)
})

test('Owner may list/read/write/test/prepare/refresh connectors', () =>
{
    const gate = GateFixture.Gate(Role.Owner)
    assert.equal(gate.Authorize(ConnectorProtocol.List.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.Read.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.ReadPage.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.WriteBack.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.WritePaged.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.Test.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.Prepare.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.Refresh.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.RefreshModel.method).Allowed, true)
})

test('Viewer may list/read connectors but not write/test/prepare/refresh', () =>
{
    const gate = GateFixture.Gate(Role.Viewer)
    assert.equal(gate.Authorize(ConnectorProtocol.List.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.Read.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.ReadPage.method).Allowed, true)
    assert.equal(gate.Authorize(ConnectorProtocol.WriteBack.method).Allowed, false)
    assert.equal(gate.Authorize(ConnectorProtocol.WritePaged.method).Allowed, false)
    assert.equal(gate.Authorize(ConnectorProtocol.Test.method).Allowed, false)
    assert.equal(gate.Authorize(ConnectorProtocol.Prepare.method).Allowed, false)
    assert.equal(gate.Authorize(ConnectorProtocol.Refresh.method).Allowed, false)
    assert.equal(gate.Authorize(ConnectorProtocol.RefreshModel.method).Allowed, false)
})

test('connector/readPage is allowed for a reader and denied with no role', () =>
{
    assert.equal(GateFixture.Gate(Role.Viewer).Authorize(ConnectorProtocol.ReadPage.method).Allowed, true)
    assert.equal(GateFixture.Gate(null).Authorize(ConnectorProtocol.ReadPage.method).Allowed, false)
})

test('cypher/execute needs tenant write: Owner allowed, Viewer and no role denied', () =>
{
    assert.equal(GateFixture.Gate(Role.Owner).Authorize(CypherProtocol.Execute.method).Allowed, true)
    assert.equal(GateFixture.Gate(Role.Viewer).Authorize(CypherProtocol.Execute.method).Allowed, false)
    assert.equal(GateFixture.Gate(null).Authorize(CypherProtocol.Execute.method).Allowed, false)
})
