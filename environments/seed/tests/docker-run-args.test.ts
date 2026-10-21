import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DockerEnv, EnvKind, TenantPurposeName } from '../docker.js'
import type { EnvDefinition } from '../docker.js'

class RunArgsProbe
{
    public static readonly BundleDir = '/abs/bundle'
    public static readonly RuntimeHostPort = 8137
    public static readonly DevelopmentHostPort = 8080
    private static readonly RuntimeName = 'runtime'
    private static readonly DevelopmentName = 'dev'
    private static readonly TenantId = 'contoso'
    private static readonly DevelopmentTenantId = 'dev'
    private static readonly OriginScheme = 'http://localhost:'

    public static RuntimeDef(hostPort: number): EnvDefinition
    {
        return { name: RunArgsProbe.RuntimeName, kind: EnvKind.Demo, tenantId: RunArgsProbe.TenantId, purpose: TenantPurposeName.Runtime, hostPort }
    }

    public static DevelopmentDef(hostPort: number): EnvDefinition
    {
        return { name: RunArgsProbe.DevelopmentName, kind: EnvKind.Dev, tenantId: RunArgsProbe.DevelopmentTenantId, purpose: TenantPurposeName.Development, hostPort }
    }

    public static DatabaseDef(): EnvDefinition
    {
        const def = RunArgsProbe.RuntimeDef(RunArgsProbe.RuntimeHostPort)
        def.database = { connectionName: 'main', host: 'pragmatic-env-runtime-db', port: 5432, database: 'appdb', user: 'appuser', password: 'apppw', hostPort: 55432 }
        return def
    }

    public static ExpectedOriginPair(hostPort: number): string
    {
        return `${DockerEnv.EnvAllowedOrigins}=${RunArgsProbe.OriginScheme}${hostPort}`
    }

    public static HasAdjacentPair(args: string[], flag: string, value: string): boolean
    {
        return args.some((arg, index) => index > 0 && args[index - 1] === flag && arg === value)
    }
}

test('RunArgs sets PRAGMATIC_ALLOWED_ORIGINS to the served origin for runtime envs', () =>
{
    const args = DockerEnv.RunArgs(RunArgsProbe.RuntimeDef(RunArgsProbe.RuntimeHostPort), RunArgsProbe.BundleDir)
    assert.ok(RunArgsProbe.HasAdjacentPair(args, DockerEnv.EnvFlag, RunArgsProbe.ExpectedOriginPair(RunArgsProbe.RuntimeHostPort)))
    assert.equal(args[args.length - 1], DockerEnv.ImageName)
})

test('RunArgs omits PRAGMATIC_ALLOWED_ORIGINS for development envs and keeps the image last', () =>
{
    const args = DockerEnv.RunArgs(RunArgsProbe.DevelopmentDef(RunArgsProbe.DevelopmentHostPort), RunArgsProbe.BundleDir)
    assert.equal(args.some(arg => arg.startsWith(`${DockerEnv.EnvAllowedOrigins}=`)), false)
    assert.equal(args[args.length - 1], DockerEnv.ImageName)
})

test('a database env adds --network to the server run args', () =>
{
    const withDb = RunArgsProbe.DatabaseDef()
    const without = RunArgsProbe.RuntimeDef(RunArgsProbe.RuntimeHostPort)
    assert.ok(RunArgsProbe.HasAdjacentPair(DockerEnv.RunArgs(withDb, RunArgsProbe.BundleDir), '--network', DockerEnv.NetworkName(withDb)))
    assert.equal(DockerEnv.RunArgs(without, RunArgsProbe.BundleDir).includes('--network'), false)
})

test('PostgresRunArgs builds a pinned postgres container on the network', () =>
{
    const def = RunArgsProbe.DatabaseDef()
    const db = def.database!
    const args = DockerEnv.PostgresRunArgs(def)
    assert.equal(args[args.length - 1], 'postgres:16')
    assert.ok(RunArgsProbe.HasAdjacentPair(args, '--name', DockerEnv.DbContainerName(def)))
    assert.ok(RunArgsProbe.HasAdjacentPair(args, '--network', DockerEnv.NetworkName(def)))
    assert.ok(RunArgsProbe.HasAdjacentPair(args, '-v', `${DockerEnv.DbVolumeName(def)}:/var/lib/postgresql/data`))
    assert.ok(RunArgsProbe.HasAdjacentPair(args, DockerEnv.EnvFlag, `POSTGRES_PASSWORD=${db.password}`))
    assert.ok(RunArgsProbe.HasAdjacentPair(args, DockerEnv.EnvFlag, `POSTGRES_USER=${db.user}`))
    assert.ok(RunArgsProbe.HasAdjacentPair(args, DockerEnv.EnvFlag, `POSTGRES_DB=${db.database}`))
    assert.ok(RunArgsProbe.HasAdjacentPair(args, '-p', `${db.hostPort}:5432`))
})
