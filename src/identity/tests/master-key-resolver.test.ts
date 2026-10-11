import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MasterKeyResolver } from '../master-key-resolver.js'

test('resolves a 32-byte key from a file path', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'mk-'))
    try
    {
        const path = join(dir, 'key.bin')
        const key = randomBytes(32)
        writeFileSync(path, key)
        const resolved = MasterKeyResolver.Resolve({ keyFilePath: path })
        assert.equal(resolved.length, 32)
        assert.ok(resolved.equals(key))
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('resolves a 32-byte key from a base64 env var', () =>
{
    const key = randomBytes(32)
    process.env.PS_TEST_MASTER_KEY = key.toString('base64')
    try
    {
        const resolved = MasterKeyResolver.Resolve({ base64Env: 'PS_TEST_MASTER_KEY' })
        assert.ok(resolved.equals(key))
    }
    finally
    {
        delete process.env.PS_TEST_MASTER_KEY
    }
})

test('a wrong-length key fails closed without echoing the key', () =>
{
    process.env.PS_TEST_SHORT_KEY = Buffer.from('too-short').toString('base64')
    try
    {
        assert.throws(() => MasterKeyResolver.Resolve({ base64Env: 'PS_TEST_SHORT_KEY' }), (error: Error) =>
        {
            assert.ok(!error.message.includes('too-short'))
            return true
        })
    }
    finally
    {
        delete process.env.PS_TEST_SHORT_KEY
    }
})

test('a missing env var fails closed', () =>
{
    assert.throws(() => MasterKeyResolver.Resolve({ base64Env: 'PS_TEST_ABSENT_KEY' }))
})
