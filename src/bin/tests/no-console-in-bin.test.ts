import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

class BinSources
{
    private static readonly Needle = 'console.'
    private static readonly Files = ['../server-main.ts', '../worker-main.ts', '../gateway-main.ts']
    private static readonly Utf8 = 'utf8'

    public static Offenders(): string[]
    {
        return BinSources.Files.filter(file => BinSources.Read(file).includes(BinSources.Needle))
    }

    private static Read(relative: string): string
    {
        return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), BinSources.Utf8)
    }
}

test('no bin composition root reintroduces console.* output', () =>
{
    assert.deepEqual(BinSources.Offenders(), [])
})
