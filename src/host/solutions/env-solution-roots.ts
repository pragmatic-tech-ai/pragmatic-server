import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionManifest, SolutionMember } from '@pragmatic-tech-ai/todl'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import type { IEnvSolutionSource } from './composed-solution-loader.js'

/** Raised when a solution name could address a path outside its own subdirectory of the env source area. */
export class InvalidSolutionNameError extends Error
{
    private static readonly Prefix = 'Invalid solution name: '
    private static readonly ErrorName = 'InvalidSolutionNameError'

    public constructor(name: string)
    {
        super(InvalidSolutionNameError.Prefix + JSON.stringify(name))
        this.name = InvalidSolutionNameError.ErrorName
    }
}

/** Raised by {@link EnvSolutionRoots.RootFor} for a well-formed name that has no root (use EnsureRoot to create one). */
export class UnknownSolutionRootError extends Error
{
    private static readonly Prefix = 'No source root for solution: '
    private static readonly ErrorName = 'UnknownSolutionRootError'

    public constructor(name: string)
    {
        super(UnknownSolutionRootError.Prefix + name)
        this.name = UnknownSolutionRootError.ErrorName
    }
}

/**
 * The environment's per-named-solution source roots: one subdirectory per solution name under the env source area
 * (`<area>/<name>/`). Also the {@link IEnvSolutionSource} the composed loader reads.
 *
 * The known-name set and the member cache are synchronous views (the source contract is sync, IStorage is async):
 * they are filled by {@link EnsureRoot} and by the async {@link Refresh}, which scans the area for solution folders.
 * `RootFor` throws {@link UnknownSolutionRootError} for a name not yet known; `EnsureRoot` registers it (the directory
 * itself materialises on the first write). Members are parsed read-only from the manifest; no solution is opened/activated.
 */
export class EnvSolutionRoots implements IEnvSolutionSource
{
    private static readonly Separator = '/'
    private static readonly ManifestSuffix = '.pksln'
    private static readonly EmptyPath = ''
    private static readonly ForbiddenNamePattern = /[\\/:\u0000-\u001f\u007f]|\.\./
    private static readonly ControlOrColonPattern = /[:\u0000-\u001f\u007f]/
    private static readonly ReservedDeviceNamePattern = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
    private static readonly NotFoundPattern = /ENOENT|ENOTDIR/
    private static readonly CurrentSegment = '.'
    private static readonly ParentSegment = '..'
    private static readonly TrailingUnsafePattern = /[. ]$/
    private static readonly SegmentSplit = /[\\/]+/

    public readonly Changed = new Signal<void>()
    private readonly roots = new Map<string, IStorage>()
    private readonly members = new Map<string, readonly SolutionMember[]>()
    private readonly signatures = new Map<string, string>()
    /** Names last seen on disk by Refresh; only these are pruned when they vanish (an EnsureRoot-ed name not yet written is kept). */
    private readonly discovered = new Set<string>()

    public constructor(private readonly area: string, private readonly registry: IStorageProviderRegistry)
    {
    }

    /** The existing root for a known solution; throws for an invalid or unknown name. */
    public RootFor(solutionName: string): IStorage
    {
        EnvSolutionRoots.Validate(solutionName)
        const root = this.roots.get(solutionName)
        if (root === undefined)
        {
            throw new UnknownSolutionRootError(solutionName)
        }
        return root
    }

    /** The root for `solutionName`, registering it when new (fires Changed). */
    public EnsureRoot(solutionName: string): IStorage
    {
        EnvSolutionRoots.Validate(solutionName)
        const existing = this.roots.get(solutionName)
        if (existing !== undefined)
        {
            return existing
        }
        const root = this.registry.CreateStorage(this.LocationOf(solutionName))
        this.roots.set(solutionName, root)
        this.Changed.emit()
        return root
    }

    public Names(): readonly string[]
    {
        return [...this.roots.keys()]
    }

    /** The cached members parsed from the solution's manifest at the last Refresh; empty when unknown. */
    public MembersOf(name: string): readonly SolutionMember[]
    {
        return this.members.get(name) ?? []
    }

    /** Scans the source area for solution folders and re-reads each manifest; fires Changed when names or members changed. */
    public async Refresh(): Promise<void>
    {
        let changed = false
        const entries = await this.registry.CreateStorage(this.area).List(EnvSolutionRoots.EmptyPath)
        const present = new Set<string>()
        for (const entry of entries)
        {
            if (!entry.IsDirectory || !EnvSolutionRoots.IsValid(entry.Name))
            {
                continue
            }
            present.add(entry.Name)
            this.discovered.add(entry.Name)
            const isNew = !this.roots.has(entry.Name)
            const root = this.roots.get(entry.Name) ?? this.registry.CreateStorage(this.LocationOf(entry.Name))
            this.roots.set(entry.Name, root)
            const membersChanged = await this.ReadMembers(entry.Name, root)
            changed = changed || isNew || membersChanged
        }
        for (const name of [...this.discovered])
        {
            if (!present.has(name))
            {
                this.discovered.delete(name)
                this.roots.delete(name)
                this.members.delete(name)
                this.signatures.delete(name)
                changed = true
            }
        }
        if (changed)
        {
            this.Changed.emit()
        }
    }

    /** Parses `<name>.pksln` into members (read-only); returns whether the member set differs from the cached one. */
    private async ReadMembers(name: string, root: IStorage): Promise<boolean>
    {
        const list = await root.List(EnvSolutionRoots.EmptyPath)
        const file = list.find(e => !e.IsDirectory && e.Name.endsWith(EnvSolutionRoots.ManifestSuffix))
        let refs: { path: string, type: string }[] = []
        if (file !== undefined)
        {
            const text = await EnvSolutionRoots.ReadIfPresent(root, file.Name)
            if (text !== undefined)
            {
                refs = EnvSolutionRoots.ParseConfinedMembers(text)
            }
        }
        const signature = JSON.stringify(refs)
        if (this.signatures.get(name) === signature)
        {
            return false
        }
        this.signatures.set(name, signature)
        this.members.set(name, refs.map(ref =>
        {
            const member = new SolutionMember(ref)
            member.Storage = this.registry.CreateStorage(this.LocationOf(name) + EnvSolutionRoots.Separator + ref.path)
            return member
        }))
        return true
    }

    private LocationOf(name: string): string
    {
        return this.area + EnvSolutionRoots.Separator + name
    }

    /** The file's text, or undefined when it vanished (not-found); any other I/O error propagates rather than looking like an empty solution. */
    private static async ReadIfPresent(root: IStorage, file: string): Promise<string | undefined>
    {
        try
        {
            return await root.ReadText(file)
        }
        catch (error)
        {
            if (EnvSolutionRoots.NotFoundPattern.test(String(error)))
            {
                return undefined
            }
            throw error
        }
    }

    /** Members of a manifest, confined; a malformed manifest (deterministic bad content, not I/O) yields none. */
    private static ParseConfinedMembers(text: string): { path: string, type: string }[]
    {
        try
        {
            return SolutionManifest.parse(text).members.filter(m => EnvSolutionRoots.IsConfinedPath(m.path))
        }
        catch
        {
            return []
        }
    }

    /** A manifest member path must be relative and never climb out of its solution folder. */
    private static IsConfinedPath(path: string): boolean
    {
        if (typeof path !== 'string' || path === EnvSolutionRoots.EmptyPath || EnvSolutionRoots.ControlOrColonPattern.test(path))
        {
            return false
        }
        const segments = path.split(EnvSolutionRoots.SegmentSplit)
        if (segments[0] === EnvSolutionRoots.EmptyPath)
        {
            return false
        }
        return segments.every(s => s !== EnvSolutionRoots.ParentSegment && s !== EnvSolutionRoots.CurrentSegment)
    }

    private static IsValid(name: string): boolean
    {
        return typeof name === 'string'
            && name.trim() === name
            && name !== EnvSolutionRoots.EmptyPath
            && name !== EnvSolutionRoots.CurrentSegment
            && !EnvSolutionRoots.ForbiddenNamePattern.test(name)
            && !EnvSolutionRoots.TrailingUnsafePattern.test(name)
            && !EnvSolutionRoots.ReservedDeviceNamePattern.test(name)
    }

    private static Validate(name: string): void
    {
        if (!EnvSolutionRoots.IsValid(name))
        {
            throw new InvalidSolutionNameError(String(name))
        }
    }
}
