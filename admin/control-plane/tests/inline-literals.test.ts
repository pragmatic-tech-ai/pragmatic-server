import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Source scans for the no-inline-literal rule where reviews found breaches: error names, the openssl default and '/' joins.
class Sources
{
    public static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..')

    public static Text(file: string): string
    {
        return readFileSync(join(Sources.Root, file), 'utf8')
    }

    public static All(): string[]
    {
        return readdirSync(Sources.Root).filter(f => f.endsWith('.ts'))
    }
}

describe('control-plane inline literals', () =>
{
    it('no error class sets its name from an inline literal', () =>
    {
        const offenders = Sources.All().filter(f => /this\.name = ['"]/.test(Sources.Text(f)))
        assert.deepEqual(offenders, [])
    })

    it('the development CA takes its openssl default from a constant', () =>
    {
        assert.ok(!/=\s*'openssl'\)/.test(Sources.Text('dev-certificate-authority.ts')))
    })

    it('ApiKubectl joins resource names with its Slash constant', () =>
    {
        assert.ok(!Sources.Text('api-kubectl.ts').includes("+ '/' +"))
    })
})
