import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { DevCa, DevCaError, IdpTlsMaterial } from '../dev-ca.js'

test('mints a CA, server cert and key, idempotently', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const a = DevCa.EnsureAt(dir, 'idp.local')
        assert.ok(!existsSync(join(dir, 'ca.key')))
        const bytesA = [a.certFile, a.keyFile, a.caFile].map(f => readFileSync(f))
        const b = DevCa.EnsureAt(dir, 'idp.local')
        assert.deepEqual(b, a)
        const bytesB = [b.certFile, b.keyFile, b.caFile].map(f => readFileSync(f))
        for (let i = 0; i < 3; i++)
        {
            assert.ok(bytesA[i].length > 0)
            assert.ok(bytesA[i].equals(bytesB[i]))
        }
        const m = IdpTlsMaterial.Load(a)
        assert.ok(m.key.equals(bytesA[1]) && m.cert.equals(bytesA[0]))
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('treats the three runtime files as complete without ca.key (no re-mint)', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const first = DevCa.EnsureAt(dir, 'idp.local')
        const firstCert = readFileSync(first.certFile)
        const second = DevCa.EnsureAt(dir, 'idp.local')
        assert.ok(readFileSync(second.certFile).equals(firstCert))
        assert.ok(!existsSync(join(dir, 'ca.key')))
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('re-mints when a runtime file is missing', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const first = DevCa.EnsureAt(dir, 'idp.local')
        const firstCert = readFileSync(first.certFile)
        rmSync(first.certFile, { force: true })
        const second = DevCa.EnsureAt(dir, 'idp.local')
        assert.ok(!readFileSync(second.certFile).equals(firstCert))
        for (const f of [second.certFile, second.keyFile, second.caFile])
        {
            assert.ok(existsSync(f), f)
        }
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('sweeps a staging dir a prior crashed mint left behind (its transient ca.key does not persist)', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        DevCa.EnsureAt(dir, 'idp.local')
        // Simulate a hard-kill between the renames and the finally-rmSync: a leftover staging dir holding ca.key.
        const stale = join(dir, '.devca-stale')
        mkdirSync(stale)
        writeFileSync(join(stale, 'ca.key'), 'leftover-ca-signing-key')
        DevCa.EnsureAt(dir, 'idp.local')
        assert.ok(!existsSync(stale))
        assert.ok(!existsSync(join(stale, 'ca.key')))
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the server cert carries the host SAN and chains to the minted CA', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const r = DevCa.EnsureAt(dir, 'idp.local')
        const server = new X509Certificate(readFileSync(r.certFile))
        const ca = new X509Certificate(readFileSync(r.caFile))
        assert.ok(server.subjectAltName?.includes('idp.local'))
        assert.ok(server.subjectAltName?.includes('127.0.0.1'))
        assert.equal(server.verify(ca.publicKey), true)
        assert.equal(server.ca, false)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a missing openssl binary raises a clear error naming openssl', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        assert.throws(() => DevCa.EnsureAt(join(dir, 'nested'), 'idp.local', 'no-such-openssl-binary'), (e: unknown) =>
            e instanceof DevCaError && e.name === 'DevCaError' && /openssl/.test(e.message))
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('an invalid host is rejected before openssl runs', () =>
{
    for (const bad of ['a/b', 'a\nb', 'a,b', ''])
    {
        assert.throws(() => DevCa.EnsureAt(tmpdir(), bad, 'no-such-openssl-binary'), (e: unknown) => e instanceof DevCaError && /invalid host/.test(e.message))
    }
})

test('a host list mints a multi-SAN cert (CN = first host) and still never persists ca.key', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const f = DevCa.EnsureAt(dir, ['a.example', 'b.example'])
        assert.ok(!existsSync(join(dir, 'ca.key')))
        const cert = new X509Certificate(readFileSync(f.certFile))
        assert.ok(cert.subjectAltName?.includes('DNS:a.example'))
        assert.ok(cert.subjectAltName?.includes('DNS:b.example'))
        assert.ok(cert.subjectAltName?.includes('IP Address:127.0.0.1'))
        assert.ok(cert.subject.includes('CN=a.example'))
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a one-element list and a bare string mint equivalent single-SAN certs; each listed host is validated', () =>
{
    const d1 = mkdtempSync(join(tmpdir(), 'devca-'))
    const d2 = mkdtempSync(join(tmpdir(), 'devca-'))
    const d3 = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const a = new X509Certificate(readFileSync(DevCa.EnsureAt(d1, ['only.example']).certFile))
        const b = new X509Certificate(readFileSync(DevCa.EnsureAt(d2, 'only.example').certFile))
        assert.equal(a.subjectAltName, b.subjectAltName)
        assert.equal(a.subject, b.subject)
        assert.throws(() => DevCa.EnsureAt(d3, ['ok.example', 'bad host;']), /invalid host/)
        assert.throws(() => DevCa.EnsureAt(d3, []), /invalid host/)
    }
    finally
    {
        for (const d of [d1, d2, d3])
        {
            rmSync(d, { recursive: true, force: true })
        }
    }
})

test('a first host longer than the 64-character CN limit still mints: the CN is the first host that fits, the SAN keeps the full name', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        // The in-cluster IdP's Service-DNS host for tenant `pragmatic-default` is 81 characters.
        const host = 'pragmatic-idp-pragmatic-default.pragmatic-idp-pragmatic-default.svc.cluster.local'
        const f = DevCa.EnsureAt(dir, [host, 'idp-pragmatic-default.localtest.me'])
        const cert = new X509Certificate(readFileSync(f.certFile))
        assert.ok(cert.subjectAltName?.includes('DNS:' + host))
        assert.ok(cert.subjectAltName?.includes('DNS:idp-pragmatic-default.localtest.me'))
        assert.ok(cert.subject.includes('CN=idp-pragmatic-default.localtest.me'))
        assert.ok(!cert.subject.includes('CN=' + host))
        assert.ok(cert.checkHost(host) !== undefined)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('when no host fits the CN limit the CN is the first host\'s first label, and the chain still verifies', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const host = 'pragmatic-idp-pragmatic-default.pragmatic-idp-pragmatic-default.svc.cluster.local'
        const f = DevCa.EnsureAt(dir, [host])
        const cert = new X509Certificate(readFileSync(f.certFile))
        assert.ok(cert.subject.includes('CN=pragmatic-idp-pragmatic-default'))
        assert.ok(cert.subjectAltName?.includes('DNS:' + host))
        assert.match(OpensslProbe.Verify(f.caFile, f.certFile), /OK/)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

class OpensslProbe
{
    public static Extension(certFile: string, name: string): string
    {
        return execFileSync('openssl', ['x509', '-in', certFile, '-noout', '-ext', name], { encoding: 'utf8' })
    }

    /** `openssl verify` enforces the CA's name constraints against the leaf's SANs; throws when the chain is refused. */
    public static Verify(caFile: string, certFile: string): string
    {
        return execFileSync('openssl', ['verify', '-CAfile', caFile, certFile], { encoding: 'utf8' })
    }
}

test('the CA is a critical name-constrained CA limited to its hosts and the loopback IP', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const f = DevCa.EnsureAt(dir, ['a.example', 'b.example'])
        const ca = new X509Certificate(readFileSync(f.caFile))
        assert.equal(ca.ca, true)
        const constraints = OpensslProbe.Extension(f.caFile, 'nameConstraints')
        assert.match(constraints, /Name Constraints: critical/)
        assert.match(constraints, /DNS:a\.example/)
        assert.match(constraints, /DNS:b\.example/)
        assert.match(constraints, /IP:127\.0\.0\.1\/255\.255\.255\.255/)
        assert.doesNotMatch(constraints, /Excluded/)
        assert.match(OpensslProbe.Extension(f.caFile, 'basicConstraints'), /critical[\s\S]*CA:TRUE, pathlen:0/)
        assert.match(OpensslProbe.Extension(f.caFile, 'keyUsage'), /critical[\s\S]*Certificate Sign, CRL Sign/)
        assert.match(OpensslProbe.Verify(f.caFile, f.certFile), /OK/)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the name-constrained chain still verifies for a host longer than the CN limit', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'devca-'))
    try
    {
        const host = 'pragmatic-idp-pragmatic-default.pragmatic-idp-pragmatic-default.svc.cluster.local'
        const f = DevCa.EnsureAt(dir, [host, 'idp-pragmatic-default.localtest.me'])
        assert.match(OpensslProbe.Verify(f.caFile, f.certFile), /OK/)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})
