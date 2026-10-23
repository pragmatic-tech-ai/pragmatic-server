// Standalone one-shot migrator (SP-HIVE-6c). Run ONCE against an existing data root BEFORE starting the
// renamed control-plane. It is NOT part of `npm test` (the class is unit-tested; nothing runs on import).
//
// Only the literal persisted FIELD `tenantId` -> `environmentId` changes. Directory names, JSON map keys and
// secret-ref strings are keyed by the id VALUE and are untouched. The bundle's tenant-config.json carries
// the id only as a map key (no literal tenantId field), so it needs no migration.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export class EnvironmentIdMigrator
{
    private static readonly RegistryFile = 'registry.json'
    private static readonly RootKey = 'environments'
    private static readonly LegacyField = 'tenantId'
    private static readonly NewField = 'environmentId'
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2

    public async Migrate(dataRoot: string): Promise<{ changed: number }>
    {
        const path = join(dataRoot, EnvironmentIdMigrator.RegistryFile)
        let text: string
        try
        {
            text = await readFile(path, EnvironmentIdMigrator.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === EnvironmentIdMigrator.NotFoundCode)
            {
                return { changed: 0 }
            }
            throw err
        }
        const parsed = JSON.parse(text) as Record<string, Record<string, Record<string, unknown>> | undefined>
        const envs = parsed[EnvironmentIdMigrator.RootKey]
        if (!envs)
        {
            return { changed: 0 }
        }
        let changed = 0
        for (const [name, record] of Object.entries(envs))
        {
            const migrated = EnvironmentIdMigrator.MigrateRecord(record)
            if (migrated !== record)
            {
                envs[name] = migrated
                changed++
            }
        }
        if (changed > 0)
        {
            const temp = `${path}.${randomUUID()}${EnvironmentIdMigrator.TempSuffix}`
            await writeFile(temp, JSON.stringify(parsed, null, EnvironmentIdMigrator.JsonIndent), EnvironmentIdMigrator.Encoding)
            await rename(temp, path)
        }
        return { changed }
    }

    /**
     * Heuristic: a record with `tenantId` and NO `environmentId` is the legacy env-scope field. Post-Task-3
     * records always carry `environmentId`, so a platform `tenantId` never appears without it and is safe.
     * Returns the same instance when nothing changes; key order is preserved.
     */
    private static MigrateRecord(record: Record<string, unknown>): Record<string, unknown>
    {
        if (!(EnvironmentIdMigrator.LegacyField in record) || EnvironmentIdMigrator.NewField in record)
        {
            return record
        }
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(record))
        {
            out[key === EnvironmentIdMigrator.LegacyField ? EnvironmentIdMigrator.NewField : key] = value
        }
        return out
    }
}
