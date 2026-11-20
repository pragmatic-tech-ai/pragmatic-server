import type { AppHostTls } from '@pragmatic-tech-ai/pragmatic-app-host';

/** The key and certificate the service serves TLS with (PEM). */
export class IdpTlsIdentity implements AppHostTls
{
    public constructor(public readonly Key: Buffer, public readonly Cert: Buffer)
    {
    }
}
