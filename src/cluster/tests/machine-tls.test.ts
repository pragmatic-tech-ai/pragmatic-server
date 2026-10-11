import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { MachineTls } from '../machine-tls.js'

class TlsFixture
{
    public static Ref(): { certFile: string; keyFile: string; caFile: string }
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
})

test('Client material loads cert/key/ca', () =>
{
    const material = MachineTls.Client(TlsFixture.Ref())
    assert.ok(material.cert.length > 0 && material.key.length > 0 && material.ca.length > 0)
})
