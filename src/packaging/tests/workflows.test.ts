import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'

class Workflows
{
    public static Dir(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.github', 'workflows')
    }

    public static Files(): readonly string[]
    {
        return readdirSync(Workflows.Dir()).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    }

    public static Text(name: string): string
    {
        return readFileSync(join(Workflows.Dir(), name), 'utf8')
    }
}

test('every workflow file is valid YAML', () =>
{
    const files = Workflows.Files()
    assert.ok(files.length >= 2)
    for (const name of files)
    {
        assert.doesNotThrow(() => parse(Workflows.Text(name)), `invalid YAML: ${name}`)
    }
})

test('ci workflow runs tests and builds the image', () =>
{
    const text = Workflows.Text('ci.yml')
    assert.match(text, /tsx --test/)
    assert.match(text, /docker build/)
})

test('image publish is gated behind an explicit enable flag (inert by default)', () =>
{
    const doc = parse(Workflows.Text('image.yml')) as { jobs: Record<string, { steps?: { if?: string }[] }> }
    const steps = Object.values(doc.jobs).flatMap(job => job.steps ?? [])
    const pushStep = steps.find(step => typeof step.if === 'string' && /ENABLE_IMAGE_PUBLISH/.test(step.if))
    assert.ok(pushStep !== undefined, 'expected a push step gated on ENABLE_IMAGE_PUBLISH')
})

test('ci workflow builds TODL like every other sibling (no DOM workaround)', () =>
{
    const text = Workflows.Text('ci.yml')
    assert.doesNotMatch(text, /--lib/, 'the TODL --lib workaround must be gone')
    assert.doesNotMatch(text, /"TODL"/, 'the TODL special-case branch must be gone')
})
