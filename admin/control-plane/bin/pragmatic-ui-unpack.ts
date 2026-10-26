import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { FileKeyStore } from '../key-store.js'
import { OciRegistryClient } from '../oci-registry-client.js'
import { UiArtifactVerifier } from '../ui-artifact-signer.js'
import { UiUnpacker, type UiUnpackInput } from '../ui-unpacker.js'

/** Init-container entry: reads its inputs from the environment, reconciles, and exits non-zero on any failure. */
export class UiUnpackBin
{
    public static readonly RegistryPullBaseEnv = 'PRAGMATIC_UI_REGISTRY_BASE'
    public static readonly RepoEnv = 'PRAGMATIC_UI_REPO'
    public static readonly ArtifactTagEnv = 'PRAGMATIC_UI_ARTIFACT_TAG'
    public static readonly SigTagEnv = 'PRAGMATIC_UI_SIG_TAG'
    public static readonly ExpectedDigestEnv = 'PRAGMATIC_UI_MANIFEST_DIGEST'
    public static readonly AppNameEnv = 'PRAGMATIC_UI_APP_NAME'
    public static readonly AppVersionEnv = 'PRAGMATIC_UI_APP_VERSION'
    public static readonly TrustRootRefEnv = 'PRAGMATIC_UI_TRUST_ROOT_REF'
    public static readonly DataDirEnv = 'PRAGMATIC_UI_DATA_DIR'
    public static readonly TrustDirEnv = 'PRAGMATIC_UI_TRUST_DIR'
    private static readonly FailureMessage = 'pragmatic-ui-unpack: failed'
    private static readonly MissingMessage = 'pragmatic-ui-unpack: missing required environment'

    public static async Main(env: NodeJS.ProcessEnv = process.env): Promise<void>
    {
        const S = UiUnpackBin
        try
        {
            const base = S.Required(env, S.RegistryPullBaseEnv)
            const dataDir = S.Required(env, S.DataDirEnv)
            const trustDir = S.Required(env, S.TrustDirEnv)
            const input: UiUnpackInput =
            {
                repo: S.Required(env, S.RepoEnv),
                artifactTag: S.Required(env, S.ArtifactTagEnv),
                sigTag: S.Required(env, S.SigTagEnv),
                expectedManifestDigest: S.Required(env, S.ExpectedDigestEnv),
                appName: S.Required(env, S.AppNameEnv),
                appVersion: S.Required(env, S.AppVersionEnv),
                trustRootRef: S.Required(env, S.TrustRootRefEnv),
            }
            const unpacker = new UiUnpacker(new OciRegistryClient(base), new UiArtifactVerifier(new FileKeyStore(trustDir)), new NodeFsStorage(dataDir))
            await unpacker.Reconcile(input)
        }
        catch
        {
            console.error(S.FailureMessage)
            process.exitCode = 1
        }
    }

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value.length === 0)
        {
            throw new Error(UiUnpackBin.MissingMessage)
        }
        return value
    }
}

await UiUnpackBin.Main()
