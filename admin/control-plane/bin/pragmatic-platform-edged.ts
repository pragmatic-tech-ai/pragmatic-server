import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EdgeComposition, EdgeShutdown } from '../edge-composition.js'

/**
 * The platform edge's own entry: the keyless edge (no data root, key, registry or master key is ever opened; the
 * platform admin console answers over the internal API). The pragmatic-platform-edge image's entry point; the console's
 * `server.ts` refuses role `edge`.
 */
export class PlatformEdgeBin
{
    private static readonly ListeningPrefix = 'Edge listening on '
    private static readonly PortSeparator = ':'
    private static readonly TrustedProxySuffix = ' (client addresses from the trusted proxy)'
    private static readonly FailurePrefix = 'pragmatic-platform-edged: '

    /** Composes the edge from the environment, listens, and installs the signal shutdown. */
    public static async Start(env: NodeJS.ProcessEnv = process.env): Promise<void>
    {
        const E = PlatformEdgeBin
        const edge = EdgeComposition.Compose(env)
        await edge.Host.Listen(edge.Port, edge.Bind)
        EdgeShutdown.Install(edge.Host)
        console.log(E.ListeningPrefix + edge.Bind + E.PortSeparator + String(edge.Port) + (edge.TrustedProxy ? E.TrustedProxySuffix : ''))
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
    }

    public static async Main(): Promise<void>
    {
        try
        {
            await PlatformEdgeBin.Start()
        }
        catch (err)
        {
            // The whole stack, as an uncaught start failure printed before the edge had its own entry.
            console.error(PlatformEdgeBin.FailurePrefix + (err instanceof Error ? err.stack ?? err.message : String(err)))
            process.exitCode = 1
        }
    }
}

if (PlatformEdgeBin.IsEntryPoint())
{
    await PlatformEdgeBin.Main()
}
