import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { Tenant } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppDeployResultDto, CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticAppsRegistry } from './pragmatic-apps-registry.js'

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
}

interface IngestPlan
{
    files: PlannedFile[]
    marker: PlannedFile
}

/**
 * Ingests a published remote application onto a runtime tenant. Everything is validated before the first byte is
 * written; package and UI files go in first (each via temp file + rename) and `application.json` is renamed in LAST
 * as the commit marker, so a half-ingested app is never listed or loadable. Client paths are never trusted.
 */
export class AppIngestService
{
    private static readonly ManifestFile = 'application.json'
    private static readonly ModelFile = 'model.json'
    private static readonly UiDir = 'ui'
    private static readonly Separator = '/'
    private static readonly TempSuffix = '.ingest-tmp'
    private static readonly KeySeparator = '@'
    private static readonly Base64Encoding = 'base64'
    private static readonly Base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
    private static readonly UnsafeSegmentPattern = /[\\:\0]/
    private static readonly CurrentSegment = '.'
    private static readonly ParentSegment = '..'
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
    private static readonly WriteFailedMessage = 'the application could not be written'
    private static readonly ListSeparator = ', '

    private readonly packages: IStorage
    private readonly applications: IStorage
    private readonly invalidator: IAppCacheInvalidator

    public constructor(packages: IStorage, applications: IStorage, invalidator: IAppCacheInvalidator)
    {
        this.packages = packages
        this.applications = applications
        this.invalidator = invalidator
    }

    public async Ingest(_tenant: Tenant, params: CypherAppDeployParamsDto): Promise<AppDeployResultDto>
    {
        const appName = typeof params?.appName === 'string' ? params.appName : ''
        const appVersion = typeof params?.appVersion === 'string' ? params.appVersion : ''
        try
        {
            const plan = this.Validate(params)
            await this.Commit(plan)
            this.invalidator.InvalidateApp(appName + AppIngestService.KeySeparator + appVersion)
            return { status: AppWriteStatus.Applied, appName, appVersion }
        }
        catch (error)
        {
            const rejected = error instanceof IngestRejection
            return {
                status: rejected ? error.Status : AppWriteStatus.Failed,
                reason: rejected ? error.message : AppIngestService.WriteFailedMessage,
                appName,
                appVersion,
            }
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
            if (typeof asset.contentBase64 !== 'string' || !AppIngestService.Base64Pattern.test(asset.contentBase64))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.BadBase64Message)
            }
            if (uiPaths.has(path))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.DuplicatePathMessage)
            }
            uiPaths.add(path)
            files.push({ storage: this.applications, path: [params.appName, AppIngestService.UiDir, path].join(AppIngestService.Separator), bytes: Buffer.from(asset.contentBase64, AppIngestService.Base64Encoding) })
        }
        if (manifest.ui !== undefined && manifest.ui !== null && !uiPaths.has(AppIngestService.SafeRelativePath(manifest.ui.entry)))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.EntryMessage)
        }
        const marker: PlannedFile = {
            storage: this.applications,
            path: params.appName + AppIngestService.Separator + AppIngestService.ManifestFile,
            bytes: new TextEncoder().encode(JSON.stringify(manifest)),
        }
        return { files, marker }
    }

    private async Commit(plan: IngestPlan): Promise<void>
    {
        const ordered = [...plan.files, plan.marker]
        const staged: PlannedFile[] = []
        try
        {
            for (const file of ordered)
            {
                staged.push(file)
                await file.storage.WriteBytes(file.path + AppIngestService.TempSuffix, file.bytes)
            }
            for (const file of ordered)
            {
                await file.storage.Rename(file.path + AppIngestService.TempSuffix, file.path)
                staged.splice(staged.indexOf(file), 1)
            }
        }
        catch (error)
        {
            for (const file of staged)
            {
                await file.storage.Delete(file.path + AppIngestService.TempSuffix).catch(() => undefined)
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
            if (segment === '' || segment === AppIngestService.CurrentSegment || segment === AppIngestService.ParentSegment)
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.UnsafePathMessage)
            }
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
