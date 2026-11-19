import { createPublicKey } from 'node:crypto'
import type { IKeyStore } from './key-store.js'

/** Serves one key ref from a private key held in memory (e.g. a Podman secret file read at startup); every other ref
 *  comes from `inner`. The public half is derived, in the same SPKI PEM format PlatformSigningKey writes to `.pub`. */
export class PinnedKeyStore implements IKeyStore
{
    private static readonly PublicEncoding = 'spki'
    private static readonly PemFormat = 'pem'

    private readonly publicPem: string

    public constructor(private readonly ref: string, private readonly privatePem: string, private readonly inner: IKeyStore)
    {
        this.publicPem = createPublicKey(privatePem).export({ type: PinnedKeyStore.PublicEncoding, format: PinnedKeyStore.PemFormat }) as string
    }

    public get PublicPem(): string
    {
        return this.publicPem
    }

    public PublicKey(ref: string): Promise<string>
    {
        return ref === this.ref ? Promise.resolve(this.publicPem) : this.inner.PublicKey(ref)
    }

    public PrivateKey(ref: string): Promise<string>
    {
        return ref === this.ref ? Promise.resolve(this.privatePem) : this.inner.PrivateKey(ref)
    }
}
