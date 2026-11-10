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
    assert.doesNotMatch(text, /if /, 'no shell conditional - TODL builds like every other sibling')
    assert.doesNotMatch(text, /gen:prelude/, 'the inlined TODL generator mirror must be gone')
    assert.match(text, /for pkg in pragmatic-graph todl-runtime TODL Mural pragmatic-protocol/, 'the engine first, then TODL (then Mural, which the IdP sign-in app needs) stay in the common sibling build loop')
})

class SiblingLists
{
    private static readonly ClonePattern = /for pair in ([^;]+);/
    private static readonly CopyPattern = /^COPY ([A-Za-z-]+)\/ \.\/\1\/$/gm

    public static Cloned(workflow: string): readonly string[]
    {
        const match = SiblingLists.ClonePattern.exec(Workflows.Text(workflow))
        assert.ok(match !== null, `no sibling clone loop in ${workflow}`)
        return match[1].trim().split(/\s+/).map(pair => pair.split(':')[1]).sort()
    }

    public static Copied(): readonly string[]
    {
        const text = readFileSync(join(Workflows.Dir(), '..', '..', 'docker', 'Dockerfile'), 'utf8')
        return [...text.matchAll(SiblingLists.CopyPattern)].map(m => m[1]).filter(name => name !== 'pragmatic-server').sort()
    }
}

test('ci and image workflows clone exactly the siblings the Dockerfile copies', () =>
{
    const copied = SiblingLists.Copied()
    assert.deepEqual(SiblingLists.Cloned('ci.yml'), copied)
    assert.deepEqual(SiblingLists.Cloned('image.yml'), copied)
})

test('ci workflow clones the graph engine and points TODL at it before the server builds', () =>
{
    const text = Workflows.Text('ci.yml')
    assert.match(text, /for pair in pragmatic-graph:pragmatic-graph /, 'the engine sibling is cloned')
    const link = text.indexOf('link-graph-engine.sh')
    const server = text.indexOf('name: Build pragmatic-server')
    assert.ok(link !== -1 && server !== -1 && link < server, 'TODL is re-pointed at the sibling engine before the server builds')
})
