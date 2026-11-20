import { Server } from 'node:http';
import type { AppHost } from '@pragmatic-tech-ai/pragmatic-app-host';

/** The host offers no node server to hook into (pragmatic-app-host changed its internals): the service refuses to start. */
export class AppHostServerError extends Error
{
    private static readonly ErrorName = 'AppHostServerError';
    private static readonly Text = 'The app host exposes no node server; the realm sign-in service needs it for its form-bodied OAuth endpoints and its TLS listener until pragmatic-app-host offers both (plan Ledger gaps G1, G2).';

    public constructor()
    {
        super(AppHostServerError.Text);
        this.name = AppHostServerError.ErrorName;
    }
}

/**
 * The node server of a listening AppHost: the one non-public member the realm sign-in service touches (as the tenant
 * console's RelayUpgradeHook does), read after Listen. A host without it refuses at start, loudly, so a package change
 * never silently drops the token endpoint or TLS. Goes when pragmatic-app-host has form-bodied routes (G1) and a TLS
 * option (G2).
 */
export class AppHostServer
{
    private static readonly ServerMember = 'server';

    public static Of(host: AppHost): Server
    {
        const server = (host as unknown as Record<string, unknown>)[AppHostServer.ServerMember];
        if (!(server instanceof Server))
        {
            throw new AppHostServerError();
        }
        return server;
    }
}
