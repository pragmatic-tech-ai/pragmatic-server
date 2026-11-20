import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import { ReleaseApp } from '../../../admin/control-plane/release/release-tag.js'
import { SplitHome } from '../assignment-rules.js'
import { ReachReport, SplitAssignment } from '../reach-report.js'

/** The container line: what each image's entry points reach, measured once. */
class Boundaries
{
    public static readonly Root = join(import.meta.dirname, '..', '..', '..')
    public static readonly SharedPrefix = 'pragmatic-shared/'
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

    it('no image\'s closure reaches another image\'s own files (only its own and shared packages)', () =>
    {
        const crossings: string[] = []
        for (const [app, entries] of ReachReport.Entries)
        {
            const own = Boundaries.HomeOf(app)
            for (const file of new Set(entries.flatMap(entry => [...(Boundaries.Reach.get(entry) ?? [])])))
            {
                const home = Boundaries.Assignment.Homes[file]
                if (home !== own && !home.startsWith(Boundaries.SharedPrefix))
                {
                    crossings.push(app + ' -> ' + file + ' (' + home + ')')
                }
            }
        }
        assert.deepEqual(crossings, [])
    })
})
