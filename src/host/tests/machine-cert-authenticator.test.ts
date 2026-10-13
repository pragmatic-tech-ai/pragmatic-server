import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { X509Certificate, createHash } from 'node:crypto'
import { AuthMethod, AuthenticatedResult, Credential, PresentedSecret, PrincipalKind, RejectedResult, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { MachineCertIdentity, MachinePrincipalMap } from '../machine-principal-map.js'
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

test('FromPeerCertificate converges raw DER and colon-separated uppercase fingerprint256', () =>
{
    const raw = new X509Certificate(readFileSync('src/tests/fixtures/tls/machine-client.pem')).raw
    const hex = createHash('sha256').update(raw).digest('hex')
    const colon = hex.toUpperCase().match(/../g)!.join(':')
    const both = MachineCertIdentity.FromPeerCertificate(true, { fingerprint256: colon, raw })
    assert.equal(both.Fingerprint, hex)
    assert.equal(both.Authorized, true)
    assert.equal(MachineCertIdentity.FromPeerCertificate(true, { fingerprint256: colon }).Fingerprint, hex)
})

test('FromPeerCertificate on an empty cert is unauthorized with an empty fingerprint', () =>
{
    const id = MachineCertIdentity.FromPeerCertificate(false, {})
    assert.equal(id.Authorized, false)
    assert.equal(id.Fingerprint, '')
})

test('Lookup matches an uppercase colon-formatted reference', () =>
{
    const map = new MachinePrincipalMap(new Map([['abcd', { PrincipalId: 'x', Groups: [] }]]))
    assert.equal(map.Lookup('AB:CD')?.PrincipalId, 'x')
})

test('a map built with a non-canonical key is reachable by canonical and original forms', () =>
{
    const entry = { PrincipalId: 'svc-9', Groups: [] }
    const map = new MachinePrincipalMap(new Map([['AA:BB:CC', entry]]))
    assert.equal(map.Lookup('aabbcc'), entry)
    assert.equal(map.Lookup('AA:BB:CC'), entry)
    assert.equal(map.IsEmpty, false)
    assert.equal(MachinePrincipalMap.Empty.IsEmpty, true)
})
