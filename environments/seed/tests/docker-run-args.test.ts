import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DockerEnv, EnvKind, TenantPurposeName } from '../docker.js'
import type { EnvDefinition } from '../docker.js'

class RunArgsProbe
{
    private static readonly BundleDir = '/abs/bundle'
    private static readonly RuntimeHostPort = 8137
    private static readonly OriginScheme = 'http://localhost:'

    public static RuntimeDef(hostPort: number): EnvDefinition
    {
        return { name: 'runtime', kind: EnvKind.Demo, tenantId: 'contoso', purpose: TenantPurposeName.Runtime, hostPort }
    }

    public static DevelopmentDef(hostPort: number): EnvDefinition
    {
        return { name: 'dev', kind: EnvKind.Dev, tenantId: 'dev', purpose: TenantPurposeName.Development, hostPort }
    }

    public static Bundle(): string
    {
        return RunArgsProbe.BundleDir
    }

    public static ExpectedOriginPair(hostPort: number): string
    {
        return `${DockerEnv.EnvAllowedOrigins}=${RunArgsProbe.OriginScheme}${hostPort}`
    }

    public static HasAdjacentPair(args: string[], flag: string, value: string): boolean
    {
        return args.some((arg, index) => index > 0 && args[index - 1] === flag && arg === value)
    }

    public static RuntimeHost(): number
    {
        return RunArgsProbe.RuntimeHostPort
    }
}

test('RunArgs sets PRAGMATIC_ALLOWED_ORIGINS to the served origin for runtime envs', () =>
{
    const port = RunArgsProbe.RuntimeHost()
    const args = DockerEnv.RunArgs(RunArgsProbe.RuntimeDef(port), RunArgsProbe.Bundle())
    assert.ok(RunArgsProbe.HasAdjacentPair(args, DockerEnv.EnvFlag, RunArgsProbe.ExpectedOriginPair(port)))
})

test('RunArgs omits PRAGMATIC_ALLOWED_ORIGINS for development envs', () =>
{
    const args = DockerEnv.RunArgs(RunArgsProbe.DevelopmentDef(8080), RunArgsProbe.Bundle())
    assert.equal(args.some(arg => arg.startsWith(`${DockerEnv.EnvAllowedOrigins}=`)), false)
})
