import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DeliverySecurity } from '../delivery-security.js'
import type { EnvironmentSecuritySetting } from '../environment-security-setting.js'
import { SecurityChangeLog } from '../security-change-log.js'
import type { SecurityDeployDiff } from '../security-deploy-diff.js'
import type { SystemPrincipalScope } from '../system-principal-scope.js'

class LogFx
{
    public static readonly App = 'suite'
    private static readonly RootPrefix = 'ps-security-log-'
    private static readonly Unused = 'unused'

    public static async Run(body: (log: SecurityChangeLog) => Promise<void>): Promise<void>
    {
        const root = mkdtempSync(join(tmpdir(), LogFx.RootPrefix))
        try
        {
            await body(new SecurityChangeLog(new NodeFsStorage(root)))
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    }

    public static Entry(version: number): SecurityChangesDto
    {
        return {
            at: new Date(version * 1000).toISOString(), delivery: LogFx.App, version: String(version),
            roleDefaults: [], profileDefaults: [], securedFieldsAdded: [{ concept: 'hr.Employee', field: 'Bonus' }], securedFieldsRemoved: [],
            roleOverridesDropped: [], profileOverridesDropped: [], rolesRemoved: [], profilesRemoved: [],
        }
    }

    /** A DeliverySecurity whose setting and system principal are never reached (an empty diff prunes and backfills nothing). */
    public static Security(log: SecurityChangeLog): DeliverySecurity
    {
        const unused = (): never => { throw new Error(LogFx.Unused) }
        return new DeliverySecurity({ Config: unused } as unknown as EnvironmentSecuritySetting, log, () => Promise.reject(new Error(LogFx.Unused)) as Promise<SystemPrincipalScope>)
    }
}

describe('security change log', () =>
{
    test('entries are newest first and capped', async () =>
    {
        await LogFx.Run(async log =>
        {
            const count = SecurityChangeLog.MaxEntries + 2
            for (let version = 1; version <= count; version++) await log.Append(LogFx.Entry(version))
            const listed = await log.List()
            assert.equal(listed.length, SecurityChangeLog.MaxEntries)
            assert.equal(listed[0].version, String(count), 'newest first')
            assert.equal(listed[listed.length - 1].version, String(count - SecurityChangeLog.MaxEntries + 1), 'the oldest beyond the cap are dropped')
        })
    })

    test('empty diff is not logged', async () =>
    {
        await LogFx.Run(async log =>
        {
            const empty = { IsEmpty: true, Prunes: false, NewlyOwned: [] } as unknown as SecurityDeployDiff
            assert.equal(await LogFx.Security(log).Commit(empty, LogFx.App, LogFx.App), undefined)
            assert.deepEqual(await log.List(), [])
        })
    })
})
