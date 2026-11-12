import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { ClosureCheck } from '../../../docker/images/closure-check.js'

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

test('ci workflow runs tests, checks the image closures and bakes the app images without pushing', () =>
{
    const text = Workflows.Text('ci.yml')
    assert.match(text, /tsx --test/)
    assert.match(text, /npx tsx docker\/images\/closure-check\.ts/)
    assert.match(text, /docker buildx bake -f pragmatic-server\/docker\/docker-bake\.hcl/)
    assert.doesNotMatch(text, /--push/)
})

interface IWorkflowStep
{
    name?: string
    if?: string
    run?: string
    uses?: string
    with?: Record<string, unknown>
}

test('release workflow publishes on release tags only, and never leaks its credentials', () =>
{
    const text = Workflows.Text('release.yml')
    const doc = parse(text) as { on: { push: { tags: string[] } }; permissions: Record<string, string>; jobs: Record<string, { steps?: IWorkflowStep[] }> }
    assert.deepEqual(doc.on, { push: { tags: ['release/*'] } })
    assert.deepEqual(doc.permissions, { contents: 'read', packages: 'write' })
    const steps = Object.values(doc.jobs).flatMap(job => job.steps ?? [])
    const runs = steps.map(step => step.run ?? '')
    const check = runs.findIndex(run => /pragmatic-release-publish\.ts check --tag "\$GITHUB_REF"/.test(run))
    const clone = runs.findIndex(run => /git clone/.test(run))
    assert.ok(check !== -1 && check < clone, 'the tag is checked before any sibling is cloned')
    assert.ok(runs.some(run => /docker buildx bake -f pragmatic-server\/docker\/docker-bake\.hcl --push/.test(run)))
    assert.ok(runs.some(run => /publish --tag .* --key-id release-2026-11/.test(run)))
    assert.ok(runs.some(run => /umask 077[\s\S]*release\.key/.test(run)), 'the signing key is written under umask 077')
    const cleanup = steps.find(step => step.if === 'always()' && /rm -f .*release\.key.*npmrc/.test(step.run ?? ''))
    assert.ok(cleanup !== undefined, 'an always() step removes the key and the npmrc')
    assert.doesNotMatch(text, /set -x/)
    for (const run of runs)
    {
        assert.doesNotMatch(run, /\$\{\{\s*secrets\./, 'secrets reach scripts through env, not the script text')
    }
    for (const step of steps.filter(s => s.uses !== undefined))
    {
        assert.match(step.uses as string, /@[0-9a-f]{40}$/, `third-party action pinned by commit sha: ${step.uses}`)
    }
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@') === true)
    assert.equal(checkout?.with?.['persist-credentials'], false, 'the checkout does not leave the token in .git/config')
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

    public static Copied(...dockerfile: string[]): readonly string[]
    {
        const text = readFileSync(join(Workflows.Dir(), '..', '..', 'docker', ...dockerfile), 'utf8')
        return [...text.matchAll(SiblingLists.CopyPattern)].map(m => m[1]).filter(name => name !== 'pragmatic-server').sort()
    }
}

test('ci and release workflows clone exactly the siblings the Dockerfiles copy', () =>
{
    const copied = SiblingLists.Copied('images', 'Dockerfile')
    assert.deepEqual(SiblingLists.Copied('Dockerfile'), copied, 'the per-app images and the legacy dev image build the same siblings')
    assert.deepEqual([...ClosureCheck.Siblings].sort(), copied, 'the closure check knows every sibling the image build copies')
    assert.deepEqual(SiblingLists.Cloned('ci.yml'), copied)
    assert.deepEqual(SiblingLists.Cloned('release.yml'), copied)
})

test('ci workflow clones the graph engine and points TODL at it before the server builds', () =>
{
    const text = Workflows.Text('ci.yml')
    assert.match(text, /for pair in pragmatic-graph:pragmatic-graph /, 'the engine sibling is cloned')
    const link = text.indexOf('link-graph-engine.sh')
    const server = text.indexOf('name: Build pragmatic-server')
    assert.ok(link !== -1 && server !== -1 && link < server, 'TODL is re-pointed at the sibling engine before the server builds')
})
