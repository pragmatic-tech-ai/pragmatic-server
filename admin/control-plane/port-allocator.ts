import * as net from 'node:net'

export interface IPortProbe
{
    Free(port: number): Promise<boolean>
}

export class NetPortProbe implements IPortProbe
{
    private static readonly Host = '127.0.0.1'
    private static readonly ErrorEvent = 'error'

    public Free(port: number): Promise<boolean>
    {
        return new Promise<boolean>(resolve =>
        {
            const server = net.createServer()
            server.once(NetPortProbe.ErrorEvent, () => resolve(false))
            server.listen(port, NetPortProbe.Host, () =>
            {
                server.close(() => resolve(true))
            })
        })
    }
}

export class PortUnavailableError extends Error
{
    private static readonly MessagePrefix = 'Port unavailable: '

    public constructor(port: number)
    {
        super(PortUnavailableError.MessagePrefix + port)
        this.name = 'PortUnavailableError'
    }
}

export class PortAllocator
{
    private static readonly ScanSpan = 4000

    public constructor(private readonly floor: number, private readonly probe: IPortProbe)
    {
    }

    public async Allocate(taken: readonly number[]): Promise<number>
    {
        const limit = this.floor + PortAllocator.ScanSpan
        for (let port = this.floor; port < limit; port++)
        {
            if (!taken.includes(port) && await this.probe.Free(port))
            {
                return port
            }
        }
        throw new PortUnavailableError(this.floor)
    }

    public async Check(port: number, taken: readonly number[]): Promise<void>
    {
        if (taken.includes(port) || !(await this.probe.Free(port)))
        {
            throw new PortUnavailableError(port)
        }
    }
}
