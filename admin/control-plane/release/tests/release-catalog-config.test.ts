import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReleaseCatalogConfig, ReleaseConfigError } from '../release-catalog-config.js'
import { ClientRegistry } from '../../client-registry.js'
import { TenantRegistry } from '../../tenant-registry.js'
import { HiveRegistry } from '../../hive-registry.js'
import { PlatformDirectory } from '../../platform-directory.js'
import { HiveOrchestratorFactory } from '../../hive-orchestrator-factory.js'
import type { PlatformDeploymentRegistry } from '../../platform-deployment-registry.js'
import { RolloutFixture } from '../../tests/rollout-fixture.js'
import { ControlPlaneServer } from '../../server.js'
import { ControlPlaneRole } from '../../control-plane-role.js'

class Fx
{
    public static readonly RepoRoot = join(import.meta.dirname, '..', '..', '..', '..')
    public static readonly Token = 'ghp_SECRET_token_in_the_file'
    public static readonly CredentialVar = 'PRAGMATIC_RELEASE_CREDENTIAL_FILE'
    public static readonly PollVar = 'PRAGMATIC_RELEASE_POLL_SECONDS'
}

describe('ReleaseCatalogConfig', () =>
{
    let dir: string
    let deployments: PlatformDeploymentRegistry

    beforeEach(async () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'release-config-'))
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dir, 'clients.json')),
            new TenantRegistry(join(dir, 'tenants.json')),
            new HiveRegistry(join(dir, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        deployments = await RolloutFixture.Create(dir, directory, new HiveOrchestratorFactory())
    })

    afterEach(() =>
    {
        rmSync(dir, { recursive: true, force: true })
    })

    function Credential(content: string): string
    {
        const file = join(dir, 'credential.json')
        writeFileSync(file, content)
        return file
    }

    it('polls every 300 seconds by default, accepts a whole number and 0 (off)', () =>
    {
        assert.equal(ReleaseCatalogConfig.PollSecondsOf({}), 300)
        assert.equal(ReleaseCatalogConfig.PollSecondsOf({ [Fx.PollVar]: '' }), 300)
        assert.equal(ReleaseCatalogConfig.PollSecondsOf({ [Fx.PollVar]: '15' }), 15)
        assert.equal(ReleaseCatalogConfig.PollSecondsOf({ [Fx.PollVar]: '0' }), 0)
    })

    it('refuses a negative, fractional, non-numeric or oversized poll interval with a sentence naming only the variable', () =>
    {
        for (const raw of ['-1', '1.5', 'abc', ' 5', '1e3', '99999999'])
        {
            assert.throws(() => ReleaseCatalogConfig.PollSecondsOf({ [Fx.PollVar]: raw }), (err: unknown) =>
                err instanceof ReleaseConfigError && err.message.includes(Fx.PollVar) && !err.message.includes(raw), raw)
        }
    })

    it('has no credential when the variable is absent or blank', () =>
    {
        assert.equal(ReleaseCatalogConfig.CredentialOf({}), undefined)
        assert.equal(ReleaseCatalogConfig.CredentialOf({ [Fx.CredentialVar]: '' }), undefined)
    })

    it('reads { username, token } from the credential file', () =>
    {
        const file = Credential(JSON.stringify({ username: 'bot', token: Fx.Token }))
        assert.deepEqual(ReleaseCatalogConfig.CredentialOf({ [Fx.CredentialVar]: file }), { username: 'bot', token: Fx.Token })
    })

    it('refuses a missing, malformed or incomplete credential file without echoing its contents', () =>
    {
        const cases = [
            join(dir, 'missing.json'),
            Credential('{ "username": "bot", "token": "' + Fx.Token + '"'),
            Credential(JSON.stringify({ username: 'bot' })),
            Credential(JSON.stringify({ username: '', token: Fx.Token })),
            Credential(JSON.stringify([Fx.Token])),
        ]
        for (const file of cases)
        {
            assert.throws(() => ReleaseCatalogConfig.CredentialOf({ [Fx.CredentialVar]: file }), (err: unknown) =>
                err instanceof ReleaseConfigError && err.message.includes(Fx.CredentialVar) && !err.message.includes(Fx.Token))
        }
    })

    it('composes no catalogue and no poll without a credential', () =>
    {
        assert.equal(ReleaseCatalogConfig.Compose({}, Fx.RepoRoot, deployments), undefined)
    })

    it('still refuses an invalid poll interval when no credential is set', () =>
    {
        assert.throws(() => ReleaseCatalogConfig.Compose({ [Fx.PollVar]: 'x' }, Fx.RepoRoot, deployments), ReleaseConfigError)
    })

    it('composes the catalogue and its poll from the default trust directory; 0 seconds composes no poll', () =>
    {
        const file = Credential(JSON.stringify({ username: 'bot', token: Fx.Token }))
        const polled = ReleaseCatalogConfig.Compose({ [Fx.CredentialVar]: file }, Fx.RepoRoot, deployments)
        assert.ok(polled?.Refresher !== undefined)
        assert.ok(polled.Poll !== undefined)
        const unpolled = ReleaseCatalogConfig.Compose({ [Fx.CredentialVar]: file, [Fx.PollVar]: '0' }, Fx.RepoRoot, deployments)
        assert.ok(unpolled?.Refresher !== undefined)
        assert.equal(unpolled.Poll, undefined)
    })

    it('refuses a registry that is not an absolute http(s) URL and a trust directory that cannot be read', () =>
    {
        const file = Credential(JSON.stringify({ username: 'bot', token: Fx.Token }))
        assert.throws(() => ReleaseCatalogConfig.Compose({ [Fx.CredentialVar]: file, PRAGMATIC_RELEASE_REGISTRY: 'ghcr.io' }, Fx.RepoRoot, deployments), (err: unknown) =>
            err instanceof ReleaseConfigError && err.message.includes('PRAGMATIC_RELEASE_REGISTRY'))
        assert.throws(() => ReleaseCatalogConfig.Compose({ [Fx.CredentialVar]: file, PRAGMATIC_RELEASE_TRUST_DIR: join(dir, 'nope') }, Fx.RepoRoot, deployments), (err: unknown) =>
            err instanceof ReleaseConfigError && err.message.includes('PRAGMATIC_RELEASE_TRUST_DIR'))
    })

    it('builds the catalogue and poll only for roles that serve operators: the edge never reads the release settings', () =>
    {
        const unreadable = { [Fx.CredentialVar]: join(dir, 'missing.json') }
        assert.equal(ControlPlaneServer.ReleasesOf(ControlPlaneRole.Edge, unreadable, Fx.RepoRoot, deployments), undefined)
        assert.equal(ControlPlaneServer.ReleasesOf(ControlPlaneRole.Edge, { [Fx.PollVar]: 'x' }, Fx.RepoRoot, deployments), undefined)
        assert.throws(() => ControlPlaneServer.ReleasesOf(ControlPlaneRole.Admin, unreadable, Fx.RepoRoot, deployments), ReleaseConfigError)
        const file = Credential(JSON.stringify({ username: 'bot', token: Fx.Token }))
        for (const role of [ControlPlaneRole.All, ControlPlaneRole.Admin])
        {
            const releases = ControlPlaneServer.ReleasesOf(role, { [Fx.CredentialVar]: file }, Fx.RepoRoot, deployments)
            assert.ok(releases?.Refresher !== undefined, role)
            assert.ok(releases.Poll !== undefined, role)
        }
    })
})
