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
    // True when the path already existed at plan time (identical skip OR differing overwrite). Rollback
    // must never delete a pre-existing path — only paths this call created are removed on a mid-commit failure.
    preexisting: boolean
}

/**
 * Writes contributed package bytes into the packages store with crash-safe staging, DELIBERATELY MUTABLE:
 * a dev graph is a maker's working set, so re-contributing an edited `id@version` OVERWRITES the stored bytes
 * (last-writer-wins) rather than conflicting. Byte-identical bytes are an idempotent no-op; a single id@version
 * appearing twice in ONE batch with differing bytes is still a Conflict (a malformed build, not a re-contribute).
 * This INTENTIONALLY DIVERGES from AppIngestService's per-version immutability: immutability belongs to the
 * runtime/promoted boundary (AppIngestService + promote), not a dev working graph. Nothing is written until every
 * package is checked. UNLIKE AppIngestService, this does NOT serialize concurrent commits and does NOT recheck
 * existence at commit time (it relies on the Plan-time flags), so concurrent contributes to one graph are
 * last-writer-wins. That matches the single-maker dev-env posture; full concurrency hardening is a deferred follow-up.
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
                // Same id@version twice in ONE batch with differing bytes is ambiguous (a malformed build,
                // not a re-contribute), so it stays a hard conflict; an identical duplicate is ignored.
                if (Buffer.compare(Buffer.from(earlier.bytes), Buffer.from(bytes)) !== 0)
                {
                    throw new GraphPackageConflictError()
                }
                continue
            }
            const planned: PlannedPackage = { path, bytes, skip: false, preexisting: false }
            if (await this.packages.Exists(path))
            {
                planned.preexisting = true
                const current = await this.packages.ReadBytes(path)
                // Identical bytes → idempotent no-op; differing bytes → overwrite the stored version
                // (dev working-graph last-writer-wins). Either way the path already exists, so rollback leaves it.
                planned.skip = Buffer.compare(Buffer.from(current), Buffer.from(bytes)) === 0
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
            // Best effort. Remove the un-renamed temps, then remove only the paths this call CREATED —
            // a pre-existing path we overwrote is left with its new bytes rather than deleted, so a failed
            // batch never destroys a version that existed before the contribute.
            for (const file of staged)
            {
                await this.packages.Delete(file.path + suffix).catch(() => undefined)
            }
            for (const file of renamed.reverse())
            {
                if (!file.preexisting)
                {
                    await this.packages.Delete(file.path).catch(() => undefined)
                }
            }
            throw error
        }
    }
}
