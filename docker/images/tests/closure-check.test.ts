import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ClosureCheck, type ClosureReport } from '../closure-check.js'

/** A throwaway workspace: three tiny sibling packages a, b, c and a server whose one app imports `a`. */
class FixtureWorkspace
{
    public static readonly App = 'app'
    public static readonly Siblings: readonly string[] = ['a', 'b', 'c']
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

    public static Cleanup(): void
    {
        for (const root of FixtureWorkspace.Roots)
        {
            rmSync(root, { recursive: true, force: true })
        }
    }

    private static Package(dir: string, name: string, source: string): void
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
