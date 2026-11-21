import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { SeedCli, Command } from '../seed.js'

test('CLI parses command + env', () =>
{
    assert.deepEqual(SeedCli.Parse(['up', 'demo']), { command: Command.Up, env: 'demo' })
    assert.deepEqual(SeedCli.Parse(['down', 'dev']), { command: Command.Down, env: 'dev' })
    assert.deepEqual(SeedCli.Parse(['status', 'dev']), { command: Command.Status, env: 'dev' })
    assert.deepEqual(SeedCli.Parse(['logs', 'demo']), { command: Command.Logs, env: 'demo' })
    assert.deepEqual(SeedCli.Parse(['seed-users', 'demo']), { command: Command.SeedUsers, env: 'demo' })
    assert.deepEqual(SeedCli.Parse(['build', 'dev']), { command: Command.Build, env: 'dev' })
})

test('CLI rejects an unknown command', () =>
{
    assert.throws(() => SeedCli.Parse(['frobnicate', 'dev']))
})

test('CLI rejects a missing env', () =>
{
    assert.throws(() => SeedCli.Parse(['up']))
})

test('the demo users file the seed CLI seeds from exists (pragmatic-tenant-plane ships the demo seed)', () =>
{
    assert.ok(existsSync(SeedCli.UsersFileOf('demo')), SeedCli.UsersFileOf('demo'))
})
