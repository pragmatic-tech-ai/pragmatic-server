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

/** A temp data root with a deployment registry and credential files written into it. */
class ConfigFixture
{
    public static readonly RepoRoot = join(import.meta.dirname, '..', '..', '..', '..')
    public static readonly Token = 'ghp_SECRET_token_in_the_file'
    public static readonly Username = 'bot'
    public static readonly CredentialVar = 'PRAGMATIC_RELEASE_CREDENTIAL_FILE'
    public static readonly PollVar = 'PRAGMATIC_RELEASE_POLL_SECONDS'
    public static readonly RegistryVar = 'PRAGMATIC_RELEASE_REGISTRY'
    public static readonly TrustDirVar = 'PRAGMATIC_RELEASE_TRUST_DIR'
    public static readonly CredentialFile = 'credential.json'
    public static readonly MissingFile = 'missing.json'

    private constructor(public readonly Dir: string, public readonly Deployments: PlatformDeploymentRegistry)
    {
    }

    public static async Create(): Promise<ConfigFixture>
    {
        const dir = mkdtempSync(join(tmpdir(), 'release-config-'))
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dir, 'clients.json')),
            new TenantRegistry(join(dir, 'tenants.json')),
            new HiveRegistry(join(dir, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        return new ConfigFixture(dir, await RolloutFixture.Create(dir, directory, new HiveOrchestratorFactory()))
    }

    /** Writes the credential file with the given content and answers its path. */
    public Credential(content: string): string
    {
        const file = join(this.Dir, ConfigFixture.CredentialFile)
        writeFileSync(file, content)
        return file
    }

    /** A well-formed credential file's path. */
    public ValidCredential(): string
    {
        return this.Credential(JSON.stringify({ username: ConfigFixture.Username, token: ConfigFixture.Token }))
    }

    public Missing(): string
    {
        return join(this.Dir, ConfigFixture.MissingFile)
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }

    /** True when err is a config error naming the variable and not echoing the given text. */
    public static Refuses(err: unknown, variable: string, secret: string): boolean
    {
        return err instanceof ReleaseConfigError && err.message.includes(variable) && !err.message.includes(secret)
    }
}

describe('ReleaseCatalogConfig', () =>
{
    const F = ConfigFixture
    let fx: ConfigFixture

    beforeEach(async () =>
    {
        fx = await ConfigFixture.Create()
    })

    afterEach(() =>
    {
        fx.Dispose()
    })

    it('polls every 300 seconds by default, accepts a whole number and 0 (off)', () =>
    {
        assert.equal(ReleaseCatalogConfig.PollSecondsOf({}), 300)
        assert.equal(ReleaseCatalogConfig.PollSecondsOf({ [F.PollVar]: '' }), 300)
        assert.equal(ReleaseCatalogConfig.PollSecondsOf({ [F.PollVar]: '15' }), 15)
        assert.equal(ReleaseCatalogConfig.PollSecondsOf({ [F.PollVar]: '0' }), 0)
    })

    it('refuses a negative, fractional, non-numeric or oversized poll interval with a sentence naming only the variable', () =>
    {
        for (const raw of ['-1', '1.5', 'abc', ' 5', '1e3', '99999999'])
        {
            assert.throws(() => ReleaseCatalogConfig.PollSecondsOf({ [F.PollVar]: raw }), (err: unknown) => F.Refuses(err, F.PollVar, raw), raw)
        }
    })

    it('has no credential when the variable is absent or blank', () =>
    {
        assert.equal(ReleaseCatalogConfig.CredentialOf({}), undefined)
        assert.equal(ReleaseCatalogConfig.CredentialOf({ [F.CredentialVar]: '' }), undefined)
    })

    it('reads { username, token } from the credential file', () =>
    {
        assert.deepEqual(ReleaseCatalogConfig.CredentialOf({ [F.CredentialVar]: fx.ValidCredential() }), { username: F.Username, token: F.Token })
    })

    it('refuses a missing, malformed or incomplete credential file without echoing its contents', () =>
    {
        const cases = [
            () => fx.Missing(),
            () => fx.Credential('{ "username": "bot", "token": "' + F.Token + '"'),
            () => fx.Credential(JSON.stringify({ username: F.Username })),
            () => fx.Credential(JSON.stringify({ username: '', token: F.Token })),
            () => fx.Credential(JSON.stringify([F.Token])),
        ]
        for (const write of cases)
        {
            const file = write()
            assert.throws(() => ReleaseCatalogConfig.CredentialOf({ [F.CredentialVar]: file }), (err: unknown) => F.Refuses(err, F.CredentialVar, F.Token))
        }
    })

    it('composes no catalogue and no poll without a credential', () =>
    {
        assert.equal(ReleaseCatalogConfig.Compose({}, F.RepoRoot, fx.Deployments), undefined)
    })

    it('still refuses an invalid poll interval when no credential is set', () =>
    {
        assert.throws(() => ReleaseCatalogConfig.Compose({ [F.PollVar]: 'x' }, F.RepoRoot, fx.Deployments), ReleaseConfigError)
    })

    it('composes the catalogue and its poll from the default trust directory; 0 seconds composes no poll', () =>
    {
        const file = fx.ValidCredential()
        const polled = ReleaseCatalogConfig.Compose({ [F.CredentialVar]: file }, F.RepoRoot, fx.Deployments)
        assert.ok(polled?.Refresher !== undefined)
        assert.ok(polled.Poll !== undefined)
        const unpolled = ReleaseCatalogConfig.Compose({ [F.CredentialVar]: file, [F.PollVar]: '0' }, F.RepoRoot, fx.Deployments)
        assert.ok(unpolled?.Refresher !== undefined)
        assert.equal(unpolled.Poll, undefined)
    })

    it('refuses a registry that is not an absolute URL, and plain http to any host but loopback', () =>
    {
        const file = fx.ValidCredential()
        for (const registry of ['ghcr.io', 'http://ghcr.example', 'http://10.0.0.5:5000', 'ftp://127.0.0.1'])
        {
            assert.throws(() => ReleaseCatalogConfig.Compose({ [F.CredentialVar]: file, [F.RegistryVar]: registry }, F.RepoRoot, fx.Deployments),
                (err: unknown) => F.Refuses(err, F.RegistryVar, registry), registry)
        }
    })

    it('accepts https anywhere and plain http to a loopback registry', () =>
    {
        const file = fx.ValidCredential()
        for (const registry of ['https://ghcr.example', 'http://127.0.0.1:5000', 'http://localhost:5000', 'http://[::1]:5000'])
        {
            assert.ok(ReleaseCatalogConfig.Compose({ [F.CredentialVar]: file, [F.RegistryVar]: registry }, F.RepoRoot, fx.Deployments) !== undefined, registry)
        }
    })

    it('refuses a trust directory that cannot be read', () =>
    {
        const file = fx.ValidCredential()
        assert.throws(() => ReleaseCatalogConfig.Compose({ [F.CredentialVar]: file, [F.TrustDirVar]: fx.Missing() }, F.RepoRoot, fx.Deployments),
            (err: unknown) => F.Refuses(err, F.TrustDirVar, fx.Dir))
    })

    it('builds the catalogue and poll only for roles that serve operators: the edge never reads the release settings', () =>
    {
        const unreadable = { [F.CredentialVar]: fx.Missing() }
        assert.equal(ControlPlaneServer.ReleasesOf(ControlPlaneRole.Edge, unreadable, F.RepoRoot, fx.Deployments), undefined)
        assert.equal(ControlPlaneServer.ReleasesOf(ControlPlaneRole.Edge, { [F.PollVar]: 'x' }, F.RepoRoot, fx.Deployments), undefined)
        assert.throws(() => ControlPlaneServer.ReleasesOf(ControlPlaneRole.Admin, unreadable, F.RepoRoot, fx.Deployments), ReleaseConfigError)
        const file = fx.ValidCredential()
        for (const role of [ControlPlaneRole.All, ControlPlaneRole.Admin])
        {
            const releases = ControlPlaneServer.ReleasesOf(role, { [F.CredentialVar]: file }, F.RepoRoot, fx.Deployments)
            assert.ok(releases?.Refresher !== undefined, role)
            assert.ok(releases.Poll !== undefined, role)
        }
    })
})
