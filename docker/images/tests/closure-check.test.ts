import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ClosureCheck, type ClosureReport, SharedLockClosure } from '../closure-check.js'

/** A throwaway workspace: three tiny sibling packages a, b, c and a server whose one app imports `a`. */
class FixtureWorkspace
{
    public static readonly App = 'app'
    public static readonly Siblings: readonly string[] = ['a', 'b', 'c']
    public static readonly SharedDir = 'pragmatic-shared'
    public static readonly SharedWorkspaces: readonly string[] = ['packages/s', 'packages/cloud']
    public static readonly SharedS = 'pragmatic-shared/packages/s'
    public static readonly SharedModules = 'pragmatic-shared/node_modules'
    private static readonly ImportsShared = "import { Value } from 's'\nconsole.log(Value)\n"
    private static readonly Roots: string[] = []

    public static Make(packages: readonly string[], files: readonly string[], entrySource: string, dockerfile?: string): string
    {
        const root = mkdtempSync(join(tmpdir(), 'closure-check-'))
        FixtureWorkspace.Roots.push(root)
        for (const name of FixtureWorkspace.Siblings)
        {
            FixtureWorkspace.Package(join(root, name), name, 'export const Value = 1\n')
        }
        FixtureWorkspace.Package(join(root, 'third'), 'third', 'export const Third = 3\n')
        const server = join(root, 'pragmatic-server')
        mkdirSync(join(server, 'src', 'bin'), { recursive: true })
        mkdirSync(join(server, 'docker', 'images'), { recursive: true })
        mkdirSync(join(server, 'node_modules'), { recursive: true })
        writeFileSync(join(server, 'package.json'), JSON.stringify({ name: 'pragmatic-server', type: 'module' }))
        // The sibling is linked in, as `file:../a` is; the third-party package is a plain copy in the server's node_modules.
        symlinkSync(join(root, 'a'), join(server, 'node_modules', 'a'), 'junction')
        FixtureWorkspace.Package(join(server, 'node_modules', 'third'), 'third', 'export const Third = 3\n')
        writeFileSync(join(server, 'src', 'bin', 'app.ts'), entrySource)
        const closure = { [FixtureWorkspace.App]: { entrypoint: ['node', 'dist/bin/app.js'], packages, files } }
        writeFileSync(join(server, 'docker', 'images', 'closure.json'), JSON.stringify(closure))
        if (dockerfile !== undefined)
        {
            writeFileSync(join(server, 'docker', 'images', 'Dockerfile'), dockerfile)
        }
        return root
    }

    /** Adds a server source file (path relative to the server dir). */
    public static Source(root: string, relative: string, text: string): void
    {
        const file = join(root, 'pragmatic-server', relative)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, text)
    }

    public static Report(root: string): ClosureReport
    {
        return ClosureCheck.Run(root, { Siblings: FixtureWorkspace.Siblings, Apps: [FixtureWorkspace.App] })
    }

    /**
     * Adds a pragmatic-shared workspace: package `s` (linked into the server's node_modules) importing the hoisted third-party
     * `dep`, a second workspace package `cloud` with its own hoisted `sdk`, and a lock whose `packages/s` entry declares the
     * given dependencies.
     */
    public static AddShared(root: string, lockEntry: Record<string, unknown>, workspaces: readonly string[] = FixtureWorkspace.SharedWorkspaces): void
    {
        const shared = join(root, FixtureWorkspace.SharedDir)
        mkdirSync(shared, { recursive: true })
        writeFileSync(join(shared, 'package.json'), JSON.stringify({ name: 'pragmatic-shared', private: true, workspaces }))
        FixtureWorkspace.Package(join(shared, 'packages', 's'), 's', "export { Dep as Value } from 'dep'\n")
        FixtureWorkspace.Package(join(shared, 'packages', 'cloud'), 'cloud', "export { Sdk } from 'sdk'\n")
        FixtureWorkspace.Package(join(shared, 'node_modules', 'dep'), 'dep', 'export const Dep = 4\n')
        FixtureWorkspace.Package(join(shared, 'node_modules', 'sdk'), 'sdk', 'export const Sdk = 5\n')
        symlinkSync(join(shared, 'packages', 's'), join(root, 'pragmatic-server', 'node_modules', 's'), 'junction')
        const lock = {
            packages: {
                'packages/s': lockEntry,
                'packages/cloud': { dependencies: { sdk: '^1.0.0' } },
                'node_modules/s': { link: true, resolved: 'packages/s' },
                'node_modules/cloud': { link: true, resolved: 'packages/cloud' },
                'node_modules/dep': { version: '1.0.0' },
                'node_modules/sdk': { version: '1.0.0' },
            },
        }
        writeFileSync(join(shared, 'package-lock.json'), JSON.stringify(lock))
    }

    /** The report for an app importing shared package `s`, whose lock entry is `lockEntry`, against the given Dockerfile. */
    public static SharedReport(lockEntry: Record<string, unknown>, dockerfile?: string): ClosureReport
    {
        const F = FixtureWorkspace
        const root = F.Make([F.SharedS], [F.SharedModules, Dist, Modules], F.ImportsShared, dockerfile)
        F.AddShared(root, lockEntry)
        return ClosureCheck.Run(root, { Siblings: F.Siblings, Apps: [F.App] })
    }

    /**
     * The report for an app listing only shared package `s`, whose source also imports `extra`: a further package under
     * pragmatic-shared/packages, a workspace (linked into the shared node_modules, as npm links workspaces) or a stray folder.
     */
    public static ExtraSharedReport(extraIsWorkspace: boolean): ClosureReport
    {
        const F = FixtureWorkspace
        const root = F.Make([F.SharedS], [F.SharedModules, Dist, Modules], F.ImportsShared)
        F.AddShared(root, { dependencies: { dep: '^1.0.0' } }, extraIsWorkspace ? [...F.SharedWorkspaces, 'packages/extra'] : F.SharedWorkspaces)
        const shared = join(root, F.SharedDir)
        F.Package(join(shared, 'packages', 'extra'), 'extra', 'export const Extra = 6\n')
        const importer = extraIsWorkspace ? "import { Extra } from 'extra'" : "import { Extra } from '../extra/index.js'"
        writeFileSync(join(shared, 'packages', 's', 'index.js'), importer + "\nexport { Dep as Value } from 'dep'\nconsole.log(Extra)\n")
        if (extraIsWorkspace)
        {
            symlinkSync(join(shared, 'packages', 'extra'), join(shared, 'node_modules', 'extra'), 'junction')
        }
        return ClosureCheck.Run(root, { Siblings: F.Siblings, Apps: [F.App] })
    }

    /** The app's Dockerfile: its shared modules stage runs `install`, and the app copies `modulesFrom`'s pragmatic-shared/node_modules. */
    public static SharedTarget(install: string, modulesFrom: string): string
    {
        return [
            'FROM node AS build',
            'FROM build AS app-shared-modules',
            'RUN cd pragmatic-shared && ' + install,
            'FROM node AS runtime',
            'FROM runtime AS app',
            'COPY --from=build /workspace/pragmatic-shared/packages/s /workspace/pragmatic-shared/packages/s',
            'COPY --from=' + modulesFrom + ' /workspace/pragmatic-shared/node_modules /workspace/pragmatic-shared/node_modules',
            'COPY --from=build /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules',
            'COPY --from=build /workspace/pragmatic-server/dist /workspace/pragmatic-server/dist',
            'ENTRYPOINT ["node", "dist/bin/app.js"]',
            '',
        ].join('\n')
    }

    public static Cleanup(): void
    {
        for (const root of FixtureWorkspace.Roots)
        {
            rmSync(root, { recursive: true, force: true })
        }
    }

    public static Package(dir: string, name: string, source: string): void
    {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
        writeFileSync(join(dir, 'index.js'), source)
    }
}

const ImportsA = "import { Value } from 'a'\nconsole.log(Value)\n"
const ImportsThird = "import { Third } from 'third'\nconsole.log(Third)\n"
const ImportsNothing = "console.log(1)\n"
const ImportsLib = "import { Lib } from '../lib/util.js'\nconsole.log(Lib)\n"
const LibSource = 'src/lib/util.ts'
const LibText = 'export const Lib = 2\n'
const Dist = 'pragmatic-server/dist'
const DistBin = 'pragmatic-server/dist/bin'
const DistLib = 'pragmatic-server/dist/lib'
const LibCompiled = 'pragmatic-server/dist/lib/util.js'
const Modules = 'pragmatic-server/node_modules'

describe('ClosureCheck', () =>
{
    after(() => FixtureWorkspace.Cleanup())

    it('reports a listed package the entry does not reach as extra', () =>
    {
        const report = FixtureWorkspace.Report(FixtureWorkspace.Make(['a', 'b'], [Dist, Modules], ImportsA))
        assert.equal(report.Apps.length, 1)
        assert.deepEqual(report.Apps[0].Reached, ['a'])
        assert.deepEqual(report.Apps[0].Extra, ['b'])
        assert.deepEqual(report.Apps[0].Missing, [])
        assert.equal(report.Ok, false)
    })

    it('reports a reached package the closure does not list as missing', () =>
    {
        const report = FixtureWorkspace.Report(FixtureWorkspace.Make([], [Dist, Modules], ImportsA))
        assert.deepEqual(report.Apps[0].Missing, ['a'])
        assert.deepEqual(report.Apps[0].Extra, [])
        assert.equal(report.Ok, false)
    })

    it('passes when the listed packages are exactly the reached ones', () =>
    {
        const report = FixtureWorkspace.Report(FixtureWorkspace.Make(['a'], [Dist, Modules], ImportsA))
        assert.deepEqual(report.Apps[0].Missing, [])
        assert.deepEqual(report.Apps[0].Extra, [])
        assert.equal(report.Ok, true)
    })

    it('requires the server node_modules when a sibling (linked there) or a third-party package is reached', () =>
    {
        assert.deepEqual(FixtureWorkspace.Report(FixtureWorkspace.Make(['a'], [Dist], ImportsA)).Apps[0].Missing, [Modules])
        assert.deepEqual(FixtureWorkspace.Report(FixtureWorkspace.Make([], [Dist], ImportsThird)).Apps[0].Missing, [Modules])
        const unneeded = FixtureWorkspace.Report(FixtureWorkspace.Make([], [Dist, Modules], ImportsNothing))
        assert.deepEqual(unneeded.Apps[0].Extra, [Modules])
        assert.equal(FixtureWorkspace.Report(FixtureWorkspace.Make([], [Dist], ImportsNothing)).Ok, true)
    })

    it('checks the Dockerfile target copies exactly the closure and starts its entrypoint', () =>
    {
        const target = [
            'FROM node AS build',
            'FROM node AS runtime',
            'FROM runtime AS app',
            'COPY --from=build --chown=10001:10001 /workspace/a /workspace/a',
            'COPY --from=build /workspace/c /workspace/c',
            'COPY --from=build /workspace/pragmatic-server/dist /workspace/pragmatic-server/dist',
            'ENTRYPOINT ["node", "dist/bin/other.js"]',
            '',
        ].join('\n')
        const report = FixtureWorkspace.Report(FixtureWorkspace.Make(['a'], [Dist, Modules], ImportsA, target))
        assert.deepEqual(report.Apps[0].Missing, ['Dockerfile: COPY pragmatic-server/node_modules', 'Dockerfile: ENTRYPOINT ["node","dist/bin/app.js"]'])
        assert.deepEqual(report.Apps[0].Extra, ['Dockerfile: COPY c'])
        const good = target.replace('/workspace/c /workspace/c', '/workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules')
            .replace('other.js', 'app.js')
        assert.equal(FixtureWorkspace.Report(FixtureWorkspace.Make(['a'], [Dist, Modules], ImportsA, good)).Ok, true)
    })

    it('reports an entrypoint outside every copied dir as missing', () =>
    {
        const report = FixtureWorkspace.Report(FixtureWorkspace.Make(['a'], [Modules], ImportsA))
        assert.deepEqual(report.Apps[0].Missing, ['pragmatic-server/dist/bin/app.js'])
    })

    it('requires the compiled output of every server module the entry reaches to sit inside a copied dir', () =>
    {
        const root = FixtureWorkspace.Make([], [DistBin], ImportsLib)
        FixtureWorkspace.Source(root, LibSource, LibText)
        const report = FixtureWorkspace.Report(root)
        assert.deepEqual(report.Apps[0].Missing, [LibCompiled])
        const covered = FixtureWorkspace.Make([], [DistBin, DistLib], ImportsLib)
        FixtureWorkspace.Source(covered, LibSource, LibText)
        assert.equal(FixtureWorkspace.Report(covered).Ok, true)
    })
})

const DeclaresDep = { dependencies: { dep: '^1.0.0' } }
const Filtered = 'npm ci --omit=dev --ignore-scripts --workspace=packages/s'
const OwnStage = 'app-shared-modules'

describe('ClosureCheck: pragmatic-shared dependencies', () =>
{
    after(() => FixtureWorkspace.Cleanup())

    it('passes when every third-party package a shared package loads is its production dependency in the shared lock', () =>
    {
        const report = FixtureWorkspace.SharedReport(DeclaresDep)
        assert.deepEqual(report.Apps[0].Missing, [])
        assert.equal(report.Ok, true)
    })

    it('reports a reached third-party package the listed shared packages do not depend on (only hoisting made it resolve)', () =>
    {
        const undeclared = ['not a production dependency of the listed shared packages: pragmatic-shared/node_modules/dep']
        assert.deepEqual(FixtureWorkspace.SharedReport({}).Apps[0].Missing, undeclared)
        assert.deepEqual(FixtureWorkspace.SharedReport({ devDependencies: { dep: '^1.0.0' } }).Apps[0].Missing, undeclared, 'a dev dependency is not installed')
    })

    it('knows every pragmatic-shared workspace package as a sibling: one the entry reaches but closure.json omits is missing', () =>
    {
        const report = FixtureWorkspace.ExtraSharedReport(true)
        assert.deepEqual(report.Apps[0].Reached, ['pragmatic-shared/packages/extra', 'pragmatic-shared/packages/s'])
        assert.deepEqual(report.Apps[0].Missing, ['pragmatic-shared/packages/extra'])
        assert.equal(report.Ok, false)
    })

    it('reports a reached file under pragmatic-shared/packages that belongs to no workspace package as missing', () =>
    {
        const report = FixtureWorkspace.ExtraSharedReport(false)
        assert.deepEqual(report.Apps[0].Missing, ['pragmatic-shared/packages/extra'])
        assert.equal(report.Ok, false)
    })

    it('reads the shared siblings from the pragmatic-shared workspaces', () =>
    {
        const root = FixtureWorkspace.Make([], [], ImportsNothing)
        assert.deepEqual(ClosureCheck.SharedSiblings(root), [])
        FixtureWorkspace.AddShared(root, {})
        assert.deepEqual(ClosureCheck.SharedSiblings(root), ['pragmatic-shared/packages/s', 'pragmatic-shared/packages/cloud'])
    })

    it('requires the image to copy pragmatic-shared/node_modules from its own install, filtered to exactly its shared packages', () =>
    {
        assert.equal(FixtureWorkspace.SharedReport(DeclaresDep, FixtureWorkspace.SharedTarget(Filtered, OwnStage)).Ok, true)

        const fromBuild = FixtureWorkspace.SharedReport(DeclaresDep, FixtureWorkspace.SharedTarget(Filtered, 'build')).Apps[0]
        assert.deepEqual(fromBuild.Missing, ['Dockerfile: COPY --from=app-shared-modules pragmatic-shared/node_modules'])

        const withCloud = FixtureWorkspace.SharedReport(DeclaresDep, FixtureWorkspace.SharedTarget(Filtered + ' --workspace=packages/cloud', OwnStage)).Apps[0]
        assert.deepEqual(withCloud.Extra, ['Dockerfile: npm ci --workspace=packages/cloud'], 'an unlisted package would bring its SDKs')

        const unfiltered = FixtureWorkspace.SharedReport(DeclaresDep, FixtureWorkspace.SharedTarget('npm ci --omit=dev', OwnStage)).Apps[0]
        assert.deepEqual(unfiltered.Missing, ['Dockerfile: npm ci --workspace=packages/s'], 'an unfiltered install brings every package')

        const withDev = FixtureWorkspace.SharedReport(DeclaresDep, FixtureWorkspace.SharedTarget('npm ci --workspace=packages/s', OwnStage)).Apps[0]
        assert.deepEqual(withDev.Missing, ['Dockerfile: npm ci --omit=dev in app-shared-modules'])
    })
})

describe('SharedLockClosure', () =>
{
    it('resolves nearest-first, follows links inside the workspace, and stops at links out of it, dev deps and optional peers', () =>
    {
        const lock = SharedLockClosure.FromPackages({
            'packages/x': { dependencies: { y: '1', '@s/a': '1', sib: '1', out: '1' }, peerDependencies: { p: '1', q: '1' }, peerDependenciesMeta: { q: { optional: true } } },
            'packages/x/node_modules/@s/a': { dependencies: { b: '1' } },
            'packages/y': { dependencies: { c: '1' }, devDependencies: { d: '1' } },
            'node_modules/y': { link: true, resolved: 'packages/y' },
            'node_modules/sib': { link: true, resolved: '../sib' },
            'node_modules/out': { version: '1' },
            'node_modules/b': { dependencies: { e: '1' } },
            'node_modules/b/node_modules/e': {},
            'node_modules/e': {},
            'node_modules/c': {},
            'node_modules/d': {},
            'node_modules/p': {},
            'node_modules/q': {},
            'node_modules/@s/a': {},
        })
        assert.deepEqual([...lock.Of(['packages/x'])].sort(), [
            'node_modules/b', 'node_modules/b/node_modules/e', 'node_modules/c', 'node_modules/out', 'node_modules/p',
            'packages/x/node_modules/@s/a',
        ])
    })

    it('names the package dir a file lies in, scoped or nested', () =>
    {
        assert.equal(SharedLockClosure.PackageDirOf('node_modules/jose/dist/index.js'), 'node_modules/jose')
        assert.equal(SharedLockClosure.PackageDirOf('node_modules/@aws-sdk/client-s3/dist/index.js'), 'node_modules/@aws-sdk/client-s3')
        assert.equal(SharedLockClosure.PackageDirOf('node_modules/a/node_modules/b/index.js'), 'node_modules/a/node_modules/b')
        assert.equal(SharedLockClosure.PackageDirOf('packages/s/index.js'), undefined)
    })
})
