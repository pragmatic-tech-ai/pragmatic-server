import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { AdminImportBin } from '../bin/pragmatic-admin-import.js'

class AdminImportBinFixture
{
    public static readonly DataRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'platform-admin-data-root')
    public static readonly LiveUrlEnvVar = 'PRAGMATIC_TEST_PG_URL'
    public static readonly TempPrefix = 'padmin-import-bin-'

    public static Capture(): { lines: string[]; write: (line: string) => void }
    {
        const lines: string[] = []
        return { lines, write: line => { lines.push(line) } }
    }
}

describe('AdminImportBin', () =>
{
    const F = AdminImportBinFixture

    it('parses --data-root <folder> [--force] and refuses anything else', () =>
    {
        assert.deepEqual({ ...AdminImportBin.Parse(['--data-root', 'x']) }, { DataRoot: resolve('x'), Force: false })
        assert.deepEqual({ ...AdminImportBin.Parse(['--force', '--data-root', 'x']) }, { DataRoot: resolve('x'), Force: true })
        assert.equal(AdminImportBin.Parse([]), undefined)
        assert.equal(AdminImportBin.Parse(['--data-root']), undefined)
        assert.equal(AdminImportBin.Parse(['--data-root', 'x', '--data-root', 'y']), undefined)
        assert.equal(AdminImportBin.Parse(['--data-root', 'x', '--wipe']), undefined)
    })

    it('a usage error exits 2 with the usage line', async () =>
    {
        const err = F.Capture()
        assert.equal(await AdminImportBin.Run([], {}, () => undefined, err.write), AdminImportBin.UsageExit)
        assert.match(err.lines.join('\n'), /usage: pragmatic-admin-import/)
    })

    it('without the database setting it exits 1 naming the setting', async () =>
    {
        const err = F.Capture()
        assert.equal(await AdminImportBin.Run(['--data-root', F.DataRoot], {}, () => undefined, err.write), AdminImportBin.FailedExit)
        assert.match(err.lines.join('\n'), /PRAGMATIC_ADMIN_DATABASE_URL_FILE/)
    })

    SqlTestSessions.DescribeLive('AdminImportBin', makeDatabase =>
    {
        it('live: imports into the database the URL file names (exit 0, JSON report), then refuses a second run (exit 3)', async () =>
        {
            const live = await makeDatabase()
            const dir = mkdtempSync(join(tmpdir(), F.TempPrefix))
            try
            {
                const url = new URL(process.env[F.LiveUrlEnvVar] as string)
                url.searchParams.set('options', '-c search_path=' + live.Schema)
                const urlFile = join(dir, 'database-url')
                writeFileSync(urlFile, url.toString())
                const env = { PRAGMATIC_ADMIN_DATABASE_URL_FILE: urlFile }
                const out = F.Capture()
                assert.equal(await AdminImportBin.Run(['--data-root', F.DataRoot], env, out.write, () => undefined), 0)
                const report = JSON.parse(out.lines[0] as string) as { counts: Record<string, number> }
                assert.equal(report.counts['records_hives'], 1)
                assert.equal(await AdminImportBin.Run(['--data-root', F.DataRoot], env, () => undefined, () => undefined), AdminImportBin.RefusedExit)
                assert.equal(await AdminImportBin.Run(['--data-root', F.DataRoot, '--force'], env, () => undefined, () => undefined), 0)
            }
            finally
            {
                rmSync(dir, { recursive: true, force: true })
                await live.Dispose()
            }
        })
    })
})
