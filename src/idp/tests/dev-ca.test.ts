import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { DevCa, IdpTlsMaterial } from '../dev-ca.js'

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
        assert.throws(() => DevCa.EnsureAt(join(dir, 'nested'), 'idp.local', 'no-such-openssl-binary'), /openssl/)
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
        assert.throws(() => DevCa.EnsureAt(tmpdir(), bad, 'no-such-openssl-binary'), /invalid host/)
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
    }
    finally
    {
        for (const d of [d1, d2, d3])
        {
            rmSync(d, { recursive: true, force: true })
        }
    }
})
