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
    /** The apps closure.json must describe; defaults to every Node release app (pragmatic-postgres has its own image). */
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

/** One `COPY --from=<stage>` of a Dockerfile stage: the stage it copies from and the workspace path. */
export interface IStageCopy
{
    From: string
    Path: string
}

/**
 * The stages of docker/images/Dockerfile: per stage, the workspace paths it copies from other stages, its ENTRYPOINT, and
 * the `npm ci` installs its RUN lines make (whether dev deps are omitted, and the `--workspace=` filters).
 */
export class DockerfileTargets
{
    private static readonly FromPattern = /^FROM\s+\S+\s+AS\s+(\S+)$/i
    private static readonly CopyPattern = /^COPY\s+(.+)$/i
    private static readonly RunPattern = /^RUN\s+(.+)$/i
    private static readonly EntrypointPattern = /^ENTRYPOINT\s+(\[.*\])$/i
    private static readonly FromFlagPrefix = '--from='
    private static readonly FlagPrefix = '--'
    private static readonly WorkspacePrefix = '/workspace/'
    private static readonly WorkspaceFlagPrefix = '--workspace='
    private static readonly OmitDevFlag = '--omit=dev'
    private static readonly NpmCi = /\bnpm ci\b/
    private static readonly Continuation = /\\\r?\n/g
    private static readonly LineBreak = /\r?\n/
    private static readonly Space = ' '
    private static readonly Whitespace = /\s+/

    private constructor(
        private readonly copies: Map<string, IStageCopy[]>,
        private readonly entrypoints: Map<string, string[]>,
        private readonly workspaces: Map<string, string[]>,
        private readonly omitsDev: Map<string, boolean>,
    )
    {
    }

    public static Parse(text: string): DockerfileTargets
    {
        const D = DockerfileTargets
        const copies = new Map<string, IStageCopy[]>()
        const entrypoints = new Map<string, string[]>()
        const workspaces = new Map<string, string[]>()
        const omitsDev = new Map<string, boolean>()
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
            if (stage === undefined)
            {
                continue
            }
            const copy = D.CopyPattern.exec(line)
            if (copy !== null)
            {
                const tokens = copy[1].split(D.Whitespace)
                const source = tokens.find(t => t.startsWith(D.FromFlagPrefix))
                if (source !== undefined)
                {
                    const paths = tokens.filter(t => !t.startsWith(D.FlagPrefix))
                    for (const path of paths.slice(0, -1))
                    {
                        copies.get(stage)?.push({
                            From: source.slice(D.FromFlagPrefix.length),
                            Path: path.startsWith(D.WorkspacePrefix) ? path.slice(D.WorkspacePrefix.length) : path,
                        })
                    }
                }
                continue
            }
            const run = D.RunPattern.exec(line)
            if (run !== null && D.NpmCi.test(run[1]))
            {
                const tokens = run[1].split(D.Whitespace)
                const filters = workspaces.get(stage) ?? []
                filters.push(...tokens.filter(t => t.startsWith(D.WorkspaceFlagPrefix)).map(t => t.slice(D.WorkspaceFlagPrefix.length)))
                workspaces.set(stage, filters)
                omitsDev.set(stage, (omitsDev.get(stage) ?? true) && tokens.includes(D.OmitDevFlag))
                continue
            }
            const entry = D.EntrypointPattern.exec(line)
            if (entry !== null)
            {
                entrypoints.set(stage, JSON.parse(entry[1]) as string[])
            }
        }
        return new DockerfileTargets(copies, entrypoints, workspaces, omitsDev)
    }

    /** The workspace paths the stage copies from the given stage. */
    public Copies(stage: string, from: string): readonly string[]
    {
        return (this.copies.get(stage) ?? []).filter(c => c.From === from).map(c => c.Path)
    }

    public Entrypoint(stage: string): readonly string[] | undefined
    {
        return this.entrypoints.get(stage)
    }

    /** The `--workspace=` filters of the stage's `npm ci` runs; undefined when it runs none. */
    public Workspaces(stage: string): readonly string[] | undefined
    {
        return this.workspaces.get(stage)
    }

    /** True when every `npm ci` the stage runs omits dev dependencies. */
    public OmitsDev(stage: string): boolean
    {
        return this.omitsDev.get(stage) === true
    }
}

/** One `packages` entry of a package-lock.json (wire casing). */
export interface ILockPackage
{
    version?: string
    link?: boolean
    resolved?: string
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/**
 * The third-party packages a filtered production install of an npm workspace places: from each workspace's lock entry,
 * its dependencies, optional dependencies and required peers, resolved through the lock's node_modules layout the way
 * Node resolves them (nearest node_modules first), transitively. A link into the workspace (a sibling workspace package)
 * is followed; a link out of it (a `file:../` sibling repo) is not, since that package ships as its own sibling.
 */
export class SharedLockClosure
{
    private static readonly NodeModulesSegment = 'node_modules/'
    private static readonly ScopePrefix = '@'
    private static readonly OutsidePrefix = '../'
    private static readonly Slash = '/'
    private static readonly Utf8 = 'utf8'

    private constructor(private readonly packages: Record<string, ILockPackage>)
    {
    }

    /** Reads the lock at `path`; undefined when there is none. */
    public static Load(path: string): SharedLockClosure | undefined
    {
        if (!existsSync(path))
        {
            return undefined
        }
        const lock = JSON.parse(readFileSync(path, SharedLockClosure.Utf8)) as { packages?: Record<string, ILockPackage> }
        return new SharedLockClosure(lock.packages ?? {})
    }

    public static FromPackages(packages: Record<string, ILockPackage>): SharedLockClosure
    {
        return new SharedLockClosure(packages)
    }

    /**
     * The package dir (a lock key such as `node_modules/@scope/name` or `node_modules/a/node_modules/b`) that a file path
     * relative to the workspace root lies in, or undefined when it lies in no node_modules.
     */
    public static PackageDirOf(relativePath: string): string | undefined
    {
        const S = SharedLockClosure
        const at = relativePath.lastIndexOf(S.NodeModulesSegment)
        if (at === -1)
        {
            return undefined
        }
        const rest = relativePath.slice(at + S.NodeModulesSegment.length).split(S.Slash)
        const length = rest[0].startsWith(S.ScopePrefix) ? 2 : 1
        if (rest.length <= length)
        {
            return undefined
        }
        return relativePath.slice(0, at + S.NodeModulesSegment.length) + rest.slice(0, length).join(S.Slash)
    }

    /** The lock keys of every third-party package a production install of the given workspaces (e.g. `packages/x`) places. */
    public Of(workspaces: readonly string[]): Set<string>
    {
        const placed = new Set<string>()
        const visited = new Set<string>(workspaces)
        const pending = [...workspaces]
        while (pending.length > 0)
        {
            const at = pending.pop() as string
            for (const name of this.DependencyNames(at))
            {
                const found = this.Resolve(at, name)
                if (found === undefined)
                {
                    continue
                }
                const entry = this.packages[found]
                let next = found
                if (entry.link === true)
                {
                    if (entry.resolved === undefined || entry.resolved.startsWith(SharedLockClosure.OutsidePrefix))
                    {
                        continue
                    }
                    next = entry.resolved
                }
                else
                {
                    placed.add(found)
                }
                if (!visited.has(next))
                {
                    visited.add(next)
                    pending.push(next)
                }
            }
        }
        return placed
    }

    private DependencyNames(key: string): string[]
    {
        const entry = this.packages[key]
        if (entry === undefined)
        {
            return []
        }
        const optionalPeer = entry.peerDependenciesMeta ?? {}
        const peers = Object.keys(entry.peerDependencies ?? {}).filter(p => optionalPeer[p]?.optional !== true)
        return [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...peers]
    }

    /** The lock key `name` resolves to from the package at `from`: its own node_modules, then each enclosing one. */
    private Resolve(from: string, name: string): string | undefined
    {
        const S = SharedLockClosure
        let dir = from
        for (;;)
        {
            const candidate = (dir === '' ? '' : dir + S.Slash) + S.NodeModulesSegment + name
            if (this.packages[candidate] !== undefined)
            {
                return candidate
            }
            if (dir === '')
            {
                return undefined
            }
            const at = dir.lastIndexOf(S.NodeModulesSegment)
            dir = at <= 0 ? '' : dir.slice(0, at - 1)
        }
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
 * entry point must sit inside a copied `files` dir. Reaching a pragmatic-shared package requires
 * `pragmatic-shared/node_modules`, which the image installs in its own stage for exactly its listed shared packages
 * (production deps only); so every third-party package loaded from the shared workspace must be in the lock closure of
 * those packages (SharedLockClosure), and the stage's `--workspace=` filters must equal them.
 */
export class ClosureCheck
{
    /**
     * The sibling repos docker/images/Dockerfile copies and builds, besides pragmatic-shared, in build order. The
     * pragmatic-shared packages are not listed here: they are read from that workspace's package.json (SharedSiblings),
     * so a package added there is a sibling the check knows without a second list to keep in step.
     */
    public static readonly Siblings: readonly string[] = [
        'pragmatic-graph', 'todl-runtime', 'TODL', 'Mural', 'pragmatic-protocol', 'todl-identity-engine', 'todl-connectors-host',
    ]
    /** The pragmatic-shared workspace repo; each of its `workspaces` (`packages/<x>`) is a sibling `pragmatic-shared/packages/<x>`. */
    public static readonly SharedRepo = 'pragmatic-shared'
    public static readonly ServerModules = 'pragmatic-server/node_modules'
    /** The pragmatic-shared workspace: its packages' third-party dependencies and sibling links are hoisted into its root node_modules. */
    public static readonly SharedModules = 'pragmatic-shared/node_modules'
    /**
     * An image's pragmatic-shared/node_modules comes from its own stage, `<app>` + this suffix: an `npm ci --omit=dev`
     * filtered with `--workspace=` to exactly the shared packages the app lists, never the build's install of all of them.
     */
    public static readonly SharedModulesStageSuffix = '-shared-modules'
    public static readonly BuildStage = 'build'
    private static readonly SharedDir = ClosureCheck.SharedRepo
    private static readonly SharedPackagesPrefix = 'packages/'
    private static readonly SharedPrefix = 'pragmatic-shared/'
    private static readonly SharedLock = 'pragmatic-shared/package-lock.json'
    private static readonly UndeclaredSharedPrefix = 'not a production dependency of the listed shared packages: '
    private static readonly DockerfileCopyFromPrefix = 'Dockerfile: COPY --from='
    private static readonly DockerfileWorkspacePrefix = 'Dockerfile: npm ci --workspace='
    private static readonly DockerfileInstallPrefix = 'Dockerfile: npm ci --omit=dev in '
    private static readonly ServerDir = 'pragmatic-server'
    private static readonly ManifestPath = 'docker/images/closure.json'
    private static readonly DockerfilePath = 'docker/images/Dockerfile'
    private static readonly DockerfileCopyLabel = 'Dockerfile: COPY '
    private static readonly DockerfileEntrypointLabel = 'Dockerfile: ENTRYPOINT '
    private static readonly PackageJson = 'package.json'
    private static readonly NodeModules = 'node_modules'
    private static readonly Utf8 = 'utf8'
    private static readonly Slash = '/'
    private static readonly Space = ' '
    private static readonly ParentSegment = '..'
    /**
     * Each compiled tree and the source dir it mirrors: dist/ is the server build of src/, dist-tenant-admin/ (the control
     * plane, tsconfig.tenant-admin.json) and dist-ui-unpack/ (the UI-unpack init container, tsconfig.ui-unpack.json) mirror the repo.
     */
    private static readonly CompiledRoots: ReadonlyArray<readonly [string, string]> = [
        ['dist/', 'src/'],
        ['dist-tenant-admin/', ''],
        ['dist-ui-unpack/', ''],
    ]
    private static readonly JsExtension = /\.js$/
    private static readonly TsSourceExtension = /\.ts$/
    private static readonly TsExtension = '.ts'
    private static readonly JsOutExtension = '.js'
    private static readonly NotCompiledPrefix = 'not compiled into the entry\'s tree: '
    private static readonly MixedRootsPrefix = 'closure.json entry runs commands from different compiled trees: '
    private static readonly Platform = 'node'
    private static readonly Format = 'esm'
    private static readonly LogLevel = 'silent'
    private static readonly ServerRoot = resolve(dirname(fileURLToPath(import.meta.url)), ClosureCheck.ParentSegment, ClosureCheck.ParentSegment)
    private static readonly UnreadableManifest = 'closure.json cannot be read: '
    private static readonly MissingAppPrefix = 'closure.json has no entry for '
    private static readonly UnknownAppPrefix = 'closure.json names an unknown app: '
    private static readonly MissingSiblingPrefix = 'Sibling checkout is missing or has no package name: '
    private static readonly UnreadableSharedWorkspace = 'pragmatic-shared/package.json cannot be read: '
    private static readonly WorkspacesNotList = '"workspaces" is not a list of paths'
    private static readonly BadEntrypointPrefix = 'closure.json entrypoint is not a compiled dist path: '
    private static readonly FailedSummary = 'Image closures differ from closure.json'

    public static Run(workspaceRoot: string, options: IClosureCheckOptions = {}): ClosureReport
    {
        const C = ClosureCheck
        const root = resolve(workspaceRoot)
        const manifest = C.ReadManifest(join(root, C.ServerDir, C.ManifestPath))
        const apps = options.Apps ?? ReleaseApps.NodeApps
        for (const app of Object.keys(manifest))
        {
            if (!apps.includes(app))
            {
                throw new ClosureManifestError(C.UnknownAppPrefix + app)
            }
        }
        const siblingByName = C.SiblingNames(root, [...(options.Siblings ?? C.Siblings), ...C.SharedSiblings(root)])
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
        const compiled = new Set<string>()
        let serverModules = false
        let sharedModules = false
        const sharedThirdParty = new Set<string>()
        const unknownShared = new Set<string>()
        const sharedRoot = join(root, C.SharedDir)
        const serverModulesDir = join(server, C.NodeModules) + sep
        const sharedModulesDir = join(root, ...C.SharedModules.split(C.Slash)) + sep
        const serverDir = server + sep
        const compiledRoot = C.CompiledRootOf(app, runs)
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
            else if (file.startsWith(sharedModulesDir))
            {
                sharedModules = true
                C.NoteSharedPackage(relative(sharedRoot, file), sharedThirdParty)
            }
            else if (file.startsWith(sharedRoot + sep))
            {
                // A file of the shared workspace that lies in no node_modules belongs to a package that is no workspace
                // sibling: the image would not build or copy it, so it is missing however closure.json lists the rest.
                const unknown = C.NoteSharedPackage(relative(sharedRoot, file), sharedThirdParty)
                if (unknown !== undefined)
                {
                    unknownShared.add(unknown)
                }
            }
            else if (file.startsWith(serverDir) && C.TsSourceExtension.test(file))
            {
                compiled.add(C.CompiledOf(relative(server, file).split(sep).join(C.Slash), compiledRoot))
            }
        }
        const listed = new Set(entry.packages)
        const missing = [...reached].filter(p => !listed.has(p)).sort()
        missing.push(...[...unknownShared].sort())
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
        // A pragmatic-shared package resolves its dependencies through the workspace's hoisted node_modules.
        sharedModules = sharedModules || [...reached].some(p => p.startsWith(C.SharedPrefix))
        const sharedListed = entry.files.includes(C.SharedModules)
        if (sharedModules && !sharedListed)
        {
            missing.push(C.SharedModules)
        }
        if (!sharedModules && sharedListed)
        {
            extra.push(C.SharedModules)
        }
        // Each image installs only its shared packages' production deps, so every third-party file it reaches must be one.
        missing.push(...C.UndeclaredShared(root, entry, sharedThirdParty))
        for (const run of runs)
        {
            const path = C.ServerDir + C.Slash + run
            if (!C.Covered(entry, path))
            {
                missing.push(path)
            }
        }
        // Every server module the entry loads must be shipped: its compiled file lies inside a copied dir. The entry files
        // themselves are reported above.
        const entries = new Set(runs.map(run => C.ServerDir + C.Slash + run))
        for (const path of [...compiled].sort())
        {
            if (!entries.has(path) && !C.Covered(entry, path))
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

    /**
     * The app's Dockerfile stage must copy exactly its packages and files, and start its entrypoint. Its
     * pragmatic-shared/node_modules must come from its own modules stage, whose `npm ci --omit=dev` is filtered to exactly
     * the shared packages it lists: one more pulls that package's dependencies (a cloud SDK) into the image, one fewer
     * leaves a reached package without its dependencies.
     */
    private static CompareTarget(app: string, entry: IClosureEntry, targets: DockerfileTargets, missing: string[], extra: string[]): void
    {
        const C = ClosureCheck
        const modulesStage = app + C.SharedModulesStageSuffix
        const fromBuild = targets.Copies(app, C.BuildStage)
        const fromModules = targets.Copies(app, modulesStage)
        const copied = [...fromBuild, ...fromModules]
        const listed = [...entry.packages, ...entry.files]
        missing.push(...listed.filter(p => !copied.includes(p)).map(p => C.DockerfileCopyLabel + p))
        extra.push(...copied.filter(p => !listed.includes(p)).map(p => C.DockerfileCopyLabel + p))
        const expected = JSON.stringify(entry.entrypoint)
        if (JSON.stringify(targets.Entrypoint(app)) !== expected)
        {
            missing.push(C.DockerfileEntrypointLabel + expected)
        }
        const fromStage = C.DockerfileCopyFromPrefix + modulesStage + C.Space
        extra.push(...fromModules.filter(p => p !== C.SharedModules).map(p => fromStage + p))
        if (!entry.files.includes(C.SharedModules))
        {
            return
        }
        if (!fromModules.includes(C.SharedModules))
        {
            missing.push(fromStage + C.SharedModules)
        }
        const workspaces = targets.Workspaces(modulesStage)
        if (workspaces === undefined || !targets.OmitsDev(modulesStage))
        {
            missing.push(C.DockerfileInstallPrefix + modulesStage)
        }
        const installed = workspaces ?? []
        const wanted = C.SharedWorkspaces(entry)
        missing.push(...wanted.filter(w => !installed.includes(w)).map(w => C.DockerfileWorkspacePrefix + w))
        extra.push(...installed.filter(w => !wanted.includes(w)).map(w => C.DockerfileWorkspacePrefix + w))
    }

    /** The workspace dirs (relative to pragmatic-shared, e.g. `packages/x`) of the shared packages the entry lists. */
    private static SharedWorkspaces(entry: IClosureEntry): string[]
    {
        const C = ClosureCheck
        return entry.packages.filter(p => p.startsWith(C.SharedPrefix)).map(p => p.slice(C.SharedPrefix.length))
    }

    /**
     * Records the third-party package dir (a pragmatic-shared lock key) a reached file lies in. A file in no node_modules
     * is not third-party: returns the workspace path it stands for (`pragmatic-shared/packages/<x>`, or the file itself
     * outside packages/) so the caller can report it.
     */
    private static NoteSharedPackage(relativePath: string, packages: Set<string>): string | undefined
    {
        const C = ClosureCheck
        const path = relativePath.split(sep).join(C.Slash)
        const dir = SharedLockClosure.PackageDirOf(path)
        if (dir !== undefined)
        {
            packages.add(dir)
            return undefined
        }
        if (!path.startsWith(C.SharedPackagesPrefix))
        {
            return C.SharedPrefix + path
        }
        return C.SharedPrefix + C.SharedPackagesPrefix + path.slice(C.SharedPackagesPrefix.length).split(C.Slash)[0]
    }

    /** The pragmatic-shared packages as sibling dirs (`pragmatic-shared/packages/<x>`), from that workspace's package.json; none without the checkout. */
    public static SharedSiblings(root: string): string[]
    {
        const C = ClosureCheck
        const manifest = join(root, C.SharedDir, C.PackageJson)
        if (!existsSync(manifest))
        {
            return []
        }
        let workspaces: unknown
        try
        {
            workspaces = (JSON.parse(readFileSync(manifest, C.Utf8)) as { workspaces?: unknown }).workspaces
        }
        catch (err)
        {
            throw new ClosureManifestError(C.UnreadableSharedWorkspace + (err as Error).message)
        }
        if (!Array.isArray(workspaces) || !workspaces.every(w => typeof w === 'string'))
        {
            throw new ClosureManifestError(C.UnreadableSharedWorkspace + C.WorkspacesNotList)
        }
        return (workspaces as string[]).map(w => C.SharedPrefix + w)
    }

    /** The reached pragmatic-shared third-party packages a production install of the entry's shared packages does not place. */
    private static UndeclaredShared(root: string, entry: IClosureEntry, reached: Set<string>): string[]
    {
        const C = ClosureCheck
        if (reached.size === 0)
        {
            return []
        }
        const lock = SharedLockClosure.Load(join(root, ...C.SharedLock.split(C.Slash)))
        const placed = lock?.Of(C.SharedWorkspaces(entry)) ?? new Set<string>()
        return [...reached].filter(p => !placed.has(p)).sort().map(p => C.UndeclaredSharedPrefix + C.SharedPrefix + p)
    }

    /** True when the workspace path is one of the entry's `files` or lies inside one. */
    private static Covered(entry: IClosureEntry, path: string): boolean
    {
        return entry.files.some(f => path === f || path.startsWith(f + ClosureCheck.Slash))
    }

    /** The compiled tree (and the source dir it mirrors) a compiled path lies in. */
    private static RootOf(compiled: string): readonly [string, string]
    {
        const root = ClosureCheck.CompiledRoots.find(([prefix]) => compiled.startsWith(prefix))
        if (root === undefined)
        {
            throw new ClosureManifestError(ClosureCheck.BadEntrypointPrefix + compiled)
        }
        return root
    }

    /** The one compiled tree every command of the entry runs from. */
    private static CompiledRootOf(app: string, runs: readonly string[]): readonly [string, string]
    {
        const roots = new Set(runs.map(run => ClosureCheck.RootOf(run)))
        if (roots.size !== 1)
        {
            throw new ClosureManifestError(ClosureCheck.MixedRootsPrefix + app)
        }
        return [...roots][0]
    }

    /** The TypeScript source a compiled entry was emitted from: dist/ mirrors src/, the other trees mirror the repo. */
    private static SourceOf(compiled: string): string
    {
        const C = ClosureCheck
        const [prefix, source] = C.RootOf(compiled)
        return source + compiled.slice(prefix.length).replace(C.JsExtension, C.TsExtension)
    }

    /** The workspace path a server source file compiles to in the given tree; a file the tree does not mirror is named as such. */
    private static CompiledOf(source: string, root: readonly [string, string]): string
    {
        const C = ClosureCheck
        const [prefix, sourceDir] = root
        if (!source.startsWith(sourceDir))
        {
            return C.NotCompiledPrefix + C.ServerDir + C.Slash + source
        }
        return C.ServerDir + C.Slash + prefix + source.slice(sourceDir.length).replace(C.TsSourceExtension, C.JsOutExtension)
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
