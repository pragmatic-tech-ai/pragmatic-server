import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { ClosureCheck } from '../../../docker/images/closure-check.js'
import { ImportWalker } from '../../../admin/control-plane/tests/import-walker.js'

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

class WorkflowCommands
{
    private static readonly CloneFlagsPattern = /git clone((?:\s+--?[a-z-]+(?:\s+\d+)?)*)\s+"https:\/\/github\.com\/pragmatic-tech-ai\//
    private static readonly NpxPattern = /\bnpx((?:\s+--?[a-z-]+)*)\s+(\S+)/g
    private static readonly DownloadFlag = /--yes|(?:^|\s)-y\b/
    private static readonly VersionMarker = '@'
    private static readonly ExactVersion = /^(?:@[a-z0-9-]+\/)?[a-z0-9.-]+@\d+\.\d+\.\d+$/
    private static readonly TestFilesPattern = /--test((?:\s+"?pragmatic-server\/\S+?\.test\.ts"?)+)/
    private static readonly Quote = /"/g
    private static readonly Whitespace = /\s+/
    private static readonly NoText = ''
    private static readonly LockFile = 'package-lock.json'
    private static readonly TsxLockKey = 'node_modules/tsx'
    private static readonly Utf8 = 'utf8'
    private static readonly ParentSegment = '..'
    /** A named-branch clone option, long or short form. */
    public static readonly BranchFlag = /--branch|-b\b/
    public static readonly LongBranchFlag = /--branch/
    public static readonly RecordsHeads = /rev-parse HEAD[\s\S]*siblings\.json/
    public static readonly Bake = /docker buildx bake/
    public static readonly ClosureCheckRun = /^RUN cd pragmatic-server && npx tsx docker\/images\/closure-check\.ts$/m
    public static readonly CiSuites: readonly RegExp[] = [
        /npx tsx --test "src\/\*\*\/\*\.test\.ts"/,
        /npx tsx --test "admin\/control-plane\/\*\*\/\*\.test\.ts"/,
        /npx tsx --test "docker\/images\/tests\/\*\.test\.ts"/,
    ]
    public static readonly Ci = 'ci.yml'
    public static readonly Release = 'release.yml'
    public static readonly MinReleaseNpx = 3

    /** The server repo's docker/images/Dockerfile. */
    public static ImagesDockerfile(): string
    {
        const S = WorkflowCommands
        return readFileSync(join(Workflows.Dir(), S.ParentSegment, S.ParentSegment, 'docker', 'images', 'Dockerfile'), S.Utf8)
    }

    /** Every `run` script of the workflow's steps, in order. */
    public static Runs(workflow: string): string[]
    {
        const doc = parse(Workflows.Text(workflow)) as { jobs: Record<string, { steps?: IWorkflowStep[] }> }
        return Object.values(doc.jobs).flatMap(job => job.steps ?? []).map(step => step.run ?? WorkflowCommands.NoText)
    }

    /** The options of the workflow's sibling `git clone` (everything between `git clone` and the repository URL). */
    public static CloneFlags(workflow: string): string
    {
        const match = WorkflowCommands.CloneFlagsPattern.exec(Workflows.Text(workflow))
        assert.ok(match !== null, `no sibling git clone in ${workflow}`)
        return match[1].trim()
    }

    /**
     * Every `npx` invocation in the workflow: the package as written (`tsx`, `tsx@4.23.15`), whether npx may download it
     * (`--yes`), and whether it names a version.
     */
    public static NpxInvocations(workflow: string): { Package: string; Downloads: boolean; Versioned: boolean }[]
    {
        const S = WorkflowCommands
        return [...Workflows.Text(workflow).matchAll(S.NpxPattern)].map(m => ({
            Package: m[2],
            Downloads: S.DownloadFlag.test(m[1]),
            Versioned: m[2].includes(S.VersionMarker, 1),
        }))
    }

    public static IsExact(spec: string): boolean
    {
        return WorkflowCommands.ExactVersion.test(spec)
    }

    /** The tsx version the server's package-lock resolves. */
    public static LockedTsx(): string
    {
        const S = WorkflowCommands
        const lock = JSON.parse(readFileSync(join(Workflows.Dir(), S.ParentSegment, S.ParentSegment, S.LockFile), S.Utf8)) as { packages: Record<string, { version: string }> }
        return lock.packages[S.TsxLockKey].version
    }

    /** The test files a workflow step passes to `tsx --test`, relative to the workspace root. */
    public static TestFiles(run: string): string[]
    {
        const match = WorkflowCommands.TestFilesPattern.exec(run)
        const S = WorkflowCommands
        return match === null ? [] : match[1].replace(S.Quote, S.NoText).trim().split(S.Whitespace)
    }
}

test('release workflow clones every sibling exactly as ci does: the default branch, never a named one', () =>
{
    const W = WorkflowCommands
    const ci = W.CloneFlags(W.Ci)
    assert.equal(W.CloneFlags(W.Release), ci)
    assert.doesNotMatch(ci, W.BranchFlag)
    const release = Workflows.Text(W.Release)
    assert.doesNotMatch(release, W.LongBranchFlag)
    assert.match(release, W.RecordsHeads, 'each clone records its HEAD commit in siblings.json')
})

test('every package a workflow runs with npx --yes is pinned to an exact version, and release uses the locked tsx', () =>
{
    for (const name of Workflows.Files())
    {
        for (const npx of WorkflowCommands.NpxInvocations(name))
        {
            if (npx.Downloads || npx.Versioned)
            {
                assert.ok(WorkflowCommands.IsExact(npx.Package), `${name}: npx package not pinned to an exact version: ${npx.Package}`)
            }
        }
    }
    const tsx = WorkflowCommands.NpxInvocations(WorkflowCommands.Release).map(npx => npx.Package)
    assert.ok(tsx.length >= WorkflowCommands.MinReleaseNpx)
    assert.deepEqual([...new Set(tsx)], [`tsx@${WorkflowCommands.LockedTsx()}`])
})

test('release workflow runs the builtin-only release toolkit tests before it bakes, and the image build runs the closure check', () =>
{
    const W = WorkflowCommands
    const runs = W.Runs(W.Release)
    const tests = runs.findIndex(run => W.TestFiles(run).length > 0)
    const bake = runs.findIndex(run => W.Bake.test(run))
    assert.ok(tests !== -1 && tests < bake, 'the release toolkit tests run before the images are built')
    const workspace = join(Workflows.Dir(), '..', '..', '..')
    for (const file of W.TestFiles(runs[tests]))
    {
        assert.deepEqual(ImportWalker.Offenders(join(workspace, file)), [], `${file} runs without npm install, so it may import only builtins`)
    }
    assert.match(W.ImagesDockerfile(), W.ClosureCheckRun, 'the shared build stage runs the closure check, so no image ships an unchecked closure')
})

test('ci workflow runs the control-plane and image-tooling suites beside the server suite', () =>
{
    const text = Workflows.Text(WorkflowCommands.Ci)
    for (const suite of WorkflowCommands.CiSuites)
    {
        assert.match(text, suite)
    }
})

test('ci workflow clones the graph engine and points TODL at it before the server builds', () =>
{
    const text = Workflows.Text('ci.yml')
    assert.match(text, /for pair in pragmatic-graph:pragmatic-graph /, 'the engine sibling is cloned')
    const link = text.indexOf('link-graph-engine.sh')
    const server = text.indexOf('name: Build pragmatic-server')
    assert.ok(link !== -1 && server !== -1 && link < server, 'TODL is re-pointed at the sibling engine before the server builds')
})
