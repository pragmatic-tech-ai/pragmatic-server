/** The key and certificate the service serves TLS with (PEM). */
export class IdpTlsIdentity
{
    public constructor(public readonly Key: Buffer, public readonly Cert: Buffer)
    {
    }
}
