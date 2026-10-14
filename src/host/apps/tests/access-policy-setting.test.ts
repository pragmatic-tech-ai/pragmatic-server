import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { AccessPolicySetting, MalformedPolicyError } from '../access-policy-setting.js'

class Fixture
{
    public static readonly App = 'demo'
    public static readonly Traversal = '../x'
    public static readonly Prefix = 'policy-'
    public static readonly Concept = 'acme.Secret'
    public static readonly Rules = [{ effect: 'deny', action: 'read' }]

    public readonly Dir = mkdtempSync(join(tmpdir(), Fixture.Prefix))

    public Write(text: string): void
    {
        mkdirSync(join(this.Dir, Fixture.App), { recursive: true })
        writeFileSync(join(this.Dir, Fixture.App, AccessPolicySetting.PolicyFile), text)
    }

    public Load(): Promise<readonly { concept: string; rulesJson: string }[]>
    {
        return AccessPolicySetting.Load(new NodeFsStorage(this.Dir), Fixture.App)
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

test('present policy file yields concept/rulesJson entries', async () =>
{
    const fx = new Fixture()
    try
    {
        fx.Write(JSON.stringify({ [Fixture.Concept]: Fixture.Rules }))
        assert.deepEqual(await fx.Load(), [{ concept: Fixture.Concept, rulesJson: JSON.stringify(Fixture.Rules) }])
    }
    finally { fx.Dispose() }
})

test('absent policy file is allow-all (empty)', async () =>
{
    const fx = new Fixture()
    try
    {
        assert.deepEqual(await fx.Load(), [])
    }
    finally { fx.Dispose() }
})

test('malformed policy files fail closed', async () =>
{
    const fx = new Fixture()
    try
    {
        for (const text of ['{not json', '[]', 'null', '"x"', JSON.stringify({ [Fixture.Concept]: { effect: 'deny' } })])
        {
            fx.Write(text)
            await assert.rejects(fx.Load(), MalformedPolicyError)
        }
    }
    finally { fx.Dispose() }
})

test('Load rejects a traversal app name before touching storage', async () =>
{
    const fx = new Fixture()
    try
    {
        await assert.rejects(() => AccessPolicySetting.Load(new NodeFsStorage(fx.Dir), Fixture.Traversal), /invalid application name/)
    }
    finally
    {
        fx.Dispose()
    }
})
