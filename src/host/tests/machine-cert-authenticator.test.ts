import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { X509Certificate, createHash } from 'node:crypto'
import { AuthMethod, AuthenticatedResult, Credential, PresentedSecret, PrincipalKind, RejectedResult, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { MachinePrincipalMap } from '../machine-principal-map.js'
import { MachineCertAuthenticator } from '../machine-cert-authenticator.js'

class Fixture
{
    private static readonly CertPath = 'src/tests/fixtures/tls/machine-client.pem'
    public static Fingerprint(): string
    {
        const der = new X509Certificate(readFileSync(Fixture.CertPath)).raw
        return createHash('sha256').update(der).digest('hex')
    }
    public static Tenant(): Tenant { return new Tenant('t1', TenantKind.SelfHosted, 'T1') }
}

test('a mapped fingerprint authenticates as a Machine principal', async () =>
{
    const fp = Fixture.Fingerprint()
    const map = new MachinePrincipalMap(new Map([[fp, { PrincipalId: 'svc-1', Groups: ['robots'] }]]))
    const auth = new MachineCertAuthenticator(map)
    const result = await auth.Authenticate(new Credential(AuthMethod.Machine, fp), new PresentedSecret(''), Fixture.Tenant())
    assert.ok(result instanceof AuthenticatedResult)
    const p = (result as AuthenticatedResult).Principal
    assert.equal(p.Kind, PrincipalKind.Machine)
    assert.equal(p.Id, 'svc-1')
    assert.deepEqual([...p.Groups], ['robots'])
})

test('an unmapped fingerprint is rejected', async () =>
{
    const auth = new MachineCertAuthenticator(MachinePrincipalMap.Empty)
    const result = await auth.Authenticate(new Credential(AuthMethod.Machine, Fixture.Fingerprint()), new PresentedSecret(''), Fixture.Tenant())
    assert.ok(result instanceof RejectedResult)
})

test('an empty fingerprint is rejected', async () =>
{
    const map = new MachinePrincipalMap(new Map([['abc', { PrincipalId: 'x', Groups: [] }]]))
    const result = await new MachineCertAuthenticator(map).Authenticate(new Credential(AuthMethod.Machine, ''), new PresentedSecret(''), Fixture.Tenant())
    assert.ok(result instanceof RejectedResult)
})
