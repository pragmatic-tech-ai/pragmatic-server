import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PinnedImageVerifier, InvalidVerifiedImagesError } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { HiveRecord } from './platform-records.js'
import { RecordSlot, type IRecordMap } from './record-map.js'
import { SeededTenantDirectory, type TenantDirectorySeed } from './tenant-api/seeded-tenant-directory.js'

/** Neither a delivered seed.json nor a stored seed: the console cannot know its tenant. */
export class ConsoleSeedMissingError extends Error
{
    private static readonly ErrorName = 'ConsoleSeedMissingError'
    private static readonly Prefix = 'Tenant-admin seed not found: no stored seed and no file '

    public constructor(path: string)
    {
        super(ConsoleSeedMissingError.Prefix + path)
        this.name = ConsoleSeedMissingError.ErrorName
    }
}

/** A seed (delivered or stored) that is not `{ tenant, hives[] }` with well-formed hives. */
export class ConsoleSeedInvalidError extends Error
{
    private static readonly ErrorName = 'ConsoleSeedInvalidError'

    public constructor(message: string)
    {
        super(message)
        this.name = ConsoleSeedInvalidError.ErrorName
    }
}

/**
 * What the platform delivers to an in-hive console: its directory seed (`seed.json`: the tenant, its hives, its
 * organisation) and the image refs it may run (`verified-images.json`), both copied into the data root from the seed
 * Secret at every start. A delivery found at start is validated and stored (the newest delivery wins); a start without one
 * serves the stored copy, so the console's database is where these records live and the files are only the inbound
 * channel. Neither is secret.
 */
export class ConsoleDelivery
{
    public static readonly SeedFile = 'seed.json'
    public static readonly VerifiedImagesFile = 'verified-images.json'
    /** The record keys of the stored copies. */
    public static readonly SeedKey = 'seed'
    public static readonly ImagesKey = 'images'
    private static readonly Utf8 = 'utf8'
    private static readonly BadSeedMessage = 'Invalid seed: expected { tenant, hives[] }'
    private static readonly BadHiveMessage = 'Invalid seed: every hive needs string id, tenantId, displayName, createdAt and object cluster, registry'
    private static readonly HiveStringFields = ['id', 'tenantId', 'displayName', 'createdAt'] as const
    private static readonly HiveObjectFields = ['cluster', 'registry'] as const
    private static readonly EmptyString = ''

    /** The directory seed: the delivered file when present (stored), else the stored one; neither throws ConsoleSeedMissingError. */
    public static async Seed(dataRoot: string, stored: IRecordMap<unknown>): Promise<SeededTenantDirectory>
    {
        const path = join(dataRoot, ConsoleDelivery.SeedFile)
        const slot = RecordSlot.Of<unknown>(stored, ConsoleDelivery.SeedKey)
        let seed: TenantDirectorySeed
        if (existsSync(path))
        {
            seed = ConsoleDelivery.SeedOf(ConsoleDelivery.ParseFile(path))
            await slot.Write(seed)
        }
        else
        {
            const kept = await slot.Read()
            if (kept === undefined)
            {
                throw new ConsoleSeedMissingError(path)
            }
            seed = ConsoleDelivery.SeedOf(kept)
        }
        return new SeededTenantDirectory(seed)
    }

    /** The verified-image allow-list: the delivered file when present (stored), else the stored one, else none (refuses all). */
    public static async VerifiedImages(dataRoot: string, stored: IRecordMap<unknown>): Promise<PinnedImageVerifier>
    {
        const path = join(dataRoot, ConsoleDelivery.VerifiedImagesFile)
        const slot = RecordSlot.Of<unknown>(stored, ConsoleDelivery.ImagesKey)
        if (existsSync(path))
        {
            const images = PinnedImageVerifier.ImagesIn(ConsoleDelivery.ParseImages(path), path)
            await slot.Write(images)
            return new PinnedImageVerifier(images)
        }
        const kept = await slot.Read()
        return new PinnedImageVerifier(kept === undefined ? [] : PinnedImageVerifier.ImagesIn(kept, slot.Location))
    }

    /** A seed value, validated: `{ tenant: { id }, hives: [well-formed hive] }` (organisation kept when a string). */
    public static SeedOf(value: unknown): TenantDirectorySeed
    {
        const seed = value as Partial<TenantDirectorySeed> | null
        if (seed === null || typeof seed !== 'object' || seed.tenant === undefined || typeof seed.tenant.id !== 'string' || !Array.isArray(seed.hives))
        {
            throw new ConsoleSeedInvalidError(ConsoleDelivery.BadSeedMessage)
        }
        if (!seed.hives.every(h => ConsoleDelivery.IsHive(h)))
        {
            throw new ConsoleSeedInvalidError(ConsoleDelivery.BadHiveMessage)
        }
        const result: { tenant: TenantDirectorySeed['tenant']; hives: readonly HiveRecord[]; organisation?: string } = { tenant: seed.tenant, hives: seed.hives }
        if (typeof seed.organisation === 'string')
        {
            result.organisation = seed.organisation
        }
        return result
    }

    private static ParseFile(path: string): unknown
    {
        try
        {
            return JSON.parse(readFileSync(path, ConsoleDelivery.Utf8)) as unknown
        }
        catch
        {
            throw new ConsoleSeedInvalidError(ConsoleDelivery.BadSeedMessage)
        }
    }

    private static ParseImages(path: string): unknown
    {
        try
        {
            return JSON.parse(readFileSync(path, ConsoleDelivery.Utf8)) as unknown
        }
        catch
        {
            throw new InvalidVerifiedImagesError(path)
        }
    }

    /** True when the value is a well-formed HiveRecord: required string fields non-empty, cluster/registry objects. */
    private static IsHive(value: unknown): boolean
    {
        if (value === null || typeof value !== 'object')
        {
            return false
        }
        const rec = value as Record<string, unknown>
        return ConsoleDelivery.HiveStringFields.every(f => typeof rec[f] === 'string' && rec[f] !== ConsoleDelivery.EmptyString)
            && ConsoleDelivery.HiveObjectFields.every(f => typeof rec[f] === 'object' && rec[f] !== null)
    }
}
