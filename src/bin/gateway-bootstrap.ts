import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { type GatewayConfig, type Observability, type RateLimitGuard, HostBootstrap, type IWorkerRouter } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { GatewayOptions } from '../cluster/gateway.js'

/** The environment gateway's options and startup line from its configuration. */
export class GatewayBootstrap
{
    private static readonly ServerNameDefault = 'default'

    public static ComposeGatewayOptions(gw: GatewayConfig, router: IWorkerRouter, logger?: ILogger, rateLimit?: RateLimitGuard, observability?: Observability): GatewayOptions
    {
        return {
            host: gw.host,
            port: gw.port,
            router,
            tls: gw.tls,
            serverName: gw.workerServerName,
            clientTls: gw.clientTls,
            logger,
            rateLimit,
            observability,
            drainTimeoutMs: gw.drainTimeoutMs,
        }
    }

    public static GatewayStartupLine(gw: GatewayConfig): string
    {
        return `pragmatic-gateway listening on ${gw.host}:${gw.port} servername=${gw.workerServerName ?? GatewayBootstrap.ServerNameDefault}${HostBootstrap.ClientMtlsToken(gw.clientTls)}${HostBootstrap.OtelToken(gw)}${HostBootstrap.SecurityTokens(gw)}${HostBootstrap.DrainToken(gw)}`
    }
}
