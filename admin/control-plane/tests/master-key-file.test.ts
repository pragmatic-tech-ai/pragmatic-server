import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MasterKeyFile } from '../master-key-file.js'
import { MasterKeyError } from '../operator-identity.js'

describe('MasterKeyFile', () =>
{
    const TempPrefix = 'master-key-file-'
    const KeyFileName = 'master.key'
    const KeyBytes = 32
    const BadBytes = 10

    let dir = ''
    let file = ''

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), TempPrefix))
        file = join(dir, KeyFileName)
    })

    afterEach(() =>
    {
        rmSync(dir, { recursive: true, force: true })
    })

    it('loads a 32-byte key', () =>
    {
        const bytes = Buffer.alloc(KeyBytes, 7)
        writeFileSync(file, bytes)
        const key = MasterKeyFile.Load(file)
        assert.equal(key.length, KeyBytes)
        assert.deepEqual(key, bytes)
    })

    it('throws MasterKeyError on a wrong-size file', () =>
    {
        writeFileSync(file, Buffer.alloc(BadBytes, 1))
        assert.throws(() => MasterKeyFile.Load(file), MasterKeyError)
    })
})
