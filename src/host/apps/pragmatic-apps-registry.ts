import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { PragmaticAppManifestParser } from './pragmatic-app-manifest.js'
import { PragmaticApplication } from './pragmatic-application.js'

export interface PragmaticAppSummary
{
    name: string
    version: string
}

/** Lists and loads applications from a tenant's `applications/` storage (`<name>/<live version>/application.json`, or the legacy `<name>/application.json`). */
export class PragmaticAppsRegistry
{
    private static readonly ManifestFile = 'application.json'
    private static readonly LivePointerFile = 'live'
    private static readonly RootPath = '.'
    private static readonly Separator = '/'
    private static readonly SeparatorPattern = /[\\/:]/
    private static readonly ControlCharPattern = /[\u0000-\u001f\u007f]/
    private static readonly DotsOnlyPattern = /^\.+$/
    private static readonly EdgeDotOrSpacePattern = /^\.|[. ]$/
    private static readonly ReservedDevicePattern = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
    private static readonly ExtensionSeparator = '.'
    private static readonly InvalidNameError = 'invalid application name: '
    private static readonly NotFoundError = 'application not found: '

    private readonly storage: IStorage

    public constructor(storage: IStorage)
    {
        this.storage = storage
    }

    public async List(): Promise<readonly PragmaticAppSummary[]>
    {
        const entries = await this.storage.List(PragmaticAppsRegistry.RootPath)
        const result: PragmaticAppSummary[] = []
        for (const entry of entries)
        {
            if (!entry.IsDirectory || !await this.storage.Exists(await this.ManifestPath(entry.Name)))
            {
                continue
            }
            const app = await this.ApplicationFor(entry.Name)
            result.push({ name: app.Manifest.name, version: app.Manifest.version })
        }
        return result
    }

    public async ApplicationFor(name: string): Promise<PragmaticApplication>
    {
        PragmaticAppsRegistry.AssertValidName(name)
        const path = await this.ManifestPath(name)
        if (!await this.storage.Exists(path))
        {
            throw new Error(PragmaticAppsRegistry.NotFoundError + name)
        }
        return new PragmaticApplication(PragmaticAppManifestParser.Parse(await this.storage.ReadText(path)))
    }

    /**
     * Rejects names that are empty, dots-only (`.`, `..`, `...`), dot-leading (`.git`), end in a dot or space, are Windows
     * reserved device names (`CON`, `NUL`, `COM1`, ... with or without an extension), contain a path separator, or contain a control / non-printable character (below U+0020, DEL).
     * Shared with the access-policy loader and the app ingest (package ids, versions, every UI path segment).
     */
    public static AssertValidName(name: string): void
    {
        if (name === '' || PragmaticAppsRegistry.DotsOnlyPattern.test(name) || PragmaticAppsRegistry.EdgeDotOrSpacePattern.test(name)
            || PragmaticAppsRegistry.ReservedDevicePattern.test(name.split(PragmaticAppsRegistry.ExtensionSeparator)[0]!) || PragmaticAppsRegistry.SeparatorPattern.test(name)
            || PragmaticAppsRegistry.ControlCharPattern.test(name))
        {
            throw new Error(PragmaticAppsRegistry.InvalidNameError + name)
        }
    }

    /** `<name>/<version>/application.json` when `<name>/live` names a version, else the legacy `<name>/application.json` (also used when the pointer is corrupt). */
    private async ManifestPath(name: string): Promise<string>
    {
        const pointer = name + PragmaticAppsRegistry.Separator + PragmaticAppsRegistry.LivePointerFile
        const legacy = name + PragmaticAppsRegistry.Separator + PragmaticAppsRegistry.ManifestFile
        if (!await this.storage.Exists(pointer))
        {
            return legacy
        }
        let version: string
        try
        {
            version = (await this.storage.ReadText(pointer)).trim()
            PragmaticAppsRegistry.AssertValidName(version)
        }
        catch
        {
            // A corrupt or unreadable pointer must not abort listing: fall back to the legacy manifest (absent => app skipped).
            return legacy
        }
        return name + PragmaticAppsRegistry.Separator + version + PragmaticAppsRegistry.Separator + PragmaticAppsRegistry.ManifestFile
    }
}
