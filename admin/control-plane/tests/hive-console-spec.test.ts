import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HiveConsoleSpecs, InvalidHiveConsoleError } from '../hive-console-spec.js'
import { InvalidIngressTlsError, IngressTlsSource } from '../ingress-tls.js'

test('parses a minimal development spec', () =>
{
    const spec = HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'development' } })
    assert.deepEqual(spec, { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } })
})

test('HostOf defaults to console-<tenant>.<baseDomain> and honors an explicit host', () =>
{
    const spec = HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'development' } })
    assert.equal(HiveConsoleSpecs.HostOf(spec, 't1'), 'console-t1.localtest.me')
    const explicit = HiveConsoleSpecs.Parse({ baseDomain: 'example.com', host: 'console.example.com', tls: { source: 'cert-manager', clusterIssuer: 'le' } })
    assert.equal(HiveConsoleSpecs.HostOf(explicit, 't1'), 'console.example.com')
})

test('refuses an upper-case, single-label, dotted-edge or public-suffix base domain', () =>
{
    for (const baseDomain of ['LocalTest.me', 'localhost', '.example.com', 'example.com.', 'co.uk', 5, undefined])
    {
        assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain, tls: { source: 'development' } }), InvalidHiveConsoleError, String(baseDomain))
    }
})

test('development TLS refuses a host outside the base domain; other sources allow it', () =>
{
    assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', host: 'console.example.com', tls: { source: 'development' } }), /base domain or a name under it/)
    const spec = HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', host: 'console.example.com', tls: { source: 'existing-secret', secretName: 'wild' } })
    assert.equal(spec.host, 'console.example.com')
})

test('refuses a bad host, a non-object body and a bad TLS choice with plain errors', () =>
{
    assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', host: 'Bad Host', tls: { source: 'development' } }), InvalidHiveConsoleError)
    assert.throws(() => HiveConsoleSpecs.Parse('x'), InvalidHiveConsoleError)
    assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'nope' } }), InvalidIngressTlsError)
    assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me' }), InvalidIngressTlsError)
})
