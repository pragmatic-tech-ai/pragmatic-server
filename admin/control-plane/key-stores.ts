import { createPrivateKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileKeyStore, type IKeyStore } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { PinnedKeyStore } from './pinned-key-store.js'
import { PlatformHiveOrchestratorFactory } from './platform-hive-orchestrator-factory.js'

/** Raised for an unusable PRAGMATIC_ADMIN_SIGNING_KEY_FILE. Names the setting and the reason, never key material. */
export class SigningKeyFileError extends Error
{
    private static readonly ErrorName = 'SigningKeyFileError'

    public constructor(reason: string)
    {
        super(KeyStores.SigningKeyFileEnvVar + KeyStores.ReasonSeparator + reason)
        this.name = SigningKeyFileError.ErrorName
    }
}

/** The control plane's key store: the data root's `keys` directory, with the platform signing key pinned from
 *  PRAGMATIC_ADMIN_SIGNING_KEY_FILE when that is set (then no private key is ever generated or written to disk). */
export class KeyStores
{
    public static readonly SigningKeyFileEnvVar = 'PRAGMATIC_ADMIN_SIGNING_KEY_FILE'
    public static readonly ReasonSeparator = ': '
    private static readonly Ed25519 = 'ed25519'
    private static readonly Utf8 = 'utf8'
    private static readonly Unreadable = 'file is missing or unreadable'
    private static readonly NotAKey = 'file is not a PEM private key'
    private static readonly NotEd25519 = 'key is not Ed25519'

    /** Built once per process (ControlPlaneServer.Main) and passed to every signer; `ref` is the platform signing key
     *  ref (ControlPlaneServer.SigningKeyRefOf), under which the file's key is pinned. */
    public static Of(dataRoot: string, env: NodeJS.ProcessEnv, ref: string): IKeyStore
    {
        const files = new FileKeyStore(join(dataRoot, PlatformHiveOrchestratorFactory.KeysDirName))
        const path = env[KeyStores.SigningKeyFileEnvVar]?.trim() ?? ''
        return path === '' ? files : new PinnedKeyStore(ref, KeyStores.ReadEd25519(path), files)
    }

    private static ReadEd25519(path: string): string
    {
        let pem: string
        try
        {
            pem = readFileSync(path, KeyStores.Utf8)
        }
        catch
        {
            throw new SigningKeyFileError(KeyStores.Unreadable)
        }
        let type: string | undefined
        try
        {
            type = createPrivateKey(pem).asymmetricKeyType
        }
        catch
        {
            throw new SigningKeyFileError(KeyStores.NotAKey)
        }
        if (type !== KeyStores.Ed25519)
        {
            throw new SigningKeyFileError(KeyStores.NotEd25519)
        }
        return pem
    }
}
