import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvKind, TenantPurposeName, type EnvDefinition } from '../../../environments/seed/bundle.js'
import { EnvironmentRegistry } from '../environment-registry.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { EnvRuntimeContext } from '../environment-runtime.js'
import { HostRuntimeUnavailableError, NoHostEnvironmentRuntime } from '../no-host-environment-runtime.js'

class NoHostFixture
{
    public static readonly Name = 'legacy'
    public static readonly TempPrefix = 'nohost-'
    public static readonly RegistryFile = 'registry.json'
    public static readonly Created = '2026-11-12T00:00:00.000Z'

    public static Def(): EnvDefinition
    {
        return { name: NoHostFixture.Name, kind: EnvKind.Dev, environmentId: NoHostFixture.Name, purpose: TenantPurposeName.Development, hostPort: 8100 }
    }

    /** An unbound (host-run) record, as an older data root may still hold. */
    public static Record(): EnvironmentRecord
    {
        return {
            name: NoHostFixture.Name, type: EnvType.Development, template: Template.DevBlank, environmentId: NoHostFixture.Name,
            hostPort: 8100, containerName: NoHostFixture.Name, createdAt: NoHostFixture.Created, status: EnvStatus.Running,
        }
    }

    public static Ctx(): EnvRuntimeContext
    {
        return { def: NoHostFixture.Def(), record: NoHostFixture.Record() }
    }
}

describe('NoHostEnvironmentRuntime', () =>
{
    it('a registry over it reconciles an unbound record to Stopped', async () =>
    {
        const dir = await mkdtemp(join(tmpdir(), NoHostFixture.TempPrefix))
        try
        {
            const registry = new EnvironmentRegistry(join(dir, NoHostFixture.RegistryFile), new NoHostEnvironmentRuntime())
            await registry.Load()
            await registry.Put(NoHostFixture.Record())
            await registry.Reconcile()
            assert.equal(registry.Get(NoHostFixture.Name)?.status, EnvStatus.Stopped)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('refuses every verb that would run the environment or read its output, naming it', async () =>
    {
        const runtime = new NoHostEnvironmentRuntime()
        const ctx = NoHostFixture.Ctx()
        assert.equal(runtime.PublishesHostPort(), false)
        for (const verb of [runtime.EnsureImage(ctx.def), runtime.Prepare(ctx), runtime.BringUp(ctx), runtime.WaitHealthy(ctx), runtime.Start(ctx), runtime.Logs(ctx)])
        {
            await assert.rejects(verb, (err: unknown) => err instanceof HostRuntimeUnavailableError && err.message.endsWith(NoHostFixture.Name))
        }
        assert.throws(() => runtime.LogStream(ctx, () => undefined), HostRuntimeUnavailableError)
        assert.throws(() => runtime.BuildCommand(), HostRuntimeUnavailableError)
    })

    it('lets stop and teardown pass and probes nothing as running: there is nothing here to stop', async () =>
    {
        const runtime = new NoHostEnvironmentRuntime()
        const ctx = NoHostFixture.Ctx()
        await runtime.Stop(ctx)
        await runtime.Teardown(ctx, true)
        await runtime.RemoveVolume(ctx)
        assert.equal(await runtime.Probe(ctx), false)
    })
})
