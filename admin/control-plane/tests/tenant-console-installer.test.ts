import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterIdpSeedSource } from '../in-cluster-idp-seed.js'
import { IngressTlsPolicy, IngressTlsSource } from '../ingress-tls.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { KubectlError } from '../kubectl.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { UnknownHiveError } from '../rollout-errors.js'
import { TenantAdminBootstrap } from '../tenant-admin-bootstrap.js'
import {
    ConsoleInstallInProgressError,
    ConsoleInstallState,
    ConsoleInstallStep,
    ConsoleInstallUnavailableError,
    ConsoleNotConfiguredError,
    PlatformConsoleImageApproval,
} from '../tenant-console-installer.js'
import { ConsoleInstallFixture, FakeDevCa } from './console-install-fakes.js'
import type { IImageVerifier } from '../image-verifier.js'
import { DevCaError } from '../../../src/idp/dev-ca.js'
import type { HiveRecord } from '../platform-records.js'
import type { PlatformImageSigner } from '../platform-signing-key.js'

type Item = { kind: string; type?: string; metadata: { name: string; namespace?: string }; spec?: { rules?: Array<{ host?: string }> }; data?: Record<string, string> }

// Captures console.error while a test body runs.
class ErrorLog
{
    public static async Capture(body: () => Promise<void>): Promise<string>
    {
        const lines: string[] = []
        const original = console.error
        console.error = (...args: unknown[]) => { lines.push(args.map(a => String(a)).join(' ')) }
        try
        {
            await body()
        }
        finally
        {
            console.error = original
        }
        return lines.join('\n')
    }
}

class Items
{
    public static Of(manifestJson: string): Item[]
    {
        const parsed = JSON.parse(manifestJson) as { kind: string; items?: Item[] }
        return parsed.kind === 'List' ? parsed.items ?? [] : [parsed as unknown as Item]
    }

    public static Ingress(manifestJson: string, name: string): Item | undefined
    {
        return Items.Of(manifestJson).find(i => i.kind === 'Ingress' && i.metadata.name === name)
    }
}

describe('TenantConsoleInstaller', () =>
{
    let fx: ConsoleInstallFixture

    afterEach(() =>
    {
        fx?.Dispose()
    })

    it('refuses a hive without console settings', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const { console: _c, ...bare } = ConsoleInstallFixture.Hive('h2')
        fx.Hives.set('h2', bare)
        assert.throws(() => fx.Installer.Start('h2'), ConsoleNotConfiguredError)
        assert.throws(() => fx.Installer.Start('nope'), UnknownHiveError)
    })

    it('a non-Local hive or a disabled channel', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Hives.set('aks1', { ...ConsoleInstallFixture.Hive('aks1'), cluster: { backend: HiveBackend.Aks, mode: InfraMode.Attach } })
        assert.throws(() => fx.Installer.Start('aks1'), ConsoleInstallUnavailableError)
        fx.Dispose()
        fx = await ConsoleInstallFixture.Create({ channelOn: false })
        assert.throws(() => fx.Installer.Start('h1'), /agent channel is not configured/)
        assert.equal(fx.Installer.StatusFor('h1'), undefined)
    })

    it('Start is the one install check (there is no separate Supports)', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        assert.equal('Supports' in fx.Installer, false)
    })

    it('a second start while installing', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        let release: () => void = () => undefined
        fx.Kubectl.Hold = new Promise<void>(resolve => { release = resolve })
        const first = fx.Installer.Start('h1')
        assert.equal(first.state, ConsoleInstallState.Installing)
        assert.equal(fx.Installer.IsInstalling('h1'), true)
        assert.throws(() => fx.Installer.Start('h1'), ConsoleInstallInProgressError)
        fx.Kubectl.Hold = undefined
        release()
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
    })

    it('stops at checking-agent when the agent token Secret is missing', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Objects.delete(`pragmatic-system|secret/${K8sManifestBuilder.AgentTokenSecretNameOf('h1')}`)
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.step, ConsoleInstallStep.CheckingAgent)
        assert.equal(status?.error, 'Install the agent first: the console uses the hive agent token.')
        assert.equal(fx.Kubectl.Applied.length + fx.Kubectl.ServerApplied.length, 0)
    })

    it('development issues the wildcard and stores pragmatic-dev-tls in pragmatic-system and the IdP namespace', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        assert.deepEqual(fx.DevCa.Issued, [{ baseDomain: 'localtest.me', hosts: ['*.localtest.me', 'localtest.me'] }])
        const tls = fx.Kubectl.ServerApplied.map(m => Items.Of(m)).flat().filter(i => i.type === 'kubernetes.io/tls')
        // Per tenant in pragmatic-system (removing one console never breaks another); the name the IdP Ingress expects in its namespace.
        assert.deepEqual(tls.map(i => [i.metadata.namespace, i.metadata.name]), [
            ['pragmatic-system', K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf('acme')],
            [K8sManifestBuilder.IdpNameOf('acme'), IngressTlsPolicy.DevelopmentSecretName],
        ])
        assert.equal(Buffer.from(tls[0]?.data?.['tls.key'] ?? '', 'base64').toString(), FakeDevCa.KeyPem)
    })

    it('development lists an exact console host the wildcard does not cover', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'localtest.me', host: 'a.console.localtest.me', tls: { source: IngressTlsSource.Development } } })
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        assert.deepEqual(fx.DevCa.Issued[0]?.hosts, ['*.localtest.me', 'localtest.me', 'a.console.localtest.me'])
    })

    it('existing-secret of the wrong type fails at preparing-certificates', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'example.com', tls: { source: IngressTlsSource.ExistingSecret, secretName: 'corp-tls' } } })
        fx.Kubectl.Put('pragmatic-system', 'secret/corp-tls', { type: 'Opaque', data: { 'tls.crt': 'eA==', 'tls.key': 'eA==' } })
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.step, ConsoleInstallStep.PreparingCertificates)
        assert.match(status?.error ?? '', /The TLS Secret corp-tls was not found in pragmatic-system, or is not a kubernetes\.io\/tls Secret\./)
        assert.equal(fx.Kubectl.Applied.length + fx.Kubectl.ServerApplied.length, 0)
    })

    it('existing-secret copies the operator Secret into the IdP namespace under its own name', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'example.com', tls: { source: IngressTlsSource.ExistingSecret, secretName: 'corp-tls' } } })
        fx.Kubectl.Put('pragmatic-system', 'secret/corp-tls', { type: 'kubernetes.io/tls', data: { 'tls.crt': 'Y2VydA==', 'tls.key': 'a2V5' } })
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const tls = fx.Kubectl.ServerApplied.map(m => Items.Of(m)).flat().filter(i => i.type === 'kubernetes.io/tls')
        assert.deepEqual(tls.map(i => [i.metadata.namespace, i.metadata.name, i.data?.['tls.key']]), [[K8sManifestBuilder.IdpNameOf('acme'), 'corp-tls', 'a2V5']])
        assert.equal(fx.DevCa.Issued.length, 0)
    })

    it('a hive without a trust root fails at preparing-certificates with a plain sentence', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const { trustRootRef: _t, ...rest } = ConsoleInstallFixture.Hive('h1')
        fx.Hives.set('h1', rest)
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.step, ConsoleInstallStep.PreparingCertificates)
        assert.match(status?.error ?? '', /^This hive has no trust root/)
        assert.equal(fx.Kubectl.Applied.length, 0)
    })

    it('never registers a new agent token', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        assert.equal(fx.Registrar.Calls, 0)
        const all = [...fx.Kubectl.Applied, ...fx.Kubectl.ServerApplied].map(m => Items.Of(m)).flat()
        assert.ok(!all.some(i => i.metadata.name === K8sManifestBuilder.AgentTokenSecretNameOf('h1')))
        assert.ok(!all.some(i => i.metadata.name === K8sManifestBuilder.HiveAgentNameOf('h1')))
    })

    it('runs the steps in order and ends deployed', async () =>
    {
        fx = await ConsoleInstallFixture.Create({ runningIdp: false })
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        const idp = K8sManifestBuilder.IdpNameOf('acme')
        const admin = K8sManifestBuilder.TenantAdminNameOf('acme')
        const run = (Items.Of(fx.Kubectl.ServerApplied[2] as string)[0] as unknown as { metadata: { labels: Record<string, string> } }).metadata.labels['pragmatic/tls-copy-run']
        assert.deepEqual(fx.Kubectl.Calls.filter(c => c[0] !== 'Find'), [
            ['ServesResource', 'admissionregistration.k8s.io/v1', 'validatingadmissionpolicies'],
            ['ServesResource', 'admissionregistration.k8s.io/v1', 'validatingadmissionpolicybindings'],
            ['Apply'],
            ['ApplyServerSide'],
            ['ApplyServerSide'],
            ['ApplyServerSide'],
            ['ApplyServerSide'],
            ['DeleteBySelector', idp, 'secret', 'pragmatic/hive=h1,pragmatic/tls-copy=true,pragmatic/tls-copy-run!=' + run],
            ['Remember', 'acme'],
            ['RolloutRestart', idp, idp],
            ['RolloutRestart', 'pragmatic-system', admin],
            ['RolloutStatus', idp, idp],
            ['RolloutStatus', 'pragmatic-system', admin],
            ['SeedOwner', 'h1'],
        ])
        // Bootstrap secrets (pragmatic-system), then the freshly minted IdP seed Secrets (IdP namespace), then the two TLS copies.
        const [bootstrapSecrets, idpSeed] = fx.Kubectl.ServerApplied.map(m => Items.Of(m))
        assert.ok(bootstrapSecrets?.every(i => i.metadata.namespace === 'pragmatic-system'))
        assert.deepEqual(idpSeed?.map(i => i.metadata.name), [InClusterIdpSeedSource.TlsSecretNameOf('acme'), InClusterIdpSeedSource.AdminSecretNameOf('acme')])
        assert.deepEqual({ state: status?.state, consoleUrl: status?.consoleUrl, devCaFile: status?.devCaFile },
            { state: 'deployed', consoleUrl: 'https://console-acme.localtest.me', devCaFile: fx.DevCa.CaFileOf('localtest.me') })
        assert.ok(status?.finishedAt !== undefined && status.error === undefined)
        // The IdP credentials the control plane keeps are the ones it just minted and applied.
        const token = Buffer.from(idpSeed?.[1]?.data?.['admin-token'] ?? '', 'base64').toString()
        assert.equal(fx.IdpAdmin.Remembered[0]?.adminToken, token)
    })

    it('a reinstall reuses the running IdP CA and admin token and applies no IdP seed', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        const applied = fx.Kubectl.ServerApplied.map(m => Items.Of(m)).flat()
        assert.ok(!applied.some(i => i.metadata.name === InClusterIdpSeedSource.AdminSecretNameOf('acme')))
        assert.deepEqual(fx.IdpAdmin.Remembered.map(r => [r.adminToken, r.ca.toString()]), [[ConsoleInstallFixture.RunningIdpToken, ConsoleInstallFixture.RunningIdpCa]])
    })

    it('reinstall with a new host updates the Ingress and keeps the fingerprint key and the master key', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const admin = K8sManifestBuilder.TenantAdminNameOf('acme')
        const fingerprintKey = `pragmatic-system|secret/${TenantAdminBootstrap.FingerprintKeySecretNameOf('acme')}`
        const seedKey = `pragmatic-system|secret/${K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme')}`
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        const firstFingerprint = (JSON.parse(fx.Kubectl.Objects.get(fingerprintKey) as string) as Item).data?.['fingerprint.key']
        const firstMaster = (JSON.parse(fx.Kubectl.Objects.get(seedKey) as string) as Item).data?.['master.key']
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'localtest.me', host: 'portal.localtest.me', tls: { source: IngressTlsSource.Development } } })
        fx.Installer.Start('h1')
        const second = await fx.Installer.WhenSettled('h1')
        assert.equal(second?.consoleUrl, 'https://portal.localtest.me')
        const ingress = Items.Ingress(fx.Kubectl.Applied[1] as string, admin)
        assert.equal(ingress?.spec?.rules?.[0]?.host, 'portal.localtest.me')
        assert.equal((JSON.parse(fx.Kubectl.Objects.get(fingerprintKey) as string) as Item).data?.['fingerprint.key'], firstFingerprint)
        assert.equal((JSON.parse(fx.Kubectl.Objects.get(seedKey) as string) as Item).data?.['master.key'], firstMaster)
        assert.ok(firstFingerprint !== undefined && firstMaster !== undefined)
    })

    it('a reinstall switching to cert-manager deletes the stale TLS-read Role and development copy first', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'example.com', tls: { source: IngressTlsSource.CertManager, clusterIssuer: 'letsencrypt' } } })
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const verbs = fx.Kubectl.Verbs()
        assert.ok(verbs.indexOf('DeleteManifest') < verbs.indexOf('Apply'))
        const stale = Items.Of(fx.Kubectl.Deleted[0] as string).map(i => i.kind + '/' + i.metadata.name)
        const role = K8sManifestBuilder.TenantConsoleTlsRoleNameOf('acme')
        assert.deepEqual(stale.sort(), ['Role/' + role, 'RoleBinding/' + role, 'Secret/' + K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf('acme')].sort())
        assert.equal(fx.Installer.StatusFor('h1')?.devCaFile, undefined)
    })

    it('status, errors and logs never carry secrets', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const fingerprints = fx.Fingerprints
        fx.Kubectl.ServerApplyFail = {
            at: 0,
            error: async () =>
            {
                const key = await fingerprints.Get('h1') as Buffer
                // Unredacted on purpose: only the installer's own scrub can keep these out.
                return new KubectlError(`apply failed ${ConsoleInstallFixture.RunningIdpToken} ${key.toString('base64')} ${key.toString('hex')} ${FakeDevCa.KeyPem}`, 'kubectl failed: ', false)
            },
        }
        let status: unknown
        const log = await ErrorLog.Capture(async () =>
        {
            fx.Installer.Start('h1')
            status = await fx.Installer.WhenSettled('h1')
        })
        const key = await fingerprints.Get('h1') as Buffer
        const text = JSON.stringify(status) + '\n' + log
        assert.equal((status as { step: string }).step, ConsoleInstallStep.StoringSecrets)
        assert.match((status as { error: string }).error, /^Could not store the console's Secrets in the cluster\. kubectl failed: apply failed \[REDACTED\]/)
        for (const secret of [ConsoleInstallFixture.RunningIdpToken, key.toString('base64'), key.toString('hex'), 'fake.dev.leaf.key.Zq'])
        {
            assert.ok(!text.includes(secret), 'leaked a secret')
        }
        assert.match(log, /\[console-install\] hive h1 failed at storing-secrets: KubectlError/)
    })

    it('a certificate failure is named and explained in the status and the log, with secret-looking runs scrubbed', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const opaque = 'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTBhYmNkZWY='
        fx.DevCa.IssueError = new DevCaError('Development CA: openssl failed (is the openssl CLI installed and on PATH?): string too long maxsize=64 ' + opaque)
        let status: Awaited<ReturnType<typeof fx.Installer.WhenSettled>>
        const log = await ErrorLog.Capture(async () =>
        {
            fx.Installer.Start('h1')
            status = await fx.Installer.WhenSettled('h1')
        })
        assert.equal(status!?.step, ConsoleInstallStep.PreparingCertificates)
        assert.match(status!?.error ?? '', /^Could not prepare the console's certificates and settings\. Development CA: openssl failed .*string too long maxsize=64/)
        assert.match(log, /\[console-install\] hive h1 failed at preparing-certificates: DevCaError: Development CA: openssl failed .*string too long maxsize=64/)
        assert.ok(!(status!?.error ?? '').includes(opaque))
        assert.ok(!log.includes(opaque))
    })

    it('a failure that is not a known showable error still logs only its name', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.DevCa.IssueError = new TypeError('raw internal detail')
        const log = await ErrorLog.Capture(async () =>
        {
            fx.Installer.Start('h1')
            await fx.Installer.WhenSettled('h1')
        })
        assert.match(log, /failed at preparing-certificates: TypeError$/m)
        assert.ok(!log.includes('raw internal detail'))
    })

    it('a first install scrubs the master key it minted and the fresh IdP server key', async () =>
    {
        fx = await ConsoleInstallFixture.Create({ runningIdp: false })
        const kubectl = fx.Kubectl
        const seedKey = `pragmatic-system|secret/${K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme')}`
        const secrets: string[] = []
        kubectl.ServerApplyFail = {
            at: 1,
            error: async () =>
            {
                const master = Buffer.from((JSON.parse(kubectl.Objects.get(seedKey) as string) as Item).data?.['master.key'] ?? '', 'base64')
                const serverKey = Buffer.from(Items.Of(kubectl.ServerApplied[1] as string)[0]?.data?.['server.key'] ?? '', 'base64')
                secrets.push(master.toString('base64'), master.toString('hex'), serverKey.toString('base64'), serverKey.toString('utf8').trim())
                return new KubectlError('apply failed ' + secrets.join(' '), 'kubectl failed: ', false)
            },
        }
        let status: unknown
        await ErrorLog.Capture(async () =>
        {
            fx.Installer.Start('h1')
            status = await fx.Installer.WhenSettled('h1')
        })
        assert.equal((status as { step: string }).step, ConsoleInstallStep.StoringSecrets)
        assert.equal(secrets.length, 4)
        assert.ok(secrets.every(s => s.length >= 32))
        for (const secret of secrets)
        {
            assert.ok(!JSON.stringify(status).includes(secret), 'leaked a secret')
        }
    })

    it('a half IdP Secret pair left by a first install that never completed is deleted and the IdP is minted fresh', async () =>
    {
        fx = await ConsoleInstallFixture.Create({ runningIdp: false })
        const ns = K8sManifestBuilder.IdpNameOf('acme')
        const tlsName = InClusterIdpSeedSource.TlsSecretNameOf('acme')
        fx.Kubectl.Put(ns, 'secret/' + tlsName, { data: { 'ca.crt': Buffer.from('half').toString('base64') } })
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const leftover = fx.Kubectl.Deleted.map(m => Items.Of(m)).flat().filter(i => i.metadata.namespace === ns && i.metadata.name === tlsName)
        assert.equal(leftover.length, 1)
        // Both IdP Secrets land in ONE server-side apply.
        const idpSeed = fx.Kubectl.ServerApplied.map(m => Items.Of(m)).find(items => items.some(i => i.metadata.name === tlsName))
        assert.deepEqual(idpSeed?.map(i => i.metadata.name), [tlsName, InClusterIdpSeedSource.AdminSecretNameOf('acme')])
        assert.notEqual(fx.IdpAdmin.Remembered[0]?.ca.toString(), 'half')
    })

    it('a half IdP Secret pair after a completed install (credentials sealed) fails at preparing-certificates and never mints a new CA', async () =>
    {
        fx = await ConsoleInstallFixture.Create({ runningIdp: false })
        fx.IdpAdmin.Sealed.add('acme')
        const ns = K8sManifestBuilder.IdpNameOf('acme')
        fx.Kubectl.Put(ns, 'secret/' + InClusterIdpSeedSource.AdminSecretNameOf('acme'), { data: { 'admin-token': Buffer.from('tok').toString('base64') } })
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.step, ConsoleInstallStep.PreparingCertificates)
        assert.match(status?.error ?? '', new RegExp(InClusterIdpSeedSource.TlsSecretNameOf('acme') + ' is missing'))
        assert.equal(fx.Kubectl.Applied.length + fx.Kubectl.ServerApplied.length, 0)
        assert.deepEqual(fx.IdpAdmin.Remembered, [])
    })

    it('an existing-secret named like the IdP own TLS or admin Secret is refused before anything is applied', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const own = InClusterIdpSeedSource.TlsSecretNameOf('acme')
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'example.com', tls: { source: IngressTlsSource.ExistingSecret, secretName: own } } })
        fx.Kubectl.Put('pragmatic-system', 'secret/' + own, { type: 'kubernetes.io/tls', data: { 'tls.crt': 'eA==', 'tls.key': 'eA==' } })
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.step, ConsoleInstallStep.PreparingCertificates)
        assert.match(status?.error ?? '', /identity provider/)
        assert.equal(fx.Kubectl.Applied.length + fx.Kubectl.ServerApplied.length, 0)
    })

    it('a TLS-source switch applies the new key copy first, then sweeps only the earlier copies out of the IdP namespace', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const ns = K8sManifestBuilder.IdpNameOf('acme')
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        type Labelled = { metadata: { labels?: Record<string, string> } }
        const firstCopies = fx.Kubectl.ServerApplied.map(m => Items.Of(m)).flat().filter(i => i.type === 'kubernetes.io/tls') as unknown as Labelled[]
        assert.ok(firstCopies.length > 0 && firstCopies.every(i => i.metadata.labels?.['pragmatic/tls-copy'] === 'true'))
        const firstRun = firstCopies[0]!.metadata.labels?.['pragmatic/tls-copy-run'] ?? ''
        assert.match(firstRun, /^[0-9a-f]{12}$/)
        fx.Kubectl.Calls.length = 0
        fx.Kubectl.ServerApplied.length = 0
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.ExistingSecret, secretName: 'corp-tls' } } })
        fx.Kubectl.Put('pragmatic-system', 'secret/corp-tls', { type: 'kubernetes.io/tls', data: { 'tls.crt': 'Y2VydA==', 'tls.key': 'a2V5' } })
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const copy = fx.Kubectl.ServerApplied.map(m => Items.Of(m)).flat().find(i => i.type === 'kubernetes.io/tls' && i.metadata.namespace === ns) as unknown as Labelled & { metadata: { name: string } }
        assert.equal(copy.metadata.name, 'corp-tls')
        const run = copy.metadata.labels?.['pragmatic/tls-copy-run'] ?? ''
        assert.ok(run !== firstRun && /^[0-9a-f]{12}$/.test(run))
        const sweep = fx.Kubectl.Calls.findIndex(c => c[0] === 'DeleteBySelector')
        assert.deepEqual(fx.Kubectl.Calls[sweep], ['DeleteBySelector', ns, 'secret', 'pragmatic/hive=h1,pragmatic/tls-copy=true,pragmatic/tls-copy-run!=' + run])
        // The IdP Ingress never goes without a certificate: the new copy lands before the old ones go.
        const verbs = fx.Kubectl.Calls.map(c => c[0])
        assert.ok(sweep > verbs.lastIndexOf('ApplyServerSide'))
    })

    it('a TLS-source switch also deletes the unlabelled earlier copy the IdP Ingress named, and pragmatic-dev-tls, never the IdP own Secrets', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const ns = K8sManifestBuilder.IdpNameOf('acme')
        // An install from before TLS copies were labelled: the IdP Ingress serves an existing-secret copy.
        fx.Kubectl.Put(ns, 'ingress/' + ns, { metadata: { name: ns }, spec: { tls: [{ hosts: ['idp-acme.example.com'], secretName: 'old-corp-tls' }] } })
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'example.com', tls: { source: IngressTlsSource.CertManager, clusterIssuer: 'le' } } })
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const deleted = fx.Kubectl.Deleted.map(m => Items.Of(m)).flat().filter(i => i.metadata.namespace === ns).map(i => i.kind + '/' + i.metadata.name)
        assert.deepEqual(deleted.sort(), ['Secret/old-corp-tls', 'Secret/' + IngressTlsPolicy.DevelopmentSecretName].sort())
        assert.ok(!deleted.includes('Secret/' + InClusterIdpSeedSource.TlsSecretNameOf('acme')))
        assert.ok(!deleted.includes('Secret/' + InClusterIdpSeedSource.AdminSecretNameOf('acme')))
    })

    it('the copy the new source still uses is not deleted by the switch cleanup', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const ns = K8sManifestBuilder.IdpNameOf('acme')
        fx.Kubectl.Put(ns, 'ingress/' + ns, { metadata: { name: ns }, spec: { tls: [{ secretName: IngressTlsPolicy.DevelopmentSecretName }] } })
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        assert.ok(!fx.Kubectl.Deleted.map(m => Items.Of(m)).flat().some(i => i.metadata.namespace === ns))
    })

    it('a first install failing after storing-secrets is retried with the same master key', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const seedKey = `pragmatic-system|secret/${K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme')}`
        fx.Kubectl.RolloutStatusError = new KubectlError('rollout timed out')
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.step, ConsoleInstallStep.WaitingForRollout)
        const first = (JSON.parse(fx.Kubectl.Objects.get(seedKey) as string) as Item).data?.['master.key']
        fx.Kubectl.RolloutStatusError = undefined
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const second = (JSON.parse(fx.Kubectl.Objects.get(seedKey) as string) as Item).data?.['master.key']
        assert.ok(first !== undefined && first.length > 0)
        assert.equal(second, first)
    })

    it('a deleted hive stops the install before its next step', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        let release: () => void = () => undefined
        fx.Kubectl.Hold = new Promise<void>(resolve => { release = resolve })
        fx.Installer.Start('h1')
        fx.Hives.delete('h1')
        fx.Kubectl.Hold = undefined
        release()
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.error, 'The install stopped: the hive was deleted while it ran.')
        assert.equal(fx.Kubectl.Applied.length, 0)
    })

    it('Uninstall deletes the console removal manifest', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        await fx.Installer.Uninstall(fx.Hives.get('h1') as HiveRecord)
        assert.deepEqual(fx.Kubectl.Deleted, [new K8sManifestBuilder().TenantConsoleRemovalManifest('acme', 'h1')])
    })

    it('Uninstall stops the in-hive IdP, sweeps its key copies, and returns what it kept: data, IdP Secrets and the environment namespaces', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const system = K8sManifestBuilder.SystemNamespace
        fx.Kubectl.Put(system, 'persistentvolumeclaim/' + K8sManifestBuilder.TenantAdminClaimNameOf('acme'), {})
        fx.Kubectl.Put(system, 'secret/' + K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme'), {})
        fx.Kubectl.Put(K8sManifestBuilder.IdpNameOf('acme'), 'persistentvolumeclaim/' + K8sManifestBuilder.IdpClaimNameOf('acme'), {})
        fx.Kubectl.Namespaces.set('pragmatic-env-dev', { 'pragmatic/hive': 'h1' })
        fx.Kubectl.Namespaces.set('pragmatic-env-elsewhere', { 'pragmatic/hive': 'h2' })
        const retained = await fx.Installer.Uninstall(fx.Hives.get('h1') as HiveRecord)
        assert.deepEqual(retained, [
            K8sManifestBuilder.TenantAdminClaimNameOf('acme'),
            K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme'),
            K8sManifestBuilder.IdpClaimNameOf('acme'),
            InClusterIdpSeedSource.TlsSecretNameOf('acme'),
            InClusterIdpSeedSource.AdminSecretNameOf('acme'),
            'pragmatic-env-dev',
        ])
        assert.deepEqual(fx.Kubectl.Calls.filter(c => c[0] === 'DeleteBySelector'), [['DeleteBySelector', K8sManifestBuilder.IdpNameOf('acme'), 'secret', 'pragmatic/hive=h1,pragmatic/tls-copy=true']])
        // The environments keep running: removal never deletes a namespace.
        assert.ok(!fx.Kubectl.Calls.some(c => c[0] === 'DeleteNamespacesBySelector' || c[0] === 'DeleteNamespace'))
        assert.deepEqual([...fx.Kubectl.Namespaces.keys()], ['pragmatic-env-dev', 'pragmatic-env-elsewhere'])
    })

    it('the console NetworkPolicy admits the ingress controller namespace of the console settings (ingress-nginx by default)', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        const fromOf = (manifest: string): unknown => (Items.Of(manifest).find(i => i.kind === 'NetworkPolicy') as unknown as { spec: { ingress: Array<{ from: unknown }> } }).spec.ingress[0]!.from
        assert.deepEqual(fromOf(fx.Kubectl.Applied[0]!), [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' } } }])
        fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development }, ingressNamespace: 'ingress' } })
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        assert.deepEqual(fromOf(fx.Kubectl.Applied[1]!), [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ingress' } } }])
    })

    it('refuses a cluster below Kubernetes 1.30 (no ValidatingAdmissionPolicy) at checking-agent, before anything is applied', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.ServedResources.delete('admissionregistration.k8s.io/v1|validatingadmissionpolicies')
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.step, ConsoleInstallStep.CheckingAgent)
        assert.match(status?.error ?? '', /^This cluster does not serve ValidatingAdmissionPolicy .*Kubernetes 1\.30 or newer\.$/)
        assert.deepEqual(fx.Kubectl.Applied, [])
        assert.deepEqual(fx.Kubectl.ServerApplied, [])
    })

    it('Uninstall on a cluster that does not serve the admission policy kind leaves its identities out of the removal', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.ServedResources.clear()
        await fx.Installer.Uninstall(fx.Hives.get('h1') as HiveRecord)
        assert.deepEqual(fx.Kubectl.Deleted, [new K8sManifestBuilder().TenantConsoleRemovalManifest('acme', 'h1', false)])
        assert.ok(!fx.Kubectl.Deleted[0]!.includes('ValidatingAdmissionPolicy'))
    })

    it('removal does not need the agent channel: a Local hive with a safe id can always be uninstalled', async () =>
    {
        fx = await ConsoleInstallFixture.Create({ channelOn: false })
        assert.equal(fx.Installer.CanUninstall(fx.Hives.get('h1') as HiveRecord), true)
        assert.equal(fx.Installer.CanUninstall({ ...ConsoleInstallFixture.Hive('aks1'), cluster: { backend: HiveBackend.Aks, mode: InfraMode.Attach } }), false)
        assert.equal(fx.Installer.CanUninstall(ConsoleInstallFixture.Hive('Bad_Id')), false)
    })

    it('Uninstall leaves a console another hive owns untouched', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put('pragmatic-system', 'deployment/' + K8sManifestBuilder.TenantAdminNameOf('acme'), { metadata: { name: 'x', labels: { 'pragmatic/hive': 'other' } } })
        await fx.Installer.Uninstall(fx.Hives.get('h1') as HiveRecord)
        assert.deepEqual(fx.Kubectl.Deleted, [])
    })

    it('Forget drops the fingerprint key and the in-hive IdP credentials', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        await fx.Fingerprints.Ensure('h1')
        await fx.Installer.Forget(fx.Hives.get('h1') as HiveRecord)
        assert.equal(await fx.Fingerprints.Get('h1'), undefined)
        assert.deepEqual(fx.IdpAdmin.Forgotten, ['acme'])
    })

    it('Forget of a hive without a console keeps the tenant in-hive IdP credentials (they belong to the console hive)', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        const second: HiveRecord = { ...ConsoleInstallFixture.Hive('h2'), console: undefined }
        await fx.Fingerprints.Ensure('h2')
        await fx.Installer.Forget(second)
        assert.equal(await fx.Fingerprints.Get('h2'), undefined)
        assert.deepEqual(fx.IdpAdmin.Forgotten, [])
    })

    it('an Owner seeding failure fails the install at seeding-owner', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.IdpAdmin.SeedError = new Error('raw idp text must not show')
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.step, ConsoleInstallStep.SeedingOwner)
        assert.equal(status?.error, "Could not seed the tenant's Owner in the in-hive identity provider.")
    })
})

describe('PlatformConsoleImageApproval', () =>
{
    it('signs for a platform-trusting hive, verifies against its trust root, and approves the pulled ref', async () =>
    {
        const signed: string[] = []
        const verified: Array<[string, string | undefined]> = []
        const signer = { SignsFor: (h: HiveRecord) => h.trustRootRef === 'platform-signing', Sign: async (ref: string) => { signed.push(ref) } } as unknown as PlatformImageSigner
        const verifier: IImageVerifier = { Verify: async (ref, root) => { verified.push([ref, root]) } }
        const hive: HiveRecord = { ...ConsoleInstallFixture.Hive('h1'), registry: { mode: InfraMode.Attach, endpoint: 'registry.local:5000' } }
        const approved = await new PlatformConsoleImageApproval(signer, verifier).Approve(hive, 'pragmatic-server:dev')
        assert.deepEqual(approved, { imageRef: 'registry.local:5000/pragmatic-server:dev' })
        assert.deepEqual(signed, ['registry.local:5000/pragmatic-server:dev'])
        assert.deepEqual(verified, [['registry.local:5000/pragmatic-server:dev', 'platform-signing']])
        signed.length = 0
        await new PlatformConsoleImageApproval(signer, verifier).Approve({ ...hive, trustRootRef: 'own-root' }, 'pragmatic-server:dev')
        assert.deepEqual(signed, [])
    })

    it('a failed verification is not approved', async () =>
    {
        const verifier: IImageVerifier = { Verify: async () => { throw new Error('no signature') } }
        await assert.rejects(new PlatformConsoleImageApproval(undefined, verifier).Approve(ConsoleInstallFixture.Hive('h1'), 'x:1'), /no signature/)
    })
})
