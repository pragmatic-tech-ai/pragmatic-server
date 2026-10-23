import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})
