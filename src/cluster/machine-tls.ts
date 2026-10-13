import { readFileSync } from 'node:fs'

export interface MachineTlsRef
{
    certFile: string
    keyFile: string
    caFile: string
}

export interface ServerTlsMaterial
{
    key: Buffer
    cert: Buffer
    ca: Buffer
    requestCert: true
    rejectUnauthorized: true
}

export interface OptionalServerTlsMaterial
{
    key: Buffer
    cert: Buffer
    ca: Buffer
    requestCert: true
    rejectUnauthorized: false
}

export interface ClientTlsMaterial
{
    key: Buffer
    cert: Buffer
    ca: Buffer
}

/** Loads the gateway<->worker mutual-TLS material by file reference. Key bytes are never logged.
 *  The worker requires + verifies a client cert against the CA; the gateway presents its client cert. */
export class MachineTls
{
    public static Server(ref: MachineTlsRef): ServerTlsMaterial
    {
        return {
            key: readFileSync(ref.keyFile),
            cert: readFileSync(ref.certFile),
            ca: readFileSync(ref.caFile),
            requestCert: true,
            rejectUnauthorized: true,
        }
    }

    public static OptionalServer(ref: MachineTlsRef): OptionalServerTlsMaterial
    {
        return {
            key: readFileSync(ref.keyFile),
            cert: readFileSync(ref.certFile),
            ca: readFileSync(ref.caFile),
            requestCert: true,
            rejectUnauthorized: false,
        }
    }

    public static Client(ref: MachineTlsRef): ClientTlsMaterial
    {
        return {
            key: readFileSync(ref.keyFile),
            cert: readFileSync(ref.certFile),
            ca: readFileSync(ref.caFile),
        }
    }
}
