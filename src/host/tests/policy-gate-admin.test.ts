import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { AdminProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PolicyGate } from '../policy-gate.js'

class AdminGateFixture
{
    public static readonly Methods: readonly string[] = [
        AdminProtocol.ListGrants.method,
        AdminProtocol.GrantRole.method,
        AdminProtocol.RevokeRole.method,
        AdminProtocol.GetConfig.method,
        AdminProtocol.SetConfig.method,
        AdminProtocol.ListAccounts.method,
        AdminProtocol.CreateAccount.method,
        AdminProtocol.DisableAccount.method,
        AdminProtocol.ListTokens.method,
        AdminProtocol.IssueToken.method,
        AdminProtocol.RevokeToken.method,
    ]

    public static readonly Untabled = 'admin/accounts/bogus'

    public static Gate(role: Role | null): PolicyGate
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = role === null ? [] : [new Grant('p1', role, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new PolicyGate(new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy()), () => [])
    }
}

test('Admin and Owner tenant grants are allowed every admin method', () =>
{
    for (const role of [Role.Admin, Role.Owner])
    {
        const gate = AdminGateFixture.Gate(role)
        for (const method of AdminGateFixture.Methods)
        {
            assert.equal(gate.Authorize(method).Allowed, true, `${Role[role]} ${method}`)
        }
    }
})

test('Viewer, Editor and ungranted callers are denied every admin method', () =>
{
    for (const role of [Role.Viewer, Role.Editor, null])
    {
        const gate = AdminGateFixture.Gate(role)
        for (const method of AdminGateFixture.Methods)
        {
            assert.equal(gate.Authorize(method).Allowed, false, `${role === null ? 'none' : Role[role]} ${method}`)
        }
    }
})

test('an untabled admin method is denied even for Owner', () =>
{
    assert.equal(AdminGateFixture.Gate(Role.Owner).Authorize(AdminGateFixture.Untabled).Allowed, false)
})
