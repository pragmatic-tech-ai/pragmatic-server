import { randomUUID } from 'node:crypto'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { ContributedPackageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticAppsRegistry } from '../apps/pragmatic-apps-registry.js'
import { PackagePath } from './package-path.js'

export class GraphPackageConflictError extends Error
{
    private static readonly ErrorName = 'GraphPackageConflictError'
    private static readonly ConflictMessage = 'a package version is already deployed with different content; versions are immutable'

    public constructor()
    {
        super(GraphPackageConflictError.ConflictMessage)
        this.name = GraphPackageConflictError.ErrorName
    }
}

export class GraphPackageSegmentError extends Error
{
    private static readonly ErrorName = 'GraphPackageSegmentError'
    private static readonly SegmentMessage = 'invalid package id or version segment'

    public constructor()
    {
        super(GraphPackageSegmentError.SegmentMessage)
        this.name = GraphPackageSegmentError.ErrorName
    }
}

interface PlannedPackage
{
    readonly path: string
    readonly bytes: Uint8Array
    skip: boolean
}

/**
 * Writes contributed package bytes into the packages store with immutability and crash-safe staging.
 * MIRRORS AppIngestService's immutability discipline (AssertImmutable + Commit): byte-identical existing
 * versions are skipped, differing bytes are a Conflict, and nothing is written until every package is checked.
 * The two must stay consistent on package bytes. UNLIKE AppIngestService, this does NOT serialize concurrent commits
 * and does NOT recheck existence at commit time (it relies on the Plan-time skip flags), so concurrent contributes to
 * one graph are last-writer-wins. That matches the single-maker dev-env posture; full concurrency hardening is a
 * deferred follow-up.
 */
export class GraphPackageIngest
{
    private static readonly TempPrefix = '.ingest-'
    private static readonly TempSuffix = '.tmp'

    public constructor(private readonly packages: IStorage)
    {
    }

    public async Store(packages: readonly ContributedPackageDto[]): Promise<void>
    {
        const plan = await this.Plan(packages)
        await this.Commit(plan.filter(f => !f.skip))
    }

    /** Validates the whole batch against existing content before anything is written. */
    private async Plan(packages: readonly ContributedPackageDto[]): Promise<PlannedPackage[]>
    {
        for (const pkg of packages)
        {
            GraphPackageIngest.AssertSegment(pkg?.id)
            GraphPackageIngest.AssertSegment(pkg.version)
        }
        const byPath = new Map<string, PlannedPackage>()
        for (const pkg of packages)
        {
            const path = PackagePath.ModelJsonPath(pkg.id, pkg.version)
            const bytes = new TextEncoder().encode(pkg.modelJson)
            const earlier = byPath.get(path)
            if (earlier !== undefined)
            {
                if (Buffer.compare(Buffer.from(earlier.bytes), Buffer.from(bytes)) !== 0)
                {
                    throw new GraphPackageConflictError()
                }
                continue
            }
            const planned: PlannedPackage = { path, bytes, skip: false }
            if (await this.packages.Exists(path))
            {
                const current = await this.packages.ReadBytes(path)
                if (Buffer.compare(Buffer.from(current), Buffer.from(bytes)) !== 0)
                {
                    throw new GraphPackageConflictError()
                }
                planned.skip = true
            }
            byPath.set(path, planned)
        }
        return [...byPath.values()]
    }

    /** Delegates to the shared app-name guard (single source of the path-safety rule) with a package-appropriate error. */
    private static AssertSegment(value: unknown): void
    {
        try
        {
            if (typeof value !== 'string')
            {
                throw new Error()
            }
            PragmaticAppsRegistry.AssertValidName(value)
        }
        catch
        {
            throw new GraphPackageSegmentError()
        }
    }

    private async Commit(files: readonly PlannedPackage[]): Promise<void>
    {
        const suffix = GraphPackageIngest.TempPrefix + randomUUID() + GraphPackageIngest.TempSuffix
        const staged: PlannedPackage[] = []
        const renamed: PlannedPackage[] = []
        try
        {
            for (const file of files)
            {
                staged.push(file)
                await this.packages.WriteBytes(file.path + suffix, file.bytes)
            }
            for (const file of files)
            {
                await this.packages.Rename(file.path + suffix, file.path)
                staged.splice(staged.indexOf(file), 1)
                renamed.push(file)
            }
        }
        catch (error)
        {
            // Best effort. Skipped (pre-existing) files are never in `files`, so only newly created paths are removed.
            for (const file of staged)
            {
                await this.packages.Delete(file.path + suffix).catch(() => undefined)
            }
            for (const file of renamed.reverse())
            {
                await this.packages.Delete(file.path).catch(() => undefined)
            }
            throw error
        }
    }
}
