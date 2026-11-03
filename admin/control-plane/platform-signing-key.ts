import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { link, mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { IImageSigner } from './image-signer.js'
import { FileKeyStore } from './key-store.js'
import type { HiveRecord } from './platform-records.js'

/** Only the public half of the platform key pair is on disk; it cannot be recovered and is never silently regenerated. */
export class PlatformSigningKeyIncompleteError extends Error
{
    private static readonly ErrorName = 'PlatformSigningKeyIncompleteError'
    private static readonly MessagePrefix = 'The platform signing key has its public half but not its private half; restore the private key, or remove both files to generate a new key (hives that trust the old key then need its replacement): '

    public constructor(ref: string)
    {
        super(PlatformSigningKeyIncompleteError.MessagePrefix + ref)
        this.name = PlatformSigningKeyIncompleteError.ErrorName
    }
}

/** An operator-named signing key ref that is not a bare name, or whose key pair is not in the key store. */
export class PlatformSigningKeyMissingError extends Error
{
    private static readonly ErrorName = 'PlatformSigningKeyMissingError'
    private static readonly MessagePrefix = 'PRAGMATIC_ADMIN_SIGNING_KEY_REF names a key pair that is not in the key store (both <ref>.key and <ref>.pub are needed): '

    public constructor(ref: string)
    {
        super(PlatformSigningKeyMissingError.MessagePrefix + ref)
        this.name = PlatformSigningKeyMissingError.ErrorName
    }
}

/**
 * The platform's own Ed25519 image-signing key, kept in the control plane's key store. It is created on first start
 * (never overwritten), signs what the platform publishes and deploys, and is the default trust root of every hive, so a
 * hive can run the platform's images without anyone handling keys by hand. The private key never leaves the key store.
 * The private file is created owner-only (0600) where the OS honours modes; on Windows it inherits the folder's ACL.
 */
export class PlatformSigningKey
{
    public static readonly DefaultRef = 'platform-signing'
    private static readonly KeyType = 'ed25519'
    private static readonly PemFormat = 'pem'
    private static readonly PublicEncoding = 'spki'
    private static readonly PrivateEncoding = 'pkcs8'
    private static readonly CreateExclusive = 'wx'
    private static readonly TempSuffix = '.tmp'
    private static readonly TempSeparator = '.'
    private static readonly PrivateMode = 0o600
    private static readonly PublicMode = 0o644
    private static readonly AlreadyExists = 'EEXIST'
    private static readonly Encoding = 'utf8'

    /**
     * Creates the pair under `keysDir` when neither file exists; keeps an existing pair; rebuilds a missing public half
     * from the private one (a crash between the two writes); refuses a lone public half.
     */
    public static async Ensure(keysDir: string, ref: string): Promise<void>
    {
        const C = PlatformSigningKey
        const publicPath = join(keysDir, ref + FileKeyStore.PublicSuffix)
        const privatePath = join(keysDir, ref + FileKeyStore.PrivateSuffix)
        const hasPublic = existsSync(publicPath)
        const hasPrivate = existsSync(privatePath)
        if (hasPublic && hasPrivate)
        {
            return
        }
        if (hasPublic)
        {
            throw new PlatformSigningKeyIncompleteError(ref)
        }
        try
        {
            if (hasPrivate)
            {
                const publicPem = createPublicKey(createPrivateKey(readFileSync(privatePath, C.Encoding))).export({ type: C.PublicEncoding, format: C.PemFormat }) as string
                await C.CreateComplete(publicPath, publicPem, C.PublicMode)
                return
            }
            await mkdir(keysDir, { recursive: true })
            const pair = generateKeyPairSync(C.KeyType, {
                publicKeyEncoding: { type: C.PublicEncoding, format: C.PemFormat },
                privateKeyEncoding: { type: C.PrivateEncoding, format: C.PemFormat }
            })
            await C.CreateComplete(privatePath, pair.privateKey, C.PrivateMode)
            await C.CreateComplete(publicPath, pair.publicKey, C.PublicMode)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code !== C.AlreadyExists)
            {
                throw err
            }
            // Another process created a file first: take whatever pair it left (rebuilding a public half if needed).
            await C.Ensure(keysDir, ref)
        }
    }

    /**
     * Creates `path` holding all of `content`, or fails with EEXIST when it already exists: the bytes go to a private temp
     * file first and are then hard-linked into place (link never replaces), so no reader ever sees a partial key and a
     * concurrent first start can never overwrite a key another one just wrote.
     */
    private static async CreateComplete(path: string, content: string, mode: number): Promise<void>
    {
        const C = PlatformSigningKey
        const temp = path + C.TempSeparator + randomUUID() + C.TempSuffix
        await writeFile(temp, content, { flag: C.CreateExclusive, mode })
        try
        {
            await link(temp, path)
        }
        finally
        {
            await unlink(temp)
        }
    }

    /** Checks an operator-named ref: a bare name whose two key files are in the key store. Nothing is generated. */
    public static Require(keysDir: string, ref: string): void
    {
        const usable = ref.length > 0 && basename(ref) === ref
            && existsSync(join(keysDir, ref + FileKeyStore.PrivateSuffix))
            && existsSync(join(keysDir, ref + FileKeyStore.PublicSuffix))
        if (!usable)
        {
            throw new PlatformSigningKeyMissingError(ref)
        }
    }
}

/**
 * Signs images with the platform signing key, and only for hives whose trust root IS that key: a hive given its own
 * trust root gets its images signed by whoever holds that key, never by the platform. Signing a server image at
 * bring-up trusts the control-plane host's local image (whatever the template tag names there) - the deliberate
 * trade-off of letting the platform run its own images without a separate build-time signing step.
 */
export class PlatformImageSigner
{
    public constructor(private readonly signer: IImageSigner, public readonly KeyRef: string)
    {
    }

    public SignsFor(hive: HiveRecord): boolean
    {
        return hive.trustRootRef === this.KeyRef
    }

    public Sign(imageRef: string): Promise<void>
    {
        return this.signer.Sign(imageRef, this.KeyRef)
    }
}
