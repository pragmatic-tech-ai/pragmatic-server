import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { OciRegistryClient } from './oci-registry-client.js'
import { UiArtifact, type UiBundleFile } from './ui-artifact.js'
import type { UiArtifactVerifier } from './ui-artifact-signer.js'

export type UiUnpackInput =
{
    repo: string
    artifactTag: string
    sigTag: string
    expectedManifestDigest: string
    appName: string
    appVersion: string
    trustRootRef: string
}

/** A material-free failure pulling, verifying or unpacking a UI artifact; the message is fixed and never echoes input. */
export class UiUnpackError extends Error
{
    public static readonly SafeMessage = 'ui artifact unpack failed'
    private static readonly ErrorName = 'UiUnpackError'

    public constructor()
    {
        super(UiUnpackError.SafeMessage)
        this.name = UiUnpackError.ErrorName
    }
}

interface UiPackageRef
{
    id: string
    version: string
}

/**
 * Pod-side reconcile: pulls the UI artifact, digest-pins and signature-verifies it, and only then writes the Spec-2 version tree
 * (`<app>/<version>/ui/...`, `<app>/<version>/application.json`) followed by the `<app>/live` pointer (the commit point).
 */
export class UiUnpacker
{
    private static readonly Separator = '/'
    private static readonly LiveFile = 'live'
    private static readonly ManifestFile = 'application.json'
    private static readonly UiDir = 'ui'
    private static readonly JsonIndent = 2
    private static readonly UnsafeSegment = /[\\:\0]/
    private static readonly CurrentDir = '.'
    private static readonly ParentDir = '..'

    public constructor(
        private readonly client: OciRegistryClient,
        private readonly verifier: UiArtifactVerifier,
        private readonly storage: IStorage,
    )
    {
    }

    public async Reconcile(input: UiUnpackInput): Promise<void>
    {
        try
        {
            await this.ReconcileCore(input)
        }
        catch (error)
        {
            throw error instanceof UiUnpackError ? error : new UiUnpackError()
        }
    }

    /** Verify fully (digest pin, then signature) before the first write; the live pointer is written last. */
    private async ReconcileCore(input: UiUnpackInput): Promise<void>
    {
        const S = UiUnpacker
        if (!S.IsSafeSegment(input.appName) || !S.IsSafeSegment(input.appVersion))
        {
            throw new UiUnpackError()
        }
        const treeRoot = S.Join(input.appName, input.appVersion)
        const manifestPath = S.Join(treeRoot, S.ManifestFile)
        const livePath = S.Join(input.appName, S.LiveFile)
        if (await this.ReadLive(livePath) === input.appVersion && await this.storage.Exists(manifestPath))
        {
            return
        }

        const manifestBytes = await this.client.PullManifest(input.repo, input.artifactTag)
        if (UiArtifact.ManifestDigestOf(manifestBytes) !== input.expectedManifestDigest)
        {
            throw new UiUnpackError()
        }
        const manifest = S.ParseJson(manifestBytes)
        const configDigest = S.DescriptorDigest(manifest.config)
        const layerDigest = S.SingleLayerDigest(manifest)

        const sigManifest = S.ParseJson(await this.client.PullManifest(input.repo, input.sigTag))
        const sigBlob = await this.client.PullBlob(input.repo, S.SingleLayerDigest(sigManifest))
        const signature = new TextDecoder().decode(sigBlob).trim()
        await this.verifier.Verify(input.appName, input.appVersion, input.expectedManifestDigest, signature, input.trustRootRef)

        // Verified. Fetch and fully validate everything before the first write.
        const files = UiArtifact.Unpack(await this.client.PullBlob(input.repo, layerDigest))
        for (const f of files)
        {
            if (!S.IsSafeRelativePath(f.path))
            {
                throw new UiUnpackError()
            }
        }
        const config = S.ParseJson(await this.client.PullBlob(input.repo, configDigest))
        const entry = config.entry
        const assets = config.assets
        if (typeof entry !== 'string' || !Array.isArray(assets) || assets.some(a => typeof a !== 'string'))
        {
            throw new UiUnpackError()
        }
        const packages = await this.ExistingPackages(input.appName, livePath)

        await this.WriteFiles(S.Join(treeRoot, S.UiDir), files)
        const appManifest = { name: input.appName, version: input.appVersion, packages, ui: { entry, assets } }
        await this.storage.WriteText(manifestPath, JSON.stringify(appManifest, null, S.JsonIndent))
        await this.storage.WriteText(livePath, input.appVersion)
    }

    private async WriteFiles(uiRoot: string, files: readonly UiBundleFile[]): Promise<void>
    {
        for (const f of files)
        {
            await this.storage.WriteBytes(UiUnpacker.Join(uiRoot, f.path), f.bytes)
        }
    }

    private async ReadLive(livePath: string): Promise<string | undefined>
    {
        try
        {
            return await this.storage.Exists(livePath) ? (await this.storage.ReadText(livePath)).trim() : undefined
        }
        catch
        {
            return undefined
        }
    }

    /** The packages of the current live manifest (or the legacy `<app>/application.json`) so a UI-only deploy keeps data packages. */
    private async ExistingPackages(appName: string, livePath: string): Promise<UiPackageRef[]>
    {
        const S = UiUnpacker
        const live = await this.ReadLive(livePath)
        const candidates: string[] = []
        if (live !== undefined && S.IsSafeSegment(live))
        {
            candidates.push(S.Join(appName, live, S.ManifestFile))
        }
        candidates.push(S.Join(appName, S.ManifestFile))
        for (const path of candidates)
        {
            try
            {
                if (!await this.storage.Exists(path))
                {
                    continue
                }
                const parsed = JSON.parse(await this.storage.ReadText(path)) as { packages?: unknown }
                if (Array.isArray(parsed.packages))
                {
                    return parsed.packages
                        .filter((p): p is UiPackageRef => p !== null && typeof p === 'object'
                            && typeof (p as UiPackageRef).id === 'string' && typeof (p as UiPackageRef).version === 'string')
                        .map(p => ({ id: p.id, version: p.version }))
                }
            }
            catch
            {
                // An unreadable prior manifest contributes no packages.
            }
        }
        return []
    }

    private static Join(...parts: string[]): string
    {
        return parts.join(UiUnpacker.Separator)
    }

    private static IsSafeSegment(segment: string): boolean
    {
        return segment.length > 0 && segment !== UiUnpacker.CurrentDir && segment !== UiUnpacker.ParentDir
            && !UiUnpacker.UnsafeSegment.test(segment) && !segment.includes(UiUnpacker.Separator)
    }

    private static IsSafeRelativePath(path: string): boolean
    {
        return path.length > 0 && path.split(UiUnpacker.Separator).every(s => UiUnpacker.IsSafeSegment(s))
    }

    private static ParseJson(bytes: Uint8Array): Record<string, unknown>
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(new TextDecoder().decode(bytes))
        }
        catch
        {
            throw new UiUnpackError()
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        {
            throw new UiUnpackError()
        }
        return parsed as Record<string, unknown>
    }

    private static DescriptorDigest(descriptor: unknown): string
    {
        const digest = (descriptor as { digest?: unknown } | null)?.digest
        if (typeof digest !== 'string')
        {
            throw new UiUnpackError()
        }
        return digest
    }

    private static SingleLayerDigest(manifest: Record<string, unknown>): string
    {
        const layers = manifest.layers
        if (!Array.isArray(layers) || layers.length !== 1)
        {
            throw new UiUnpackError()
        }
        return UiUnpacker.DescriptorDigest(layers[0])
    }
}
