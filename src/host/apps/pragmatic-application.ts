import type { PragmaticAppManifest } from './pragmatic-app-manifest.js'

export class PragmaticApplication
{
    public readonly Manifest: PragmaticAppManifest

    public constructor(manifest: PragmaticAppManifest)
    {
        this.Manifest = manifest
    }
}
