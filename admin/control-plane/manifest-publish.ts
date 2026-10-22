/**
 * Publishes a platform-version manifest into the PlatformDeploymentRegistry (local dogfood path).
 *
 *   npx tsx admin/control-plane/manifest-publish.ts --version <v> --image <image> [--notes <text>]
 *
 * Writes to the same data root the control-plane server uses. A manifest carries no secret.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { ClientRegistry } from './client-registry.js'
import { DockerEnvAdapter } from './docker-env-port.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { GatingRegistry } from './gating-record.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { HiveRegistry } from './hive-registry.js'
import { ManifestRegistry } from './manifest-record.js'
import { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { RolloutReportRegistry } from './rollout-report-record.js'
import { SelectionRegistry } from './selection-record.js'
import { TenantRegistry } from './tenant-registry.js'

export interface ParsedPublishArgs
{
    version: string
    image: string
    notes?: string
}

export class ManifestPublishUsageError extends Error
{
}

export class ManifestPublish
{
    private static readonly VersionFlag = '--version'
    private static readonly ImageFlag = '--image'
    private static readonly NotesFlag = '--notes'
    private static readonly FlagPrefix = '--'
    private static readonly UsageMessage = 'usage: manifest-publish --version <version> --image <image> [--notes <text>]'
    private static readonly MissingPrefix = 'missing '
    private static readonly MissingValuePrefix = 'missing value for '
    private static readonly UsageSep = '; '
    private static readonly DataDir = 'data'
    private static readonly RegistryFile = 'registry.json'
    private static readonly ClientsFile = 'clients.json'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly ManifestsFile = 'manifests.json'
    private static readonly GatingFile = 'gating.json'
    private static readonly SelectionsFile = 'selections.json'
    private static readonly ReportsFile = 'rollout-reports.json'
    private static readonly RegistrationsFile = 'rollout-registrations.json'
    private static readonly PublishedPrefix = 'published manifest '
    private static readonly ImageSep = ' -> '

    /** Parses argv (already stripped of node and script path); throws a usage error on a missing flag or value. */
    public static ParseArgs(argv: readonly string[]): ParsedPublishArgs
    {
        const version = ManifestPublish.FlagValue(argv, ManifestPublish.VersionFlag)
        if (version === undefined)
        {
            throw ManifestPublish.Usage(ManifestPublish.MissingPrefix + ManifestPublish.VersionFlag)
        }
        const image = ManifestPublish.FlagValue(argv, ManifestPublish.ImageFlag)
        if (image === undefined)
        {
            throw ManifestPublish.Usage(ManifestPublish.MissingPrefix + ManifestPublish.ImageFlag)
        }
        const parsed: ParsedPublishArgs = { version, image }
        const notes = ManifestPublish.FlagValue(argv, ManifestPublish.NotesFlag)
        if (notes !== undefined)
        {
            parsed.notes = notes
        }
        return parsed
    }

    private static FlagValue(argv: readonly string[], flag: string): string | undefined
    {
        const at = argv.indexOf(flag)
        if (at < 0)
        {
            return undefined
        }
        const value = argv[at + 1]
        if (value === undefined || value.startsWith(ManifestPublish.FlagPrefix))
        {
            throw ManifestPublish.Usage(ManifestPublish.MissingValuePrefix + flag)
        }
        return value
    }

    private static Usage(reason: string): ManifestPublishUsageError
    {
        return new ManifestPublishUsageError(reason + ManifestPublish.UsageSep + ManifestPublish.UsageMessage)
    }

    /** Composes the real registry over the control-plane data root (same wiring as server.ts, minus Docker reconcile). */
    public static async Compose(): Promise<PlatformDeploymentRegistry>
    {
        const dataRoot = join(dirname(fileURLToPath(import.meta.url)), ManifestPublish.DataDir)
        mkdirSync(dataRoot, { recursive: true })
        const environments = new EnvironmentRegistry(join(dataRoot, ManifestPublish.RegistryFile), new DockerEnvAdapter(new DockerEnv()))
        await environments.Load()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dataRoot, ManifestPublish.ClientsFile)),
            new TenantRegistry(join(dataRoot, ManifestPublish.TenantsFile)),
            new HiveRegistry(join(dataRoot, ManifestPublish.HivesFile)),
            environments)
        await directory.Load()
        const manifests = new ManifestRegistry(join(dataRoot, ManifestPublish.ManifestsFile))
        const gating = new GatingRegistry(join(dataRoot, ManifestPublish.GatingFile))
        const selections = new SelectionRegistry(join(dataRoot, ManifestPublish.SelectionsFile))
        const reports = new RolloutReportRegistry(join(dataRoot, ManifestPublish.ReportsFile))
        const registrations = new RolloutRegistrationRegistry(join(dataRoot, ManifestPublish.RegistrationsFile))
        await Promise.all([manifests.Load(), gating.Load(), selections.Load(), reports.Load(), registrations.Load()])
        return new PlatformDeploymentRegistry(manifests, gating, selections, reports, registrations, directory, new HiveOrchestratorFactory(), environments, new EnvironmentPlacement(directory))
    }

    public static async Main(argv: readonly string[]): Promise<void>
    {
        const args = ManifestPublish.ParseArgs(argv)
        const registry = await ManifestPublish.Compose()
        const record = await registry.Publish(args.version, args.image, args.notes)
        console.log(ManifestPublish.PublishedPrefix + record.id + ManifestPublish.ImageSep + record.image)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (ManifestPublish.IsEntryPoint())
{
    try
    {
        await ManifestPublish.Main(process.argv.slice(2))
        process.exit(0)
    }
    catch (err)
    {
        process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n')
        process.exit(1)
    }
}
