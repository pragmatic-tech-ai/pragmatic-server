import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleAdvertLimits, ConsoleFingerprint } from '../console-advert-contract.js'

test('Of is HMAC-SHA256 of the normalised email', () =>
{
    const key = randomBytes(32)
    const fp = ConsoleFingerprint.Of(key, '  Ann@ACME.test ')
    assert.equal(fp, createHmac('sha256', key).update('ann@acme.test').digest('hex'))
    assert.match(fp, ConsoleAdvertLimits.FingerprintPattern)
})

test('different keys give different fingerprints', () =>
{
    assert.notEqual(ConsoleFingerprint.Of(randomBytes(32), 'a@b.test'), ConsoleFingerprint.Of(randomBytes(32), 'a@b.test'))
})

test('ReadKeyFile accepts exactly 32 bytes', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'advert-key-'))
    try
    {
        const good = randomBytes(32)
        await writeFile(join(dir, 'good'), good)
        await writeFile(join(dir, 'short'), randomBytes(31))
        await writeFile(join(dir, 'long'), randomBytes(33))
        assert.deepEqual(ConsoleFingerprint.ReadKeyFile(join(dir, 'good')), good)
        assert.equal(ConsoleFingerprint.ReadKeyFile(join(dir, 'short')), undefined)
        assert.equal(ConsoleFingerprint.ReadKeyFile(join(dir, 'long')), undefined)
        assert.equal(ConsoleFingerprint.ReadKeyFile(join(dir, 'missing')), undefined)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
