import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MachineTls } from '../machine-tls.js'
import type { MachineTlsRef } from '../machine-tls.js'

class TlsFixture
{
    public static Ref(): MachineTlsRef
    {
        const dir = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'tls')
        return { certFile: join(dir, 'server.pem'), keyFile: join(dir, 'server.key'), caFile: join(dir, 'ca.pem') }
    }
}

test('Server material loads the PEM files and sets requestCert + rejectUnauthorized', () =>
{
    const material = MachineTls.Server(TlsFixture.Ref())
    assert.ok(material.cert.length > 0)
    assert.ok(material.key.length > 0)
    assert.ok(material.ca.length > 0)
    assert.equal(material.requestCert, true)
    assert.equal(material.rejectUnauthorized, true)
    assert.deepEqual(material.cert, readFileSync(TlsFixture.Ref().certFile))
})

test('OptionalServer loads material requesting but not requiring a client cert', () =>
{
    const material = MachineTls.OptionalServer(TlsFixture.Ref())
    assert.equal(material.requestCert, true)
    assert.equal(material.rejectUnauthorized, false)
    assert.ok(material.key.length > 0 && material.cert.length > 0 && material.ca.length > 0)
})

test('Client material loads cert/key/ca', () =>
{
    const material = MachineTls.Client(TlsFixture.Ref())
    assert.ok(material.cert.length > 0 && material.key.length > 0 && material.ca.length > 0)
})

test('a missing cert file surfaces as a thrown error', () =>
{
    assert.throws(() => MachineTls.Server({ certFile: join(import.meta.dirname, 'does-not-exist.pem'), keyFile: TlsFixture.Ref().keyFile, caFile: TlsFixture.Ref().caFile }))
})
