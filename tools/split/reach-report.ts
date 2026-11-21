import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EsbuildLocator, type IEsbuild, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { AssignmentRules, SplitHome } from './assignment-rules.js'

/**
 * The split's assignment: every tracked file's home, the tests whose imports reach more than one container, and the
 * test-support files whose readers live in more than one home (each needs a copy, or a home decided by hand).
 */
export class SplitAssignment
{
    /** The folders the split assigns (every tracked file under them). */
    public static readonly Roots: readonly string[] = ['src', 'admin', 'docker', 'environments', 'idp-login', 'helm', 'release-keys', 'tools']
    private static readonly Git = 'git'
    private static readonly Utf8 = 'utf8'
    private static readonly Newline = '\n'

    public constructor(
        public readonly Homes: Readonly<Record<string, string>>,
        public readonly CrossHomeTests: readonly string[],
        public readonly SharedSupport: readonly string[])
    {
    }

    /** Every tracked (or staged) file under the roots that exists. */
    public static Files(root: string): string[]
    {
        const S = SplitAssignment
        const listed = execFileSync(S.Git, ['-C', root, 'ls-files', '--cached', ...S.Roots], { encoding: S.Utf8 })
        return [...new Set(listed.split(S.Newline).filter(line => line.length > 0))].filter(file => existsSync(join(root, file))).sort()
    }

    /** Files per home, for the Ledger. */
    public Counts(): ReadonlyMap<string, { Files: number; Tests: number }>
    {
        const counts = new Map<string, { Files: number; Tests: number }>()
        for (const [file, home] of Object.entries(this.Homes))
        {
            const entry = counts.get(home) ?? { Files: 0, Tests: 0 }
            if (ReachReport.IsTest(file))
            {
                entry.Tests++
            }
            else
            {
                entry.Files++
            }
            counts.set(home, entry)
        }
        return counts
    }
}

/** The esbuild metafile of a multi-entry build: each output's own inputs (its whole closure, no splitting). */
interface IOutputMetafile
{
    outputs: Record<string, { entryPoint?: string; inputs: Record<string, unknown> }>
}

/**
 * Measures who reaches which file of pragmatic-server: esbuild bundles each image's entry points (packages external,
 * type-only imports dropped as in the image closure check) and every test, and AssignmentRules places each file. A test
 * an explicit exception names goes there; the others
 * follow their subject (`dir/tests/x.test.ts` goes where `x.ts` goes, found beside the tests folder or, failing that,
 * as the one file of that name in the same area); a test with no subject goes to the one container its imports reach,
 * to the shared home most of its reach lies in when it reaches no container, or by its path when it reaches none of
 * the repository's files; one that reaches two or more containers is a cross-home test (pragmatic-e2e). A test-support
 * file (fixtures, helpers) goes where the tests that name it go; when they live in several homes it is listed.
 */
export class ReachReport
{
    private static readonly TestSuffix = '.test.ts'
    private static readonly TestsSegment = '/tests/'
    private static readonly TsExtension = '.ts'
    private static readonly JsExtension = '.js'
    private static readonly SharedPrefix = 'pragmatic-shared/'
    private static readonly Platform = 'node'
    private static readonly Format = 'esm'
    private static readonly LogLevel = 'silent'
    private static readonly External = 'external'
    private static readonly ParentSegment = '..'
    private static readonly NodeModules = 'node_modules'
    private static readonly Slash = '/'
    private static readonly Utf8 = 'utf8'
    private static readonly OutputFile = 'assignment.json'
    private static readonly OutDirSuffix = '-reach'
    private static readonly CountSeparator = ': '
    private static readonly FilesSuffix = ' files, '
    private static readonly TestsSuffix = ' tests'
    private static readonly CrossHomeLine = 'cross-home tests: '
    private static readonly SharedSupportLine = 'test support named by several homes: '
    private static readonly JsonIndent = 2
    private static readonly Newline = '\n'
    /** The area a subject is looked for in: the first two segments (`admin/control-plane`, `src/host`). */
    private static readonly AreaDepth = 2

    /** Each image's entry points (sources). */
    public static readonly Entries: ReadonlyMap<ReleaseApp, readonly string[]> = new Map<ReleaseApp, readonly string[]>([
        [ReleaseApp.PlatformAdmin, ['admin/control-plane/server.ts']],
        [ReleaseApp.PlatformEdge, ['admin/control-plane/bin/pragmatic-platform-edged.ts']],
        [ReleaseApp.EnvServer, ['src/bin/pragmatic-serverd.ts', 'src/bin/pragmatic-workerd.ts']],
        [ReleaseApp.EnvGateway, ['src/bin/pragmatic-gatewayd.ts']],
        [ReleaseApp.HiveAgent, ['src/bin/pragmatic-agentd.ts']],
        [ReleaseApp.TenantAdmin, ['admin/control-plane/bin/pragmatic-tenant-admind.ts', 'admin/control-plane/bin/pragmatic-tenant-admin-import.ts']],
        [ReleaseApp.TenantIdp, ['src/bin/pragmatic-idpd.ts']],
        [ReleaseApp.UiUnpack, ['admin/control-plane/bin/pragmatic-ui-unpack.ts']],
    ])

    private readonly esbuild: IEsbuild
    private readonly rules = new AssignmentRules()

    public constructor(private readonly root: string)
    {
        this.esbuild = EsbuildLocator.Load(root)
    }

    public static IsTest(file: string): boolean
    {
        return file.endsWith(ReachReport.TestSuffix)
    }

    private static InTestsFolder(file: string): boolean
    {
        return file.includes(ReachReport.TestsSegment)
    }

    /** The repository's own files (relative, `/`-separated) an entry point reaches. */
    public async For(entry: string): Promise<ReadonlySet<string>>
    {
        return (await this.ForEach([entry])).get(entry) ?? new Set<string>()
    }

    /** The own files each entry reaches, by entry, from one build. */
    public async ForEach(entries: readonly string[]): Promise<ReadonlyMap<string, ReadonlySet<string>>>
    {
        const R = ReachReport
        // buildSync, as the image closure check: no esbuild service outlives the call.
        const result = this.esbuild.buildSync({
            entryPoints: entries.map(entry => join(this.root, entry)),
            absWorkingDir: this.root,
            bundle: true,
            platform: R.Platform,
            format: R.Format,
            packages: R.External,
            metafile: true,
            write: false,
            outdir: join(tmpdir(), basename(this.root) + R.OutDirSuffix),
            logLevel: R.LogLevel,
        })
        const metafile = result.metafile as unknown as IOutputMetafile
        const byEntry = new Map<string, ReadonlySet<string>>()
        for (const output of Object.values(metafile.outputs))
        {
            if (output.entryPoint === undefined)
            {
                continue
            }
            const files = new Set<string>()
            for (const input of Object.keys(output.inputs))
            {
                const own = this.OwnPath(input)
                if (own !== undefined)
                {
                    files.add(own)
                }
            }
            byEntry.set(this.OwnPath(output.entryPoint) ?? output.entryPoint, files)
        }
        return byEntry
    }

    /** Which images reach each own file. */
    public async ReachedBy(): Promise<ReadonlyMap<string, ReleaseApp[]>>
    {
        const all = [...new Set([...ReachReport.Entries.values()].flat())]
        const reach = await this.ForEach(all)
        const by = new Map<string, ReleaseApp[]>()
        for (const [app, entries] of ReachReport.Entries)
        {
            const files = new Set(entries.flatMap(entry => [...(reach.get(entry) ?? [])]))
            for (const file of files)
            {
                by.set(file, [...(by.get(file) ?? []), app])
            }
        }
        return by
    }

    public async Assignment(): Promise<SplitAssignment>
    {
        const R = ReachReport
        const tracked = SplitAssignment.Files(this.root)
        const reachedBy = await this.ReachedBy()
        const homes: Record<string, string> = {}
        for (const file of tracked.filter(f => !R.InTestsFolder(f)))
        {
            homes[file] = this.rules.Assign(file, reachedBy.get(file) ?? []).Home
        }
        const tests = tracked.filter(f => R.InTestsFolder(f) && R.IsTest(f))
        const cross = this.PlaceTests(tests, homes, await this.ForEach(tests))
        const shared = this.PlaceSupport(tracked.filter(f => R.InTestsFolder(f) && !R.IsTest(f)), tests, homes, reachedBy)
        return new SplitAssignment(homes, cross.sort(), shared.sort())
    }

    /** Places every test (see the class comment); returns the cross-home ones. */
    private PlaceTests(tests: readonly string[], homes: Record<string, string>, testReach: ReadonlyMap<string, ReadonlySet<string>>): string[]
    {
        const R = ReachReport
        const cross: string[] = []
        for (const test of tests)
        {
            const named = AssignmentRules.Exceptions.get(test)
            if (named !== undefined)
            {
                homes[test] = named
                continue
            }
            const subject = R.SubjectOf(test, homes)
            if (subject !== undefined)
            {
                homes[test] = homes[subject]
                continue
            }
            const reached = [...(testReach.get(test) ?? [])].filter(f => !R.InTestsFolder(f) && homes[f] !== undefined).map(f => homes[f])
            const containers = new Set(reached.filter(h => !h.startsWith(R.SharedPrefix)))
            if (containers.size === 1)
            {
                homes[test] = [...containers][0]
            }
            else if (containers.size > 1)
            {
                homes[test] = SplitHome.E2e
                cross.push(test)
            }
            else if (reached.length > 0)
            {
                homes[test] = R.MostCommon(reached)
            }
            else
            {
                homes[test] = this.rules.Assign(test, []).Home
            }
        }
        return cross
    }

    /** Places every test-support file where the tests that name it go; returns the ones named from several homes. */
    private PlaceSupport(support: readonly string[], tests: readonly string[], homes: Record<string, string>, reachedBy: ReadonlyMap<string, ReleaseApp[]>): string[]
    {
        const R = ReachReport
        const texts = new Map(tests.map(t => [t, readFileSync(join(this.root, t), R.Utf8)]))
        const shared: string[] = []
        for (const file of support)
        {
            const name = R.ReferenceName(file)
            // The archive's own tests (the split tooling's) name files without being their readers.
            const readers = tests.filter(t => homes[t] !== SplitHome.Archive && (texts.get(t) as string).includes(name)).map(t => homes[t])
            const distinct = new Set(readers)
            if (distinct.size > 1)
            {
                shared.push(file)
            }
            if (readers.length > 0)
            {
                homes[file] = R.MostCommon(readers)
                continue
            }
            const folder = R.TestsFolderOf(file)
            const siblings = tests.filter(t => R.TestsFolderOf(t) === folder).map(t => homes[t])
            homes[file] = siblings.length > 0 ? R.MostCommon(siblings) : this.rules.Assign(file, reachedBy.get(file) ?? []).Home
        }
        return shared
    }

    /** How a test names a support file: a TypeScript helper by its compiled import name, anything else by its file name. */
    private static ReferenceName(file: string): string
    {
        const R = ReachReport
        const name = basename(file)
        return extname(name) === R.TsExtension ? name.slice(0, -R.TsExtension.length) + R.JsExtension : name
    }

    /** `dir/tests/x.test.ts` → `dir/x.ts` when tracked, else the one tracked `x.ts` in the same area (outside tests). */
    private static SubjectOf(test: string, homes: Readonly<Record<string, string>>): string | undefined
    {
        const R = ReachReport
        const name = basename(test).slice(0, -R.TestSuffix.length) + R.TsExtension
        const beside = R.TestsFolderOf(test).slice(0, -R.TestsSegment.length + 1) + name
        if (homes[beside] !== undefined)
        {
            return beside
        }
        const area = beside.split(R.Slash).slice(0, R.AreaDepth).join(R.Slash) + R.Slash
        const named = Object.keys(homes).filter(f => f.startsWith(area) && !R.InTestsFolder(f) && basename(f) === name)
        return named.length === 1 ? named[0] : undefined
    }

    /** The folder path up to and including the last `/tests/`. */
    private static TestsFolderOf(file: string): string
    {
        const at = file.lastIndexOf(ReachReport.TestsSegment)
        return file.slice(0, at + ReachReport.TestsSegment.length)
    }

    private static MostCommon(values: readonly string[]): string
    {
        const counts = new Map<string, number>()
        for (const value of values)
        {
            counts.set(value, (counts.get(value) ?? 0) + 1)
        }
        return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    }

    /** A metafile path as a repository-relative path, or undefined outside the repository or in node_modules. */
    private OwnPath(input: string): string | undefined
    {
        const R = ReachReport
        const path = relative(this.root, resolve(this.root, input)).split(sep).join(R.Slash)
        return path.startsWith(R.ParentSegment) || path.split(R.Slash).includes(R.NodeModules) ? undefined : path
    }

    /** `tsx tools/split/reach-report.ts`: writes tools/split/assignment.json and prints the per-home counts. */
    public static async Main(): Promise<number>
    {
        const R = ReachReport
        const here = dirname(fileURLToPath(import.meta.url))
        const assignment = await new ReachReport(resolve(here, R.ParentSegment, R.ParentSegment)).Assignment()
        const sorted = Object.fromEntries(Object.entries(assignment.Homes).sort(([a], [b]) => a.localeCompare(b)))
        const document = { homes: sorted, crossHomeTests: assignment.CrossHomeTests, sharedSupport: assignment.SharedSupport }
        writeFileSync(join(here, R.OutputFile), JSON.stringify(document, null, R.JsonIndent) + R.Newline)
        for (const [home, count] of [...assignment.Counts()].sort(([a], [b]) => a.localeCompare(b)))
        {
            console.log(home + R.CountSeparator + count.Files + R.FilesSuffix + count.Tests + R.TestsSuffix)
        }
        console.log(R.CrossHomeLine + assignment.CrossHomeTests.length)
        console.log(R.SharedSupportLine + assignment.SharedSupport.length)
        return 0
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
    }
}

if (ReachReport.IsEntryPoint())
{
    process.exitCode = await ReachReport.Main()
}
