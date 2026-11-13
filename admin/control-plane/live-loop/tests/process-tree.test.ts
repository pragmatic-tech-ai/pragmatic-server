import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProcessTree } from '../process-tree.js'

test('ProcessTree kills the whole tree with taskkill on Windows and treats a gone process as done', async () =>
{
    const runs: { file: string; args: readonly string[] }[] = []
    await new ProcessTree({ Run: async (file, args) => { runs.push({ file, args }); return { stdout: '', stderr: '' } } }, 'win32').Kill(4242)
    assert.deepEqual(runs, [{ file: 'taskkill', args: ['/T', '/F', '/PID', '4242'] }])
    await new ProcessTree({ Run: async () => { throw new Error('not found') } }, 'win32').Kill(4242)
})

test('ProcessTree signals the process group elsewhere and never runs taskkill', async () =>
{
    const runs: string[] = []
    // A pid far outside any real range: process.kill throws ESRCH, which Kill swallows.
    await new ProcessTree({ Run: async file => { runs.push(file); return { stdout: '', stderr: '' } } }, 'linux').Kill(2147483646)
    assert.deepEqual(runs, [])
})
