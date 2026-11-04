import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IngressTlsPolicy, IngressTlsSource, InvalidIngressTlsError } from '../ingress-tls.js'
import type { IngressTls } from '../ingress-tls.js'
import { InClusterIdpSeedSource } from '../in-cluster-idp-seed.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'

class Samples
{
    public static readonly Existing: IngressTls = { source: IngressTlsSource.ExistingSecret, secretName: 'my-tls' }
    public static readonly Issuer: IngressTls = { source: IngressTlsSource.CertManager, clusterIssuer: 'letsencrypt' }
    public static readonly Dev: IngressTls = { source: IngressTlsSource.Development }
    public static readonly IngressName = 'pragmatic-env-a-server'
}

describe('IngressTlsPolicy', () =>
{
    it('Parse accepts each source', () =>
    {
        for (const sample of [Samples.Existing, Samples.Issuer, Samples.Dev])
        {
            assert.deepEqual(IngressTlsPolicy.Parse({ ...sample }), sample)
        }
    })

    it('Parse refuses a missing secret name', () =>
    {
        assert.throws(() => IngressTlsPolicy.Parse({ source: 'existing-secret' }), InvalidIngressTlsError)
    })

    it('Parse refuses a secret name with cert-manager', () =>
    {
        assert.throws(() => IngressTlsPolicy.Parse({ source: 'cert-manager', clusterIssuer: 'x', secretName: 'y' }), InvalidIngressTlsError)
    })

    it('Parse refuses an unknown source', () =>
    {
        assert.throws(() => IngressTlsPolicy.Parse({ source: 'magic' }), InvalidIngressTlsError)
        assert.throws(() => IngressTlsPolicy.Parse(undefined), InvalidIngressTlsError)
    })

    it('Parse refuses an uppercase secret name', () =>
    {
        assert.throws(() => IngressTlsPolicy.Parse({ source: 'existing-secret', secretName: 'My-Tls' }), InvalidIngressTlsError)
    })

    it('Parse refuses a missing issuer and stray values', () =>
    {
        assert.throws(() => IngressTlsPolicy.Parse({ source: 'cert-manager' }), InvalidIngressTlsError)
        assert.throws(() => IngressTlsPolicy.Parse({ source: 'development', secretName: 'x' }), InvalidIngressTlsError)
        assert.throws(() => IngressTlsPolicy.Parse({ source: 'development', clusterIssuer: 'x' }), InvalidIngressTlsError)
        assert.throws(() => IngressTlsPolicy.Parse({ source: 'existing-secret', secretName: 'x', clusterIssuer: 'y' }), InvalidIngressTlsError)
    })

    it('SecretNameFor names the Secret each source serves', () =>
    {
        assert.equal(IngressTlsPolicy.SecretNameFor(Samples.Existing, Samples.IngressName), 'my-tls')
        assert.equal(IngressTlsPolicy.SecretNameFor(Samples.Dev, Samples.IngressName), 'pragmatic-dev-tls')
        assert.equal(IngressTlsPolicy.SecretNameFor(Samples.Issuer, Samples.IngressName), 'pragmatic-env-a-server-ingress-tls')
    })

    it('the cert-manager Secret of an IdP Ingress never collides with the IdP server-key Secret', () =>
    {
        const idpName = K8sManifestBuilder.IdpNameOf('t1')
        assert.notEqual(IngressTlsPolicy.SecretNameFor(Samples.Issuer, idpName), InClusterIdpSeedSource.TlsSecretNameOf('t1'))
    })

    it('AnnotationsFor and CopiesSecret follow the source', () =>
    {
        assert.deepEqual(IngressTlsPolicy.AnnotationsFor(Samples.Issuer), { 'cert-manager.io/cluster-issuer': 'letsencrypt' })
        assert.deepEqual(IngressTlsPolicy.AnnotationsFor(Samples.Existing), {})
        assert.equal(IngressTlsPolicy.CopiesSecret(Samples.Existing), true)
        assert.equal(IngressTlsPolicy.CopiesSecret(Samples.Dev), true)
        assert.equal(IngressTlsPolicy.CopiesSecret(Samples.Issuer), false)
    })

    it('ToEnv and FromEnv round-trip; an empty env is undefined', () =>
    {
        for (const sample of [Samples.Existing, Samples.Issuer, Samples.Dev])
        {
            assert.deepEqual(IngressTlsPolicy.FromEnv(IngressTlsPolicy.ToEnv(sample)), sample)
        }
        assert.equal(IngressTlsPolicy.FromEnv({}), undefined)
    })
})
