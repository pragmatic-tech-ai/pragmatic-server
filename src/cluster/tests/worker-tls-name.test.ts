import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PeerCertificate } from 'node:tls'
import { WorkerTlsName } from '../worker-tls-name.js'

class TlsNameFixture
{
    public static Cert(subjectAltName: string): PeerCertificate
    {
        return { subject: {}, subjectaltname: subjectAltName } as unknown as PeerCertificate
    }
}

test('a DNS worker name goes out as SNI with the default identity check', () =>
{
    assert.deepEqual(WorkerTlsName.OptionsFor('worker.internal'), { servername: 'worker.internal' })
})

test('no configured worker name leaves SNI to the TLS defaults', () =>
{
    assert.deepEqual(WorkerTlsName.OptionsFor(undefined), { servername: undefined })
})

test('an IP worker name sends no SNI and checks the certificate against that IP, not the dialled host', () =>
{
    const options = WorkerTlsName.OptionsFor('127.0.0.1')
    assert.equal(options.servername, '')
    const check = options.checkServerIdentity!
    assert.equal(check('worker.internal', TlsNameFixture.Cert('IP Address:127.0.0.1')), undefined)
    assert.ok(check('127.0.0.1', TlsNameFixture.Cert('IP Address:10.0.0.9')) instanceof Error)
})

test('an IPv6 worker name is treated as an IP too', () =>
{
    assert.equal(WorkerTlsName.OptionsFor('::1').servername, '')
})
