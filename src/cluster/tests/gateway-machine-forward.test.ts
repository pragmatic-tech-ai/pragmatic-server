import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TLSSocket } from 'node:tls'
import { Gateway } from '../gateway.js'

class FakeSocket
{
    public readonly authorized: boolean
    private readonly fingerprint: string

    public constructor(authorized: boolean, fingerprint: string)
    {
        this.authorized = authorized
        this.fingerprint = fingerprint
    }

    public getPeerCertificate(): { fingerprint256: string }
    {
        return { fingerprint256: this.fingerprint }
    }

    public AsTls(): TLSSocket
    {
        return this as unknown as TLSSocket
    }
}

describe('Gateway.StampMachineFingerprint', () =>
{
    const Header = 'x-pragmatic-machine-fingerprint'
    const Spoofed = 'spoofed'
    const RawFingerprint = 'AA:BB:CC:DD'
    const CanonicalFingerprint = 'aabbccdd'

    it('deletes an inbound spoofed header when client TLS is not configured', () =>
    {
        const headers: Record<string, string | string[] | undefined> = { [Header]: Spoofed }
        Gateway.StampMachineFingerprint(headers, new FakeSocket(true, RawFingerprint).AsTls(), false)
        assert.equal(headers[Header], undefined)
        assert.equal(Header in headers, false)
    })

    it('overwrites a spoofed header with the verified cert fingerprint when authorized', () =>
    {
        const headers: Record<string, string | string[] | undefined> = { [Header]: Spoofed }
        Gateway.StampMachineFingerprint(headers, new FakeSocket(true, RawFingerprint).AsTls(), true)
        assert.equal(headers[Header], CanonicalFingerprint)
    })

    it('leaves the header absent when the peer is not authorized', () =>
    {
        const headers: Record<string, string | string[] | undefined> = { [Header]: Spoofed }
        Gateway.StampMachineFingerprint(headers, new FakeSocket(false, RawFingerprint).AsTls(), true)
        assert.equal(Header in headers, false)
    })
})
