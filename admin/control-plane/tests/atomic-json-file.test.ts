import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
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
    public static readonly RawText = 'not json, kept as given\n'
    public static readonly ProbeName = 'probe.txt'
    public static readonly OldText = 'old contents'
    public static readonly CloseFailure = 'close failed'
}

type SyncObservation = { readonly directory: boolean; readonly tempExists: boolean; readonly target: string | undefined }

class SyncSpy
{
    /** Spies FileHandle.prototype.sync (the real sync still runs), recording what the disk looked like at each call. */
    public static async Run(dir: string, path: string, body: () => Promise<void>): Promise<SyncObservation[]>
    {
        const probe = await open(join(dir, Names.ProbeName), 'w')
        const proto = Object.getPrototypeOf(probe) as { sync: (this: { fd: number }) => Promise<void> }
        await probe.close()
        const original = proto.sync
        const seen: SyncObservation[] = []
        const spy = mock.method(proto, 'sync', async function (this: { fd: number })
        {
            seen.push({
                directory: fstatSync(this.fd).isDirectory(),
                tempExists: readdirSync(dir).some(n => n.endsWith('.tmp')),
                target: existsSync(path) ? readFileSync(path, Names.Utf8) : undefined
            })
            return original.call(this)
        })
        try
        {
            await body()
        }
        finally
        {
            spy.mock.restore()
        }
        return seen
    }
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

    it('WriteText writes the text as given', async () =>
    {
        const path = join(dir, Names.Nested, Names.FileName)
        await AtomicJsonFile.WriteText(path, Names.RawText)
        assert.equal(readFileSync(path, Names.Utf8), Names.RawText)
        assert.deepEqual(readdirSync(join(dir, Names.Nested)), [Names.FileName])
    })

    const spySync = (path: string, body: () => Promise<void>): Promise<SyncObservation[]> => SyncSpy.Run(dir, path, body)

    it('fsync: true syncs the temp file before the rename; omitted, it does not', async () =>
    {
        const path = join(dir, Names.FileName)
        writeFileSync(path, Names.OldText)
        const without = await spySync(path, () => AtomicJsonFile.WriteText(path, Names.RawText))
        assert.equal(without.length, 0)
        writeFileSync(path, Names.OldText)
        const seen = await spySync(path, () => AtomicJsonFile.WriteText(path, Names.RawText, { fsync: true }))
        const file = seen.filter(s => !s.directory)
        assert.equal(file.length, 1)
        assert.equal(file[0].tempExists, true)
        assert.equal(file[0].target, Names.OldText)
        assert.equal(readFileSync(path, Names.Utf8), Names.RawText)
        assert.deepEqual(readdirSync(dir).sort(), [Names.FileName, Names.ProbeName].sort())
    })

    it('fsync: true also syncs the parent directory after the rename, on POSIX only', async () =>
    {
        const path = join(dir, Names.FileName)
        const seen = await spySync(path, () => AtomicJsonFile.WriteText(path, Names.RawText, { fsync: true }))
        const directory = seen.filter(s => s.directory)
        if (process.platform === 'win32')
        {
            assert.equal(directory.length, 0)
            return
        }
        assert.equal(directory.length, 1)
        assert.equal(directory[0].tempExists, false)
        assert.equal(directory[0].target, Names.RawText)
    })

    it('mode sets the file mode', { skip: process.platform === 'win32' }, async () =>
    {
        const path = join(dir, Names.FileName)
        await AtomicJsonFile.Write(path, { k: 'v' }, undefined, { mode: 0o600 })
        assert.equal(statSync(path).mode & 0o777, 0o600)
    })

    it('mode reaches open on every platform: a read-only mode leaves no write bits', async () =>
    {
        const path = join(dir, Names.FileName)
        await AtomicJsonFile.Write(path, { k: 'v' }, undefined, { mode: 0o444 })
        assert.equal(statSync(path).mode & 0o222, 0)
        rmSync(path, { force: true })
    })

    it('a close failure after a failed write keeps the original error', async () =>
    {
        const probe = await open(join(dir, Names.ProbeName), 'w')
        const proto = Object.getPrototypeOf(probe) as { writeFile: (this: { close: () => Promise<void> }) => Promise<void> }
        await probe.close()
        // close is an instance member of FileHandle, so the failing writeFile also makes its own handle's close fail (after really closing).
        const failingWrite = mock.method(proto, 'writeFile', async function (this: { close: () => Promise<void> })
        {
            const realClose = this.close.bind(this)
            this.close = async () =>
            {
                await realClose()
                throw new Error(Names.CloseFailure)
            }
            throw new Error(Names.Failure)
        })
        try
        {
            await assert.rejects(AtomicJsonFile.WriteText(join(dir, Names.FileName), Names.RawText), new RegExp(`^Error: ${Names.Failure}$`))
        }
        finally
        {
            failingWrite.mock.restore()
        }
        assert.deepEqual(readdirSync(dir), [Names.ProbeName])
    })

    it('a failed write after open removes its temp file', async () =>
    {
        const probe = await open(join(dir, Names.ProbeName), 'w')
        const proto = Object.getPrototypeOf(probe) as { writeFile: () => Promise<void> }
        await probe.close()
        const failing = mock.method(proto, 'writeFile', async () => { throw new Error(Names.Failure) })
        try
        {
            await assert.rejects(AtomicJsonFile.WriteText(join(dir, Names.FileName), Names.RawText), new RegExp(Names.Failure))
        }
        finally
        {
            failing.mock.restore()
        }
        assert.deepEqual(readdirSync(dir), [Names.ProbeName])
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
