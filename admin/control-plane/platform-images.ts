import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { ReleaseState, type ManifestRecord, type ManifestRegistry } from './manifest-record.js'
import { ReleaseRegistry, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** Where the platform's own images (the hive agent, the console's tenant-admin and IdP) come from. */
export interface IPlatformImages
{
    /** The image to run for the app; undefined when there is none to offer yet. */
    ImageOf(app: ReleaseApp): string | undefined
}

/** The copy every install path refuses with while no verified, non-withdrawn platform release exists. */
export class PlatformImages
{
    public static readonly NoReleaseMessage = 'no verified platform release yet'

    private constructor()
    {
    }
}

/** A development box: every platform app runs the locally built server image, as before releases existed; the console's Postgres the locally built pragmatic-postgres. */
export class DevPlatformImages implements IPlatformImages
{
    /** The locally built pragmatic-postgres (docker/postgres: `docker build -t pragmatic-postgres:local`, then `kind load`). */
    public static readonly PostgresImage = 'pragmatic-postgres:local'

    public ImageOf(app: ReleaseApp): string | undefined
    {
        return app === ReleaseApp.Postgres ? DevPlatformImages.PostgresImage : K8sManifestBuilder.AgentImage
    }
}

/**
 * The newest verified, non-withdrawn release in the manifest catalogue (by publishedAt), named by digest under the registry
 * host the catalogue was read from. Locally published and rejected records are never offered.
 */
export class ReleasePlatformImages implements IPlatformImages
{
    public constructor(private readonly manifests: ManifestRegistry, private readonly imageHost: string)
    {
    }

    public ImageOf(app: ReleaseApp): string | undefined
    {
        const image = this.NewestWith(app)?.release?.images?.[app]
        return image === undefined ? undefined : ReleaseRegistry.DigestReference(this.imageHost, image.repository, image.digest)
    }

    /** The newest verified, non-withdrawn record that carries an image for the app (a release may predate an app). */
    private NewestWith(app: ReleaseApp): ManifestRecord | undefined
    {
        let newest: ManifestRecord | undefined
        for (const record of this.manifests.List())
        {
            if (record.release?.state !== ReleaseState.Verified || record.withdrawn === true || record.release.images?.[app] === undefined)
            {
                continue
            }
            if (newest === undefined || Date.parse(record.publishedAt) > Date.parse(newest.publishedAt))
            {
                newest = record
            }
        }
        return newest
    }
}
