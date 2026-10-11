import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { LanguageProtocol, SolutionProtocol, ModelProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
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
