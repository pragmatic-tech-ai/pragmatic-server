import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { PragmaticAppManifestParser } from './pragmatic-app-manifest.js'
import { PragmaticApplication } from './pragmatic-application.js'

export interface PragmaticAppSummary
{
    name: string
    version: string
}

/** Lists and loads applications from a tenant's `applications/` storage (`<name>/application.json`). */
export class PragmaticAppsRegistry
{
    private static readonly ManifestFile = 'application.json'
    private static readonly RootPath = '.'
    private static readonly Separator = '/'
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
            if (!entry.IsDirectory || !await this.storage.Exists(PragmaticAppsRegistry.ManifestPath(entry.Name)))
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
        const path = PragmaticAppsRegistry.ManifestPath(name)
        if (!await this.storage.Exists(path))
        {
            throw new Error(PragmaticAppsRegistry.NotFoundError + name)
        }
        return new PragmaticApplication(PragmaticAppManifestParser.Parse(await this.storage.ReadText(path)))
    }

    private static ManifestPath(name: string): string
    {
        return name + PragmaticAppsRegistry.Separator + PragmaticAppsRegistry.ManifestFile
    }
}
