/**
 * Gated end-to-end integration smoke for the demo environment (operator-run, NOT part of `npx tsx --test`).
 *
 * Requires Docker and the built `pragmatic-server:dev` image. Run from the pragmatic-server dir:
 *   npx tsx environments/seed/smoke.ts
 *
 * Brings up the demo env (SeedCli.Run Up), logs in as rep-boston / rep-atlanta / manager-north / finance using the
 * generated provisioned-secrets.json, opens the northwind application on each connection, and asserts the four
 * security axes over the real data protocol (Cypher reads, data/share, data/assign). Prints PASS/FAIL per axis and
 * exits non-zero if any axis fails.
 */
import { fileURLToPath } from 'node:url'
import { PragmaticClient, ShareSubjectKind, ShareStatus, AssignStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherQueryPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { Command, SeedCli } from './seed.js'
import { UserSeeder } from './users.js'
import { NorthwindApp } from './compile.js'
import type { EnvDefinition } from './bundle.js'

type OrderRow = { id: string; orderNo: string; owner: string; owningBu: string }

class SmokeAxis
{
    constructor(public readonly name: string, public readonly passed: boolean, public readonly detail: string)
    {
    }
}

/** Operator-run smoke test for the demo environment's four security axes. */
export class DemoSmoke
{
    private static readonly EnvName = 'demo'
    private static readonly RepBoston = 'rep-boston'
    private static readonly RepAtlanta = 'rep-atlanta'
    private static readonly ManagerNorth = 'manager-north'
    private static readonly Finance = 'finance'
    private static readonly PasswordSuffix = '-pw'
    private static readonly EmailDomain = '@contoso.test'
    private static readonly OrderConcept = 'northwind.Order'
    private static readonly ReadRight = 'read'
    private static readonly OrdersQuery = 'MATCH (o:Order) RETURN o, o.orderNo, o.owner, o.owningBu'
    private static readonly CreditQuery = 'MATCH (c:Customer) RETURN c.company, c.creditLimit'
    private static readonly WsQuerySeparator = '/?tenant='
    /** rep-boston: businessUnit level reach = home BU (boston) + owning BU of team sales-north (north); no children. */
    private static readonly BostonReach: readonly string[] = ['boston', 'north']
    /** Orders owned by the reach above (10248/10249/10255 boston, 10254 north). */
    private static readonly BostonVisibleOrders: readonly string[] = ['10248', '10249', '10254', '10255']
    /** newyork (10250) is a child BU, outside businessUnit reach; atlanta (10251-10253) is outside entirely. */
    private static readonly BostonHiddenOrders: readonly string[] = ['10250', '10251', '10252', '10253']
    private static readonly SharedOrderNo = '10251'
    /** An atlanta order outside rep-boston's reach and distinct from the shared order. */
    private static readonly AssignedOrderNo = '10252'
    private static readonly AssignBu = 'boston'
    private static readonly AtlantaBu = 'atlanta'
    private static readonly AxisBuDepth = 'BU depth'
    private static readonly AxisFieldSecurity = 'Field security'
    private static readonly AxisSharing = 'Sharing'
    private static readonly AxisAssign = 'Assign'
    private static readonly PassLabel = 'PASS'
    private static readonly FailLabel = 'FAIL'
    private static readonly UnexpectedPrefix = 'unexpected error: '
    private static readonly OrderNotFoundPrefix = 'order not found in read: '
    private static readonly ListSeparator = ','
    private static readonly ReasonOpen = ' ('
    private static readonly ReasonClose = ')'
    private static readonly EmptyText = ''

    private readonly def: EnvDefinition = SeedCli.LoadDefinition(DemoSmoke.EnvName)
    private secrets: Record<string, string> = {}
    private readonly clients: PragmaticClient[] = []

    public static async Main(): Promise<void>
    {
        const smoke = new DemoSmoke()
        let axes: SmokeAxis[]
        try
        {
            await SeedCli.Run(Command.Up, DemoSmoke.EnvName)
            axes = await smoke.RunAxes()
        }
        finally
        {
            await smoke.Dispose()
        }
        for (const axis of axes)
        {
            console.log(`${axis.passed ? DemoSmoke.PassLabel : DemoSmoke.FailLabel}  ${axis.name}  ${axis.detail}`)
        }
        process.exit(axes.every(a => a.passed) ? 0 : 1)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }

    public async RunAxes(): Promise<SmokeAxis[]>
    {
        this.secrets = SeedCli.LoadSecrets(DemoSmoke.EnvName)
        const boston = await this.ConnectAs(DemoSmoke.RepBoston)
        const atlanta = await this.ConnectAs(DemoSmoke.RepAtlanta)
        const manager = await this.ConnectAs(DemoSmoke.ManagerNorth)
        const finance = await this.ConnectAs(DemoSmoke.Finance)
        await this.ResetState(boston, atlanta)
        const axes: SmokeAxis[] = []
        axes.push(await this.Guard(DemoSmoke.AxisBuDepth, () => this.CheckBuDepth(boston)))
        axes.push(await this.Guard(DemoSmoke.AxisFieldSecurity, () => this.CheckFieldSecurity(boston, manager, finance)))
        axes.push(await this.Guard(DemoSmoke.AxisSharing, () => this.CheckSharing(boston, atlanta)))
        axes.push(await this.Guard(DemoSmoke.AxisAssign, () => this.CheckAssign(boston, atlanta)))
        await this.ResetState(boston, atlanta)
        return axes
    }

    public async Dispose(): Promise<void>
    {
        for (const client of this.clients)
        {
            await client.DisposeAsync()
        }
    }

    /** rep-boston sees exactly the orders owned by boston or north; newyork (child BU) and atlanta orders stay hidden. */
    private async CheckBuDepth(boston: PragmaticClient): Promise<SmokeAxis>
    {
        const orders = await this.Orders(boston)
        const numbers = orders.map(o => o.orderNo).sort()
        const outside = orders.filter(o => !DemoSmoke.BostonReach.includes(o.owningBu)).map(o => o.orderNo)
        const missing = DemoSmoke.BostonVisibleOrders.filter(n => !numbers.includes(n))
        const leaked = DemoSmoke.BostonHiddenOrders.filter(n => numbers.includes(n))
        const passed = outside.length === 0 && missing.length === 0 && leaked.length === 0
        return new SmokeAxis(DemoSmoke.AxisBuDepth, passed, `rep-boston sees [${DemoSmoke.Join(numbers)}]; outside reach [${DemoSmoke.Join(outside)}]; missing [${DemoSmoke.Join(missing)}]; leaked [${DemoSmoke.Join(leaked)}]`)
    }

    /** Customer.creditLimit is masked (null) for rep-boston and readable for manager-north and finance. */
    private async CheckFieldSecurity(boston: PragmaticClient, manager: PragmaticClient, finance: PragmaticClient): Promise<SmokeAxis>
    {
        const bostonLimits = await this.CreditLimits(boston)
        const managerLimits = await this.CreditLimits(manager)
        const financeLimits = await this.CreditLimits(finance)
        const masked = bostonLimits.length > 0 && bostonLimits.every(v => v === null || v === undefined)
        const readable = (list: unknown[]) => list.length > 0 && list.every(v => typeof v === 'number')
        const passed = masked && readable(managerLimits) && readable(financeLimits)
        return new SmokeAxis(DemoSmoke.AxisFieldSecurity, passed, `rep-boston [${bostonLimits.join(DemoSmoke.ListSeparator)}]; manager-north [${managerLimits.join(DemoSmoke.ListSeparator)}]; finance [${financeLimits.join(DemoSmoke.ListSeparator)}]`)
    }

    /** rep-atlanta shares an atlanta order (Read) to rep-boston, turning a denied read into an allowed one. */
    private async CheckSharing(boston: PragmaticClient, atlanta: PragmaticClient): Promise<SmokeAxis>
    {
        const before = (await this.Orders(boston)).some(o => o.orderNo === DemoSmoke.SharedOrderNo)
        const target = await this.OrderByNumber(atlanta, DemoSmoke.SharedOrderNo)
        const result = await atlanta.ShareRecord({
            concept: DemoSmoke.OrderConcept, id: target.id,
            subject: { kind: ShareSubjectKind.Principal, id: DemoSmoke.RepBoston }, rights: [DemoSmoke.ReadRight],
        })
        const after = (await this.Orders(boston)).some(o => o.orderNo === DemoSmoke.SharedOrderNo)
        const passed = !before && result.status === ShareStatus.Applied && after
        return new SmokeAxis(DemoSmoke.AxisSharing, passed, `visible before=${before}; share status=${result.status}${DemoSmoke.Reason(result.reason)}; visible after=${after}`)
    }

    /** rep-atlanta assigns an atlanta order (outside rep-boston's reach) to rep-boston with owningBu boston: hidden before; owner updated and visible after. */
    private async CheckAssign(boston: PragmaticClient, atlanta: PragmaticClient): Promise<SmokeAxis>
    {
        const visibleBefore = (await this.Orders(boston)).some(o => o.orderNo === DemoSmoke.AssignedOrderNo)
        const target = await this.OrderByNumber(atlanta, DemoSmoke.AssignedOrderNo)
        const result = await atlanta.AssignRecord({
            concept: DemoSmoke.OrderConcept, id: target.id,
            owner: { kind: ShareSubjectKind.Principal, id: DemoSmoke.RepBoston }, owningBu: DemoSmoke.AssignBu,
        })
        const after = (await this.Orders(boston)).find(o => o.orderNo === DemoSmoke.AssignedOrderNo)
        const passed = !visibleBefore && result.status === AssignStatus.Applied && after !== undefined && after.owner === DemoSmoke.RepBoston
        return new SmokeAxis(DemoSmoke.AxisAssign, passed, `visible before=${visibleBefore}; assign status=${result.status}${DemoSmoke.Reason(result.reason)}; owner now=${after?.owner}; visible after=${after !== undefined}`)
    }

    /** Makes reruns start clean: drops the share, and hands the assigned order back to rep-atlanta (rep-boston holds BU-level assign once it owns it). */
    private async ResetState(boston: PragmaticClient, atlanta: PragmaticClient): Promise<void>
    {
        try
        {
            const shared = await this.OrderByNumber(atlanta, DemoSmoke.SharedOrderNo)
            await atlanta.UnshareRecord({ concept: DemoSmoke.OrderConcept, id: shared.id, subject: { kind: ShareSubjectKind.Principal, id: DemoSmoke.RepBoston } })
        }
        catch
        {
            // Nothing to reset on a first run.
        }
        try
        {
            const assigned = await this.OrderByNumber(boston, DemoSmoke.AssignedOrderNo)
            await boston.AssignRecord({
                concept: DemoSmoke.OrderConcept, id: assigned.id,
                owner: { kind: ShareSubjectKind.Principal, id: DemoSmoke.RepAtlanta }, owningBu: DemoSmoke.AtlantaBu,
            })
        }
        catch
        {
            // Nothing to reset on a first run.
        }
    }

    private static Join(values: readonly string[]): string
    {
        return values.join(DemoSmoke.ListSeparator)
    }

    private static Reason(reason: string | undefined): string
    {
        return reason ? DemoSmoke.ReasonOpen + reason + DemoSmoke.ReasonClose : DemoSmoke.EmptyText
    }

    private async Guard(name: string, check: () => Promise<SmokeAxis>): Promise<SmokeAxis>
    {
        try
        {
            return await check()
        }
        catch (err)
        {
            return new SmokeAxis(name, false, DemoSmoke.UnexpectedPrefix + (err instanceof Error ? err.message : String(err)))
        }
    }

    private async Orders(client: PragmaticClient): Promise<OrderRow[]>
    {
        const result: CypherQueryPageDto = await client.CypherQuery(DemoSmoke.OrdersQuery)
        return result.items.map(r => ({ id: (r[0] as { id: string }).id, orderNo: String(r[1]), owner: String(r[2]), owningBu: String(r[3]) }))
    }

    private async OrderByNumber(client: PragmaticClient, orderNo: string): Promise<OrderRow>
    {
        const found = (await this.Orders(client)).find(o => o.orderNo === orderNo)
        if (found === undefined)
        {
            throw new Error(DemoSmoke.OrderNotFoundPrefix + orderNo)
        }
        return found
    }

    private async CreditLimits(client: PragmaticClient): Promise<unknown[]>
    {
        const result = await client.CypherQuery(DemoSmoke.CreditQuery)
        return result.items.map(r => r[1])
    }

    /** Logs in as the principal (password from the generated secrets via its (principal)-pw ref), connects, binds northwind. */
    private async ConnectAs(principalId: string): Promise<PragmaticClient>
    {
        const seeder = new UserSeeder()
        const token = await seeder.Login(SeedCli.HttpUrl(this.def), this.def.tenantId, principalId + DemoSmoke.EmailDomain, this.secrets[principalId + DemoSmoke.PasswordSuffix])
        const client = await PragmaticClient.ConnectAsync(SeedCli.WsUrl(this.def) + DemoSmoke.WsQuerySeparator + encodeURIComponent(this.def.tenantId), { bearerToken: token })
        this.clients.push(client)
        await client.OpenApplication(NorthwindApp.AppName)
        return client
    }
}

if (DemoSmoke.IsEntryPoint())
{
    DemoSmoke.Main().catch(err =>
    {
        console.error(err instanceof Error ? err.message : err)
        process.exit(1)
    })
}
