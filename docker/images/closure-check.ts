import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReleaseApps } from '../../admin/control-plane/release/release-tag.js'

/** The esbuild metafile: every source file a build loaded, keyed by its path relative to the working dir. */
export interface IEsbuildMetafile
{
    inputs: Record<string, unknown>
}

/** The slice of esbuild's JS API the closure probes drive. */
export interface IEsbuild
{
    build(options: Record<string, unknown>): Promise<{ metafile: IEsbuildMetafile }>
    buildSync(options: Record<string, unknown>): { metafile: IEsbuildMetafile }
}

/**
 * Finds esbuild without declaring it: the server's own node_modules first (tsx brings it), else the sibling TODL
 * checkout's, and loads it through its JS API.
 */
export class EsbuildLocator
{
    private static readonly PackageName = 'esbuild'
    private static readonly PackageJson = 'package.json'
    private static readonly NodeModules = 'node_modules'
    private static readonly TodlSibling = '../TODL'
    private static readonly NotFoundMessage = 'esbuild not found in the server or ../TODL node_modules'

    public static Load(serverRoot: string): IEsbuild
    {
        for (const root of [serverRoot, resolve(serverRoot, EsbuildLocator.TodlSibling)])
        {
            if (existsSync(join(root, EsbuildLocator.NodeModules, EsbuildLocator.PackageName)))
            {
                return createRequire(join(root, EsbuildLocator.PackageJson))(EsbuildLocator.PackageName) as IEsbuild
            }
        }
        throw new Error(EsbuildLocator.NotFoundMessage)
    }
}

/** One app's entry in closure.json (wire casing). Paths in `files` are relative to the workspace root. */
export interface IClosureEntry
{
    entrypoint: string[]
    packages: string[]
    files: string[]
    /** Other commands the same image runs (paths relative to the server dir), e.g. the worker beside the env server. */
    alsoRuns?: string[]
}

/** What one app's entry points reach, against what its closure lists. */
export interface IAppClosure
{
    App: string
    Reached: string[]
    Missing: string[]
    Extra: string[]
}

export interface IClosureCheckOptions
{
    /** The sibling dirs the image build copies; defaults to the Dockerfile's build list. */
    Siblings?: readonly string[]
    /** The apps closure.json must describe; defaults to every release app. */
    Apps?: readonly string[]
}

export class ClosureReport
{
    private static readonly OkLabel = ': ok'
    private static readonly ReachesLabel = ' reaches '
    private static readonly MissingLabel = ': missing '
    private static readonly ExtraLabel = ' extra '
    private static readonly ListSeparator = ', '
    private static readonly None = '(no sibling)'

    public constructor(public readonly Apps: readonly IAppClosure[])
    {
    }

    public get Ok(): boolean
    {
        return this.Apps.every(a => a.Missing.length === 0 && a.Extra.length === 0)
    }

    /** One line per app, for the CI log. */
    public Describe(): string[]
    {
        const R = ClosureReport
        return this.Apps.map(a => a.Missing.length === 0 && a.Extra.length === 0
            ? a.App + R.OkLabel + R.ReachesLabel + (a.Reached.length === 0 ? R.None : a.Reached.join(R.ListSeparator))
            : a.App + R.MissingLabel + JSON.stringify(a.Missing) + R.ExtraLabel + JSON.stringify(a.Extra))
    }
}

/** The stages of docker/images/Dockerfile: per stage, the workspace paths it copies from the build stage and its ENTRYPOINT. */
export class DockerfileTargets
{
    private static readonly FromPattern = /^FROM\s+\S+\s+AS\s+(\S+)$/i
    private static readonly CopyPattern = /^COPY\s+(.+)$/i
    private static readonly EntrypointPattern = /^ENTRYPOINT\s+(\[.*\])$/i
    private static readonly FromBuildFlag = '--from=build'
    private static readonly FlagPrefix = '--'
    private static readonly WorkspacePrefix = '/workspace/'
    private static readonly Continuation = /\\\r?\n/g
    private static readonly LineBreak = /\r?\n/
    private static readonly Space = ' '
    private static readonly Whitespace = /\s+/

    private constructor(private readonly copies: Map<string, string[]>, private readonly entrypoints: Map<string, string[]>)
    {
    }

    public static Parse(text: string): DockerfileTargets
    {
        const D = DockerfileTargets
        const copies = new Map<string, string[]>()
        const entrypoints = new Map<string, string[]>()
        let stage: string | undefined
        for (const raw of text.replace(D.Continuation, D.Space).split(D.LineBreak))
        {
            const line = raw.trim()
            const from = D.FromPattern.exec(line)
            if (from !== null)
            {
                stage = from[1]
                copies.set(stage, [])
                continue
            }
            const copy = D.CopyPattern.exec(line)
            if (copy !== null && stage !== undefined)
            {
                const tokens = copy[1].split(D.Whitespace)
                if (tokens.includes(D.FromBuildFlag))
                {
                    const paths = tokens.filter(t => !t.startsWith(D.FlagPrefix))
                    for (const source of paths.slice(0, -1))
                    {
                        copies.get(stage)?.push(source.startsWith(D.WorkspacePrefix) ? source.slice(D.WorkspacePrefix.length) : source)
                    }
                }
                continue
            }
            const entry = D.EntrypointPattern.exec(line)
            if (entry !== null && stage !== undefined)
            {
                entrypoints.set(stage, JSON.parse(entry[1]) as string[])
            }
        }
        return new DockerfileTargets(copies, entrypoints)
    }

    public Copies(stage: string): readonly string[]
    {
        return this.copies.get(stage) ?? []
    }

    public Entrypoint(stage: string): readonly string[] | undefined
    {
        return this.entrypoints.get(stage)
    }
}

/** closure.json is unreadable, or does not describe exactly the expected apps. */
export class ClosureManifestError extends Error
{
    private static readonly ErrorName = 'ClosureManifestError'

    public constructor(message: string)
    {
        super(message)
        this.name = ClosureManifestError.ErrorName
    }
}

/**
 * Measures each app image's package closure: bundles the app's TypeScript entry points with esbuild (metafile only,
 * nothing written) and reports the sibling packages the build loaded against the packages its closure.json entry lists.
 * A loaded file belongs to the package of its nearest named package.json, so a sibling counts as reached whether it is
 * loaded through its own checkout (a `file:` link) or a copy nested in another package's node_modules: that keeps the
 * result the same on a dev box with npm-linked siblings and in CI / the image build with registry copies. Reaching any
 * sibling (linked from the server's node_modules) or a third-party package installed there requires
 * `pragmatic-server/node_modules` in `files`, and every
 * entry point must sit inside a copied `files` dir.
 */
export class ClosureCheck
{
    /** The sibling dirs docker/images/Dockerfile copies and builds, in build order. */
    public static readonly Siblings: readonly string[] = [
        'pragmatic-graph', 'todl-runtime', 'TODL', 'Mural', 'pragmatic-protocol', 'todl-identity', 'todl-identity-local',
        'todl-identity-host', 'todl-identity-cloud', 'todl-identity-engine', 'todl-connectors-host', 'todl-platform-node',
        'todl-platform-cloud', 'todl-platform-aws', 'todl-platform-azure', 'todl-platform-gcp', 'todl-identity-node',
    ]
    public static readonly ServerModules = 'pragmatic-server/node_modules'
    private static readonly ServerDir = 'pragmatic-server'
    private static readonly ManifestPath = 'docker/images/closure.json'
    private static readonly DockerfilePath = 'docker/images/Dockerfile'
    private static readonly DockerfileCopyLabel = 'Dockerfile: COPY '
    private static readonly DockerfileEntrypointLabel = 'Dockerfile: ENTRYPOINT '
    private static readonly PackageJson = 'package.json'
    private static readonly NodeModules = 'node_modules'
    private static readonly Utf8 = 'utf8'
    private static readonly Slash = '/'
    private static readonly ParentSegment = '..'
    private static readonly DistPrefix = 'dist/'
    private static readonly SrcPrefix = 'src/'
    private static readonly TenantAdminDistPrefix = 'dist-tenant-admin/'
    private static readonly JsExtension = /\.js$/
    private static readonly TsExtension = '.ts'
    private static readonly Platform = 'node'
    private static readonly Format = 'esm'
    private static readonly LogLevel = 'silent'
    private static readonly ServerRoot = resolve(dirname(fileURLToPath(import.meta.url)), ClosureCheck.ParentSegment, ClosureCheck.ParentSegment)
    private static readonly UnreadableManifest = 'closure.json cannot be read: '
    private static readonly MissingAppPrefix = 'closure.json has no entry for '
    private static readonly UnknownAppPrefix = 'closure.json names an unknown app: '
    private static readonly MissingSiblingPrefix = 'Sibling checkout is missing or has no package name: '
    private static readonly BadEntrypointPrefix = 'closure.json entrypoint is not a compiled dist path: '
    private static readonly FailedSummary = 'Image closures differ from closure.json'

    public static Run(workspaceRoot: string, options: IClosureCheckOptions = {}): ClosureReport
    {
        const C = ClosureCheck
        const root = resolve(workspaceRoot)
        const manifest = C.ReadManifest(join(root, C.ServerDir, C.ManifestPath))
        const apps = options.Apps ?? ReleaseApps.All
        for (const app of Object.keys(manifest))
        {
            if (!apps.includes(app))
            {
                throw new ClosureManifestError(C.UnknownAppPrefix + app)
            }
        }
        const siblingByName = C.SiblingNames(root, options.Siblings ?? C.Siblings)
        const esbuild = EsbuildLocator.Load(C.ServerRoot)
        const owners = new Map<string, string | undefined>()
        const dockerfile = join(root, C.ServerDir, C.DockerfilePath)
        const targets = existsSync(dockerfile) ? DockerfileTargets.Parse(readFileSync(dockerfile, C.Utf8)) : undefined
        return new ClosureReport(apps.map(app =>
        {
            const entry = manifest[app]
            if (entry === undefined)
            {
                throw new ClosureManifestError(C.MissingAppPrefix + app)
            }
            return C.Measure(app, entry, root, siblingByName, esbuild, owners, targets)
        }))
    }

    public static Main(argv: readonly string[]): number
    {
        const root = argv[0] ?? resolve(ClosureCheck.ServerRoot, ClosureCheck.ParentSegment)
        const report = ClosureCheck.Run(root)
        for (const line of report.Describe())
        {
            console.log(line)
        }
        if (!report.Ok)
        {
            console.error(ClosureCheck.FailedSummary)
            return 1
        }
        return 0
    }

    /** True when this module is the process entry point (not when imported by tests). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
    }

    private static Measure(app: string, entry: IClosureEntry, root: string, siblingByName: Map<string, string>, esbuild: IEsbuild, owners: Map<string, string | undefined>, targets: DockerfileTargets | undefined): IAppClosure
    {
        const C = ClosureCheck
        const server = join(root, C.ServerDir)
        const runs = [entry.entrypoint[entry.entrypoint.length - 1], ...(entry.alsoRuns ?? [])]
        const result = esbuild.buildSync({
            entryPoints: runs.map(r => join(server, C.SourceOf(r))),
            absWorkingDir: server,
            bundle: true,
            platform: C.Platform,
            format: C.Format,
            metafile: true,
            write: false,
            outdir: tmpdir(),
            logLevel: C.LogLevel,
        })
        const reached = new Set<string>()
        let serverModules = false
        const serverModulesDir = join(server, C.NodeModules) + sep
        for (const input of Object.keys(result.metafile.inputs))
        {
            const file = resolve(server, input)
            if (!existsSync(file))
            {
                continue
            }
            const owner = C.OwnerOf(dirname(file), root, owners)
            const sibling = owner === undefined ? undefined : siblingByName.get(owner)
            if (sibling !== undefined)
            {
                reached.add(sibling)
            }
            else if (file.startsWith(serverModulesDir))
            {
                serverModules = true
            }
        }
        const listed = new Set(entry.packages)
        const missing = [...reached].filter(p => !listed.has(p)).sort()
        const extra = [...listed].filter(p => !reached.has(p)).sort()
        // The server resolves its siblings through the file: links in its own node_modules, so reaching any sibling needs it too.
        serverModules = serverModules || reached.size > 0
        const modulesListed = entry.files.includes(C.ServerModules)
        if (serverModules && !modulesListed)
        {
            missing.push(C.ServerModules)
        }
        if (!serverModules && modulesListed)
        {
            extra.push(C.ServerModules)
        }
        for (const run of runs)
        {
            const path = C.ServerDir + C.Slash + run
            if (!entry.files.some(f => path === f || path.startsWith(f + C.Slash)))
            {
                missing.push(path)
            }
        }
        if (targets !== undefined)
        {
            C.CompareTarget(app, entry, targets, missing, extra)
        }
        return { App: app, Reached: [...reached].sort(), Missing: missing, Extra: extra }
    }

    /** The app's Dockerfile stage must copy exactly its packages and files, and start its entrypoint. */
    private static CompareTarget(app: string, entry: IClosureEntry, targets: DockerfileTargets, missing: string[], extra: string[]): void
    {
        const C = ClosureCheck
        const copied = targets.Copies(app)
        const listed = [...entry.packages, ...entry.files]
        missing.push(...listed.filter(p => !copied.includes(p)).map(p => C.DockerfileCopyLabel + p))
        extra.push(...copied.filter(p => !listed.includes(p)).map(p => C.DockerfileCopyLabel + p))
        const expected = JSON.stringify(entry.entrypoint)
        if (JSON.stringify(targets.Entrypoint(app)) !== expected)
        {
            missing.push(C.DockerfileEntrypointLabel + expected)
        }
    }

    /** The TypeScript source a compiled entry was emitted from: dist/ mirrors src/, dist-tenant-admin/ mirrors the repo. */
    private static SourceOf(compiled: string): string
    {
        const C = ClosureCheck
        const ts = compiled.replace(C.JsExtension, C.TsExtension)
        if (ts.startsWith(C.DistPrefix))
        {
            return C.SrcPrefix + ts.slice(C.DistPrefix.length)
        }
        if (ts.startsWith(C.TenantAdminDistPrefix))
        {
            return ts.slice(C.TenantAdminDistPrefix.length)
        }
        throw new ClosureManifestError(C.BadEntrypointPrefix + compiled)
    }

    /** The name in the nearest package.json that has one, walking up from `dir` to the workspace root. */
    private static OwnerOf(dir: string, root: string, cache: Map<string, string | undefined>): string | undefined
    {
        if (cache.has(dir))
        {
            return cache.get(dir)
        }
        let name: string | undefined
        const manifest = join(dir, ClosureCheck.PackageJson)
        if (existsSync(manifest))
        {
            name = (JSON.parse(readFileSync(manifest, ClosureCheck.Utf8)) as { name?: string }).name
        }
        if (name === undefined)
        {
            const parent = dirname(dir)
            const insideRoot = !relative(root, parent).startsWith(ClosureCheck.ParentSegment)
            name = parent !== dir && insideRoot ? ClosureCheck.OwnerOf(parent, root, cache) : undefined
        }
        cache.set(dir, name)
        return name
    }

    private static SiblingNames(root: string, siblings: readonly string[]): Map<string, string>
    {
        const byName = new Map<string, string>()
        for (const dir of siblings)
        {
            const manifest = join(root, dir, ClosureCheck.PackageJson)
            const name = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, ClosureCheck.Utf8)) as { name?: string }).name : undefined
            if (name === undefined)
            {
                throw new ClosureManifestError(ClosureCheck.MissingSiblingPrefix + dir)
            }
            byName.set(name, dir)
        }
        return byName
    }

    private static ReadManifest(path: string): Record<string, IClosureEntry>
    {
        try
        {
            return JSON.parse(readFileSync(path, ClosureCheck.Utf8)) as Record<string, IClosureEntry>
        }
        catch (err)
        {
            throw new ClosureManifestError(ClosureCheck.UnreadableManifest + (err as Error).message)
        }
    }
}

if (ClosureCheck.IsEntryPoint())
{
    process.exitCode = ClosureCheck.Main(process.argv.slice(2))
}
