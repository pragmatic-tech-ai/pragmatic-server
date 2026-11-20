import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { OperatorRole } from '../../operator-identity.js'
import { ComponentDescriptorCli } from '../component-descriptor-cli.js'
import { ReleaseComponents } from '../release-components.js'
import { ReleaseApp, ReleaseApps } from '../release-tag.js'

class ComponentsFixture
{
    public static readonly PostgresApps: readonly ReleaseApp[] = [ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin, ReleaseApp.TenantIdp, ReleaseApp.EnvServer]
    public static readonly OperatorRoles = ['operator.full', 'operator.read-only']
    public static readonly TempPrefix = 'component-cli-'
    public static readonly Sha256 = 'sha256'
    public static readonly DigestPrefix = 'sha256:'
    public static readonly Hex = 'hex'
    public static readonly Utf8 = 'utf8'
    public static readonly OtherDigest = 'sha256:' + '0'.repeat(64)
    public static readonly OneFile = 'one.json'

    public readonly Out: string[] = []
    public readonly Err: string[] = []

    public get Output()
    {
        return { Out: (line: string) => this.Out.push(line), Err: (line: string) => this.Err.push(line) }
    }

    public static InTemp(body: (dir: string) => void): void
    {
        const dir = mkdtempSync(join(tmpdir(), ComponentsFixture.TempPrefix))
        try
        {
            body(dir)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public static FileDigest(path: string): string
    {
        return ComponentsFixture.DigestPrefix + createHash(ComponentsFixture.Sha256).update(readFileSync(path)).digest(ComponentsFixture.Hex)
    }
}

describe('ReleaseComponents', () =>
{
    it('has a descriptor for every release app, named for its image', () =>
    {
        assert.deepEqual(ReleaseComponents.All().map(([app, descriptor]) => [app, descriptor.Name]), ReleaseApps.All.map(app => [app, app]))
    })

    it('needs a Postgres database exactly for the apps that store in Postgres (A5)', () =>
    {
        for (const [app, descriptor] of ReleaseComponents.All())
        {
            assert.equal(descriptor.Storage.Postgres, ComponentsFixture.PostgresApps.includes(app), app)
        }
    })

    it('declares application roles only where the code has them: the operator roles of the platform admin console', () =>
    {
        for (const [app, descriptor] of ReleaseComponents.All())
        {
            const roles = descriptor.Roles.map(role => role.Name)
            assert.deepEqual(roles, app === ReleaseApp.PlatformAdmin ? ComponentsFixture.OperatorRoles : [], app)
        }
        const operatorRoles = Object.values(OperatorRole).filter(value => typeof value === 'number')
        assert.equal(operatorRoles.length, ComponentsFixture.OperatorRoles.length)
    })

    it('serves a health endpoint on a declared port for every long-running app; the init container and the agent listen on none', () =>
    {
        for (const [app, descriptor] of ReleaseComponents.All())
        {
            const listens = descriptor.Endpoints.Ports.length > 0
            assert.equal(listens, app !== ReleaseApp.UiUnpack && app !== ReleaseApp.HiveAgent, app)
            assert.equal(descriptor.Endpoints.Health !== undefined, listens && app !== ReleaseApp.Postgres, app)
        }
    })
})

describe('ComponentDescriptorCli', () =>
{
    it('emit-all writes each descriptor as its canonical JSON, the digests and the bake override', () =>
    {
        ComponentsFixture.InTemp(dir =>
        {
            const fx = new ComponentsFixture()
            assert.equal(ComponentDescriptorCli.Run(['emit-all', '--out', dir], fx.Output), 0)
            const digests = JSON.parse(readFileSync(join(dir, ComponentDescriptorCli.DigestsFile), ComponentsFixture.Utf8)) as Record<string, string>
            const bake = JSON.parse(readFileSync(join(dir, ComponentDescriptorCli.BakeFile), ComponentsFixture.Utf8)) as { target: Record<string, { args: Record<string, string> }> }
            for (const [app, descriptor] of ReleaseComponents.All())
            {
                const file = join(dir, app, ComponentDescriptorCli.DescriptorFile)
                assert.equal(readFileSync(file, ComponentsFixture.Utf8), descriptor.ToCanonicalJson())
                assert.equal(ComponentsFixture.FileDigest(file), descriptor.ContentDigest(), 'the file bytes hash to the label digest')
                assert.equal(digests[app], descriptor.ContentDigest())
                assert.deepEqual(bake.target[app], { args: { [ComponentDescriptorCli.AppArg]: app, [ComponentDescriptorCli.DigestArg]: descriptor.ContentDigest() } })
            }
            assert.equal(Object.keys(bake.target).length, ReleaseApps.All.length)
            assert.equal(fx.Out.length, ReleaseApps.All.length)
        })
    })

    it('emit writes one descriptor when its digest is the one given', () =>
    {
        ComponentsFixture.InTemp(dir =>
        {
            const fx = new ComponentsFixture()
            const out = join(dir, ComponentsFixture.OneFile)
            const digest = ReleaseComponents.Of(ReleaseApp.EnvGateway).ContentDigest()
            assert.equal(ComponentDescriptorCli.Run(['emit', '--app', ReleaseApp.EnvGateway, '--digest', digest, '--out', out], fx.Output), 0)
            assert.equal(ComponentsFixture.FileDigest(out), digest)
        })
    })

    it('emit refuses another digest, or none, and writes nothing', () =>
    {
        ComponentsFixture.InTemp(dir =>
        {
            const out = join(dir, ComponentsFixture.OneFile)
            for (const digest of [ComponentsFixture.OtherDigest, ''])
            {
                const fx = new ComponentsFixture()
                assert.equal(ComponentDescriptorCli.Run(['emit', '--app', ReleaseApp.EnvGateway, '--digest', digest, '--out', out], fx.Output), 1)
                assert.match(fx.Err.join('\n'), /digest mismatch for pragmatic-env-gateway/)
                assert.ok(!existsSync(out))
            }
        })
    })

    it('answers usage errors with exit code 2: unknown command, unknown app, unknown or repeated option, missing option', () =>
    {
        const cases = [
            ['bogus'],
            [],
            ['emit', '--app', 'not-an-app', '--digest', ComponentsFixture.OtherDigest, '--out', ComponentsFixture.OneFile],
            ['emit-all', '--bogus', 'x'],
            ['emit-all', '--out', 'a', '--out', 'b'],
            ['emit-all'],
        ]
        for (const argv of cases)
        {
            const fx = new ComponentsFixture()
            assert.equal(ComponentDescriptorCli.Run(argv, fx.Output), 2, argv.join(' '))
            assert.equal(fx.Err.length, 1)
        }
    })
})
