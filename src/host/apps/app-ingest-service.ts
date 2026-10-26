import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { randomUUID } from 'node:crypto'
import { AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppDeployResultDto, CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticAppsRegistry } from './pragmatic-apps-registry.js'
import { NullLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'

/** Evicts a cached app graph keyed `name@version`; implemented by the server that owns the cache. */
export interface IAppCacheInvalidator
{
    InvalidateApp(nameAtVersion: string): void
}

/** A client-supplied value failed validation; the message is secret-free and safe to return. */
class IngestRejection extends Error
{
    public readonly Status: AppWriteStatus

    public constructor(status: AppWriteStatus, message: string)
    {
        super(message)
        this.Status = status
    }
}

interface PlannedFile
{
    storage: IStorage
    path: string
    bytes: Uint8Array
    /** Already present with identical content: nothing to write. */
    skip?: boolean
}

interface IngestPlan
{
    files: PlannedFile[]
    marker: PlannedFile
}

/**
 * Ingests a published remote application onto a runtime tenant. The storages are bound to the per-tenant
 * `PragmaticServer`, so ingest is already tenant-scoped. Everything is validated before the first byte is written;
 * an already-present `name@version` is refused (versions are immutable), package and UI files are staged under
 * unique temp names and renamed into place, and `application.json` is renamed in LAST as the commit marker, so a
 * version tree is never treated as complete while half-ingested. The `<app>/live` pointer, written after the tree, is the app-level
 * gate: until it names a version the app serves the previous one. A hard crash mid-commit can still leave
 * non-servable orphan files (no `application.json` in the version tree means the version is incomplete and never
 * made live). A same-version retry whose tree is complete but whose pointer is not yet written only rewrites the pointer.
 * Concurrent ingests of one app are serialized per app (the lock does NOT serialize shared-package writes across DIFFERENT apps: a pathological
 * cross-app race on the same package id@version is acceptable for SP0). Client paths are never trusted.
 *
 * Layout: UI assets and application.json are version-scoped (`<app>/<version>/ui/...`, `<app>/<version>/application.json`),
 * so a new version never touches an earlier tree. After the version tree is committed, the small pointer file
 * `<app>/live` (the version string) is overwritten: that write is the atomic app-level switch. Request size is bounded by the wire frame limit (acceptable for SP0).
 */
export class AppIngestService
{
    private static readonly ManifestFile = 'application.json'
    private static readonly ModelFile = 'model.json'
    private static readonly UiDir = 'ui'
    private static readonly LivePointerFile = 'live'
    private static readonly ReservedVersions: ReadonlySet<string> = new Set(['live', 'ui', 'application.json'])
    private static readonly ReservedVersionMessage = 'this application version name is reserved'
    private static readonly Separator = '/'
    private static readonly TempPrefix = '.ingest-'
    private static readonly TempSuffix = '.tmp'
    private static readonly KeySeparator = '@'
    private static readonly Base64Encoding = 'base64'
    // A linear char-class scan plus a group-size check: canonical base64 only, with padding solely at the end. The
    // earlier grouped-quantifier form ((?:...){4})* overflowed the regex stack (RangeError) on multi-megabyte assets.
    private static readonly Base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/
    private static readonly Base64GroupSize = 4
    private static readonly UnsafeSegmentPattern = /[\\:\0]/
    private static readonly MalformedMessage = 'deploy request is malformed'
    private static readonly NameMismatchMessage = 'manifest name/version does not match the deploy request'
    private static readonly UnsafeNameMessage = 'application name or version is not a safe path segment'
    private static readonly UnsafePackageMessage = 'a package id or version is not a safe path segment'
    private static readonly UnsafePathMessage = 'a UI bundle path is not a safe relative path'
    private static readonly BadModelMessage = 'a package model is not a valid package document'
    private static readonly BadBase64Message = 'a UI bundle file is not valid base64'
    private static readonly DuplicatePackageMessage = 'a package id and version is supplied more than once'
    private static readonly DuplicatePathMessage = 'a UI bundle path is supplied more than once'
    private static readonly ClosureMessage = 'package closure is incomplete; missing: '
    private static readonly EntryMessage = 'the UI entry file is not part of the UI bundle'
    private static readonly AssetMessage = 'a manifest UI asset is not part of the UI bundle'
    private static readonly WriteFailedMessage = 'the application could not be written'
    private static readonly ListSeparator = ', '
    private static readonly VersionExistsMessage = 'this application version is already deployed; versions are immutable'
    private static readonly PackageDiffersMessage = 'a package version is already deployed with different content; versions are immutable'
    private static readonly InvalidateFailedLine = 'app cache invalidation failed after a successful deploy'
    private static readonly WriteFailedLine = 'app ingest write failed'
    private static readonly ErrorClassField = 'errorClass'
    private static readonly ErrorCodeField = 'errorCode'
    private static readonly UnknownClass = 'unknown'

    private readonly packages: IStorage
    private readonly applications: IStorage
    private readonly invalidator: IAppCacheInvalidator
    private readonly logger: ILogger
    private readonly locks = new Map<string, Promise<unknown>>()

    public constructor(packages: IStorage, applications: IStorage, invalidator: IAppCacheInvalidator, logger: ILogger = new NullLogger())
    {
        this.logger = logger
        this.packages = packages
        this.applications = applications
        this.invalidator = invalidator
    }

    public async Ingest(params: CypherAppDeployParamsDto): Promise<AppDeployResultDto>
    {
        const appName = typeof params?.appName === 'string' ? params.appName : ''
        const appVersion = typeof params?.appVersion === 'string' ? params.appVersion : ''
        let plan: IngestPlan
        try
        {
            plan = this.Validate(params)
        }
        catch (error)
        {
            return this.Failure(error, appName, appVersion)
        }
        return this.Serialized(appName, async () =>
        {
            try
            {
                const resume = await this.AssertImmutable(plan, params)
                if (!resume)
                {
                    await this.Commit(plan)
                }
                // The final commit point: the whole version tree is in place, so atomically repoint the app at it.
                await this.applications.WriteText([appName, AppIngestService.LivePointerFile].join(AppIngestService.Separator), appVersion)
            }
            catch (error)
            {
                return this.Failure(error, appName, appVersion)
            }
            // The deploy has landed: an eviction failure must not turn it into a Failed result.
            try
            {
                this.invalidator.InvalidateApp(appName + AppIngestService.KeySeparator + appVersion)
            }
            catch (error)
            {
                this.logger.Warn(AppIngestService.InvalidateFailedLine, AppIngestService.ErrorFields(error))
            }
            return { status: AppWriteStatus.Applied, appName, appVersion }
        })
    }

    private Failure(error: unknown, appName: string, appVersion: string): AppDeployResultDto
    {
        const rejected = error instanceof IngestRejection
        if (!rejected)
        {
            // Class/code only: never the message (may embed paths) or any payload bytes.
            this.logger.Error(AppIngestService.WriteFailedLine, AppIngestService.ErrorFields(error))
        }
        return {
            status: rejected ? error.Status : AppWriteStatus.Failed,
            reason: rejected ? error.message : AppIngestService.WriteFailedMessage,
            appName,
            appVersion,
        }
    }

    private static ErrorFields(error: unknown): Record<string, unknown>
    {
        const code = (error as { code?: unknown } | null)?.code
        return {
            [AppIngestService.ErrorClassField]: error instanceof Error ? error.constructor.name : AppIngestService.UnknownClass,
            [AppIngestService.ErrorCodeField]: typeof code === 'string' || typeof code === 'number' ? code : undefined,
        }
    }

    /** Runs `section` after any in-flight ingest of the same app finishes (per-app in-memory lock). */
    private async Serialized<T>(appName: string, section: () => Promise<T>): Promise<T>
    {
        const previous = this.locks.get(appName) ?? Promise.resolve()
        const run = previous.then(section, section)
        const tail = run.catch(() => undefined)
        this.locks.set(appName, tail)
        try
        {
            return await run
        }
        finally
        {
            if (this.locks.get(appName) === tail)
            {
                this.locks.delete(appName)
            }
        }
    }

    /** Versions are immutable: refuse an already-deployed name@version and a package version whose content differs. */
    private async AssertImmutable(plan: IngestPlan, params: CypherAppDeployParamsDto): Promise<boolean>
    {
        if (await this.applications.Exists(plan.marker.path))
        {
            let existing: unknown
            try
            {
                existing = JSON.parse(await this.applications.ReadText(plan.marker.path))
            }
            catch
            {
                existing = undefined
            }
            if ((existing as { version?: unknown } | undefined)?.version === params.appVersion)
            {
                // The marker is renamed in last, so the tree is complete. If the pointer does not yet name this version, a
                // previous deploy failed at the pointer write: resume by only (re)writing the pointer. Else it is live: Conflict.
                if (await this.LiveVersion(params.appName) === params.appVersion)
                {
                    throw new IngestRejection(AppWriteStatus.Conflict, AppIngestService.VersionExistsMessage)
                }
                // Immutability: a resume is only an idempotent redeploy of byte-identical content, never a silent replacement.
                if (!await this.MatchesStored(plan))
                {
                    throw new IngestRejection(AppWriteStatus.Conflict, AppIngestService.VersionExistsMessage)
                }
                return true
            }
        }
        for (const file of plan.files)
        {
            if (file.storage === this.packages && await this.packages.Exists(file.path))
            {
                const current = await this.packages.ReadBytes(file.path)
                if (Buffer.compare(Buffer.from(current), Buffer.from(file.bytes)) !== 0)
                {
                    throw new IngestRejection(AppWriteStatus.Conflict, AppIngestService.PackageDiffersMessage)
                }
                file.skip = true
            }
        }
        return false
    }

    /** True when the marker and every UI file of the plan are byte-identical to what is stored for this version. */
    private async MatchesStored(plan: IngestPlan): Promise<boolean>
    {
        for (const file of [plan.marker, ...plan.files.filter(f => f.storage === this.applications)])
        {
            if (!await this.applications.Exists(file.path)
                || Buffer.compare(Buffer.from(await this.applications.ReadBytes(file.path)), Buffer.from(file.bytes)) !== 0)
            {
                return false
            }
        }
        return true
    }

    /** The version `<app>/live` names, or undefined when the pointer is absent or unreadable. */
    private async LiveVersion(appName: string): Promise<string | undefined>
    {
        const pointer = [appName, AppIngestService.LivePointerFile].join(AppIngestService.Separator)
        try
        {
            return await this.applications.Exists(pointer) ? (await this.applications.ReadText(pointer)).trim() : undefined
        }
        catch
        {
            return undefined
        }
    }

    private Validate(params: CypherAppDeployParamsDto): IngestPlan
    {
        if (params === null || typeof params !== 'object' || !Array.isArray(params.packages) || !Array.isArray(params.uiBundle)
            || params.manifest === null || typeof params.manifest !== 'object' || !Array.isArray(params.manifest.packages))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.MalformedMessage)
        }
        const manifest = params.manifest
        AppIngestService.AssertSegment(params.appName, AppIngestService.UnsafeNameMessage)
        AppIngestService.AssertSegment(params.appVersion, AppIngestService.UnsafeNameMessage)
        if (AppIngestService.ReservedVersions.has(params.appVersion))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.ReservedVersionMessage)
        }
        if (manifest.name !== params.appName || manifest.version !== params.appVersion)
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.NameMismatchMessage)
        }
        const files: PlannedFile[] = []
        const supplied = new Set<string>()
        const required = new Set<string>()
        for (const pkg of params.packages)
        {
            AppIngestService.AssertSegment(pkg?.id, AppIngestService.UnsafePackageMessage)
            AppIngestService.AssertSegment(pkg.version, AppIngestService.UnsafePackageMessage)
            const key = AppIngestService.PackageKey(pkg.id, pkg.version)
            if (supplied.has(key))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.DuplicatePackageMessage)
            }
            supplied.add(key)
            for (const dependency of AppIngestService.DependenciesOf(pkg.modelJson))
            {
                required.add(AppIngestService.PackageKey(dependency.id, dependency.version))
            }
            files.push({ storage: this.packages, path: [pkg.id, pkg.version, AppIngestService.ModelFile].join(AppIngestService.Separator), bytes: new TextEncoder().encode(pkg.modelJson) })
        }
        for (const ref of manifest.packages)
        {
            AppIngestService.AssertSegment(ref?.id, AppIngestService.UnsafePackageMessage)
            AppIngestService.AssertSegment(ref.version, AppIngestService.UnsafePackageMessage)
            required.add(AppIngestService.PackageKey(ref.id, ref.version))
        }
        const missing = [...required].filter(key => !supplied.has(key)).sort()
        if (missing.length > 0)
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.ClosureMessage + missing.join(AppIngestService.ListSeparator))
        }
        const uiPaths = new Set<string>()
        for (const asset of params.uiBundle)
        {
            const path = AppIngestService.SafeRelativePath(asset?.path)
            if (typeof asset.contentBase64 !== 'string' || asset.contentBase64 === '' || asset.contentBase64.length % AppIngestService.Base64GroupSize !== 0 || !AppIngestService.Base64Pattern.test(asset.contentBase64))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.BadBase64Message)
            }
            if (uiPaths.has(path))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.DuplicatePathMessage)
            }
            uiPaths.add(path)
            files.push({ storage: this.applications, path: [params.appName, params.appVersion, AppIngestService.UiDir, path].join(AppIngestService.Separator), bytes: Buffer.from(asset.contentBase64, AppIngestService.Base64Encoding) })
        }
        const projection: Record<string, unknown> = {
            name: manifest.name,
            version: manifest.version,
            packages: manifest.packages.map(ref => ({ id: ref.id, version: ref.version })),
        }
        if (manifest.ui !== undefined && manifest.ui !== null)
        {
            if (!uiPaths.has(AppIngestService.SafeRelativePath(manifest.ui.entry)))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.EntryMessage)
            }
            const assets = (Array.isArray(manifest.ui.assets) ? manifest.ui.assets : []).map(asset => AppIngestService.SafeRelativePath(asset))
            if (assets.some(asset => !uiPaths.has(asset)))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.AssetMessage)
            }
            projection.ui = { entry: manifest.ui.entry, assets }
        }
        const marker: PlannedFile = {
            storage: this.applications,
            path: [params.appName, params.appVersion, AppIngestService.ManifestFile].join(AppIngestService.Separator),
            bytes: new TextEncoder().encode(JSON.stringify(projection)),
        }
        return { files, marker }
    }

    private async Commit(plan: IngestPlan): Promise<void>
    {
        const ordered = [...plan.files.filter(f => f.skip !== true), plan.marker]
        const suffix = AppIngestService.TempPrefix + randomUUID() + AppIngestService.TempSuffix
        const staged: PlannedFile[] = []
        const renamed: PlannedFile[] = []
        // Only paths this commit newly creates may be removed on failure; a pre-existing file is never deleted.
        const preExisting = new Set<PlannedFile>()
        for (const file of ordered)
        {
            if (await file.storage.Exists(file.path))
            {
                preExisting.add(file)
            }
        }
        try
        {
            for (const file of ordered)
            {
                staged.push(file)
                await file.storage.WriteBytes(file.path + suffix, file.bytes)
            }
            for (const file of ordered)
            {
                await file.storage.Rename(file.path + suffix, file.path)
                staged.splice(staged.indexOf(file), 1)
                renamed.push(file)
            }
        }
        catch (error)
        {
            // Best effort: drop leftover temps and files this commit newly created (never pre-existing ones).
            for (const file of staged)
            {
                await file.storage.Delete(file.path + suffix).catch(() => undefined)
            }
            for (const file of renamed.reverse())
            {
                if (!preExisting.has(file))
                {
                    await file.storage.Delete(file.path).catch(() => undefined)
                }
            }
            throw error
        }
    }

    private static PackageKey(id: string, version: string): string
    {
        return id + AppIngestService.KeySeparator + version
    }

    /** One safe path segment: reuses the registry's name guard and also refuses drive letters, NULs and absolute forms. */
    private static AssertSegment(value: unknown, message: string): asserts value is string
    {
        let safe = typeof value === 'string' && !AppIngestService.UnsafeSegmentPattern.test(value)
        if (safe)
        {
            try
            {
                PragmaticAppsRegistry.AssertValidName(value as string)
            }
            catch
            {
                safe = false
            }
        }
        if (!safe)
        {
            throw new IngestRejection(AppWriteStatus.Invalid, message)
        }
    }

    /** A relative, forward-slash path whose every segment is a safe name; refuses `..`, absolute, drive-letter and backslash forms. */
    private static SafeRelativePath(value: unknown): string
    {
        if (typeof value !== 'string' || value === '' || value.startsWith(AppIngestService.Separator) || AppIngestService.UnsafeSegmentPattern.test(value))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.UnsafePathMessage)
        }
        for (const segment of value.split(AppIngestService.Separator))
        {
            AppIngestService.AssertSegment(segment, AppIngestService.UnsafePathMessage)
        }
        return value
    }

    private static DependenciesOf(modelJson: unknown): readonly { id: string; version: string }[]
    {
        let document: unknown
        try
        {
            document = typeof modelJson === 'string' ? JSON.parse(modelJson) : undefined
        }
        catch
        {
            document = undefined
        }
        if (document === null || typeof document !== 'object' || Array.isArray(document))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.BadModelMessage)
        }
        const dependencies = (document as { dependencies?: unknown }).dependencies
        if (dependencies === undefined)
        {
            return []
        }
        if (!Array.isArray(dependencies))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.BadModelMessage)
        }
        for (const d of dependencies)
        {
            AppIngestService.AssertSegment(d?.id, AppIngestService.UnsafePackageMessage)
            AppIngestService.AssertSegment(d.version, AppIngestService.UnsafePackageMessage)
        }
        return dependencies as { id: string; version: string }[]
    }
}
