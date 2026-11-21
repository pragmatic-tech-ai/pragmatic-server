import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { SharedHomeUsers, SplitHome } from '../assignment-rules.js'
import { ReachReport, SplitAssignment } from '../reach-report.js'
import { SourceImports } from '../source-imports.js'

/** The container line: what each image's entry points reach, measured once. */
class Boundaries
{
    public static readonly Root = join(import.meta.dirname, '..', '..', '..')
    public static readonly SharedPrefix = 'pragmatic-shared/'
    public static readonly TsExtension = '.ts'
    public static Assignment: SplitAssignment
    public static Reach: ReadonlyMap<string, ReadonlySet<string>>

    /** The image's own repository, as AssignmentRules names it. */
    public static HomeOf(app: ReleaseApp): string
    {
        return Object.values(SplitHome).find(home => (home as string) === (app as string)) ?? app
    }
}

describe('container boundaries', () =>
{
    before(async () =>
    {
        const report = new ReachReport(Boundaries.Root)
        Boundaries.Assignment = await report.Assignment()
        Boundaries.Reach = await report.ForEach([...new Set([...ReachReport.Entries.values()].flat())])
    })

    it('no image\'s closure reaches another image\'s own files, nor a shared package meant for other images', () =>
    {
        const crossings: string[] = []
        for (const [app, entries] of ReachReport.Entries)
        {
            const own = Boundaries.HomeOf(app)
            for (const file of new Set(entries.flatMap(entry => [...(Boundaries.Reach.get(entry) ?? [])])))
            {
                const home = Boundaries.Assignment.Homes[file]
                const shared = home.startsWith(Boundaries.SharedPrefix)
                if ((home !== own && !shared) || (shared && !SharedHomeUsers.Allows(home, app)))
                {
                    crossings.push(app + ' -> ' + file + ' (' + home + ')')
                }
            }
        }
        assert.deepEqual(crossings, [])
    })

    it('a shared package\'s files import, type-only imports included, only shared packages (they must compile there)', () =>
    {
        const B = Boundaries
        const imports = new SourceImports(B.Root)
        const support = new Set(B.Assignment.SharedSupport)
        const crossings: string[] = []
        // a shared package's tests carry a copy of the support files they import, so those are checked as the package's
        const queue = Object.entries(B.Assignment.Homes).filter(([file, home]) => home.startsWith(B.SharedPrefix) && file.endsWith(B.TsExtension))
        const seen = new Set(queue.map(([file]) => file))
        while (queue.length > 0)
        {
            const [file, home] = queue.shift() as [string, string]
            for (const target of imports.Of(file))
            {
                const targetHome = B.Assignment.Homes[target]
                if (support.has(target))
                {
                    if (!seen.has(target))
                    {
                        seen.add(target)
                        queue.push([target, home])
                    }
                    continue
                }
                if (targetHome === undefined || !targetHome.startsWith(B.SharedPrefix))
                {
                    crossings.push(file + ' (' + home + ') -> ' + target + ' (' + (targetHome ?? 'untracked') + ')')
                }
            }
        }
        assert.deepEqual(crossings, [])
    })
})
