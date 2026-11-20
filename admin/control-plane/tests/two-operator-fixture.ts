import { InMemoryAuditRepository } from '@pragmatic-tech-ai/pragmatic-app-host'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../operator-identity.js'
import type { ActivityDto } from '../control-plane-host.js'
import { HostSessions } from './host-sessions.js'

/** Two operators behind fixed session tokens: a Full one (`full-token`, p1) and a ReadOnly one (`readonly-token`, p2). */
export class TwoTokenOperator implements IOperatorIdentity
{
    public static readonly FullToken = 'full-token'
    public static readonly ReadOnlyToken = 'readonly-token'
    public static readonly Full: OperatorPrincipal = { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full }
    public static readonly ReadOnly: OperatorPrincipal = { email: 'ro@example.com', principalId: 'p2', role: OperatorRole.ReadOnly }

    /** The console's session layer with both tokens planted. */
    public static async Sessions(): Promise<HostSessions>
    {
        const sessions = await HostSessions.With(TwoTokenOperator.FullToken, TwoTokenOperator.Full)
        await sessions.Seed(TwoTokenOperator.ReadOnlyToken, TwoTokenOperator.ReadOnly)
        return sessions
    }

    public async Verify(_email: string, _password: string): Promise<OperatorPrincipal | null> { return null }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        return [TwoTokenOperator.Full, TwoTokenOperator.ReadOnly].find(p => p.principalId === principalId) ?? null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]> { return [] }
    public async SetOperatorRole(_e: string, _r: OperatorRole, _a: string): Promise<void> { }
    public async ChangeOwnPassword(_p: string, _c: string, _n: string): Promise<boolean> { return false }
    public async ResetOperatorPassword(_e: string): Promise<string> { return '' }
    public async SetOperatorDisabled(_e: string, _d: boolean, _a: string): Promise<void> { }
    public async RevokeOperatorSessions(_e: string): Promise<void> { }
    public async CreateOperator(_e: string, _p: string, _r: OperatorRole): Promise<void> { }
}

/** The host's audit trail in memory, read back in the activity-log shape the portal sees (actor, method, path, status, note). */
export class ActivityLog
{
    public readonly Repository = new InMemoryAuditRepository()

    public async Recent(limit: number): Promise<ActivityDto[]>
    {
        return (await this.Repository.Recent(limit)).map(e => ({ id: e.Id, actor: e.Actor, method: e.Action, path: e.Target, status: e.Status, at: e.At.toISOString(), ...(e.Note === undefined ? {} : { note: e.Note }) }))
    }
}
