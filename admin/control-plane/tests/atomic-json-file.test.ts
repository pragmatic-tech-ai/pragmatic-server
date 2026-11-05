import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicJsonFile, SerialRuns } from '../atomic-json-file.js'
import { OwnerResetTime } from '../tenant-owner.js'

class Names
{
    public static readonly TempPrefix = 'atomic-json-file-'
    public static readonly Nested = 'a'
    public static readonly FileName = 'f.json'
    public static readonly Utf8 = 'utf8'
    public static readonly Failure = 'boom'
}

describe('AtomicJsonFile', () =>
{
    let dir: string

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), Names.TempPrefix)) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('creates the directory and writes the JSON, compact or indented, leaving no temp file', async () =>
    {
        const path = join(dir, Names.Nested, Names.FileName)
        await AtomicJsonFile.Write(path, { k: 'v' })
        assert.equal(readFileSync(path, Names.Utf8), '{"k":"v"}')
        await AtomicJsonFile.Write(path, { k: 'w' }, 2)
        assert.equal(readFileSync(path, Names.Utf8), JSON.stringify({ k: 'w' }, null, 2))
        assert.deepEqual(readdirSync(join(dir, Names.Nested)), [Names.FileName])
    })

    it('a failed rename removes its temp file and rethrows', async () =>
    {
        // The target is a non-empty directory, so the rename over it fails.
        const path = join(dir, Names.FileName)
        mkdirSync(join(path, Names.Nested), { recursive: true })
        await assert.rejects(AtomicJsonFile.Write(path, { k: 'v' }))
        assert.deepEqual(readdirSync(dir), [Names.FileName])
    })
})

describe('SerialRuns', () =>
{
    it('runs one at a time in call order, and a failure reaches only its caller', async () =>
    {
        const runs = new SerialRuns()
        const order: string[] = []
        let release: () => void = () => undefined
        const held = new Promise<void>(resolve => { release = resolve })
        const first = runs.Run(async () => { await held; order.push('first') })
        const failing = runs.Run(async () => { order.push('failing'); throw new Error(Names.Failure) })
        const last = runs.Run(async () => { order.push('last'); return 3 })
        release()
        await first
        await assert.rejects(failing, new RegExp(Names.Failure))
        assert.equal(await last, 3)
        assert.deepEqual(order, ['first', 'failing', 'last'])
    })
})

describe('OwnerResetTime.IsWellFormed', () =>
{
    it('accepts a string Date.parse reads, nothing else', () =>
    {
        assert.equal(OwnerResetTime.IsWellFormed('2026-11-04T10:00:00.000Z'), true)
        for (const bad of [undefined, null, 7, '', 'not a time', {}])
        {
            assert.equal(OwnerResetTime.IsWellFormed(bad), false)
        }
    })
})
