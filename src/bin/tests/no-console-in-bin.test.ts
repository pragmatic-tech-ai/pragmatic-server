import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

class BinSources
{
    public static readonly Needle = 'console.'
    public static readonly Files = ['../server-main.ts', '../worker-main.ts', '../gateway-main.ts']
    private static readonly Utf8 = 'utf8'

    public static Read(relative: string): string
    {
        return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), BinSources.Utf8)
    }
}

test('no bin composition root reintroduces console.* output', () =>
{
    for (const file of BinSources.Files)
    {
        assert.ok(!BinSources.Read(file).includes(BinSources.Needle), `${file} must log through ILogger, not console`)
    }
})
