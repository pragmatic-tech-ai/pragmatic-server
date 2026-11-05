import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HiveConsoleSpecs, InvalidHiveConsoleError } from '../hive-console-spec.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'
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

test('refuses unknown fields, at the top level and inside tls', () =>
{
    assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', hots: 'x', tls: { source: 'development' } }), /not a console setting/)
    assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'development', extra: 1 } }), /not a TLS setting/)
})

test('refuses an empty-string host instead of treating it as absent', () =>
{
    assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', host: '', tls: { source: 'development' } }), InvalidHiveConsoleError)
})

test('Validate refuses a tenant whose default host is not a DNS name, and a development host outside the base domain', () =>
{
    const spec = HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'development' } })
    HiveConsoleSpecs.Validate(spec, 'acme')
    for (const tenantId of ['Acme_1', 'a'.repeat(64), 'has space'])
    {
        assert.throws(() => HiveConsoleSpecs.Validate(spec, tenantId), InvalidHiveConsoleError, tenantId)
    }
    const outside = { baseDomain: 'localtest.me', host: 'console.example.com', tls: { source: IngressTlsSource.Development } }
    assert.throws(() => HiveConsoleSpecs.Validate(outside, 'acme'), /base domain or a name under it/)
})

test('an ingress controller namespace is optional, kept when given, and defaults to ingress-nginx', () =>
{
    const plain = HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'development' } })
    assert.equal(plain.ingressNamespace, undefined)
    assert.equal(HiveConsoleSpecs.IngressNamespaceOf(plain), 'ingress-nginx')
    const custom = HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'development' }, ingressNamespace: 'kube-system' })
    assert.deepEqual(custom, { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development }, ingressNamespace: 'kube-system' })
    assert.equal(HiveConsoleSpecs.IngressNamespaceOf(custom), 'kube-system')
})

test('the ingress controller namespace must be a DNS-1123 label', () =>
{
    for (const ingressNamespace of ['', 'Ingress', 'a.b', '-x', 'x-', 'a'.repeat(64), 5, 'has space'])
    {
        assert.throws(() => HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'development' }, ingressNamespace }),
            (e: unknown) => e instanceof InvalidHiveConsoleError && /ingress controller namespace/.test((e as Error).message), String(ingressNamespace))
    }
    assert.equal(HiveConsoleSpecs.Parse({ baseDomain: 'localtest.me', tls: { source: 'development' }, ingressNamespace: 'a'.repeat(63) }).ingressNamespace, 'a'.repeat(63))
})

test('ConsoleHiveOf finds the hive running the console', () =>
{
    const base = { tenantId: 't1', displayName: 'H', createdAt: '2026-11-05T00:00:00.000Z', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: 'k' }, registry: { mode: InfraMode.Attach, endpoint: 'r', credentialRef: 'c' } }
    const plain: HiveRecord = { ...base, id: 'h1' }
    const withConsole: HiveRecord = { ...base, id: 'h2', console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } } }
    assert.equal(HiveConsoleSpecs.ConsoleHiveOf([plain, withConsole])?.id, 'h2')
    assert.equal(HiveConsoleSpecs.ConsoleHiveOf([plain]), undefined)
    assert.equal(HiveConsoleSpecs.ConsoleHiveOf([]), undefined)
})
