import { join } from 'node:path'
import { ManifestRegistry } from '../manifest-record.js'
import { GatingRegistry } from '../gating-record.js'
import { SelectionRegistry } from '../selection-record.js'
import { RolloutReportRegistry } from '../rollout-report-record.js'
import { RolloutRegistrationRegistry } from '../rollout-registration-record.js'
import { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { EnvironmentPlacement } from '../environment-placement.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { PlatformDirectory } from '../platform-directory.js'

/** Test support: composes a real PlatformDeploymentRegistry over JSON files under a temp directory. */
export class RolloutFixture
{
    private static readonly ManifestsFile = 'manifests.json'
    private static readonly GatingFile = 'gating.json'
    private static readonly SelectionsFile = 'selections.json'
    private static readonly ReportsFile = 'rollout-reports.json'
    private static readonly RegistrationsFile = 'rollout-registrations.json'

    public static async Create(dir: string, directory: PlatformDirectory, orchestrators: HiveOrchestratorFactory): Promise<PlatformDeploymentRegistry>
    {
        const manifests = new ManifestRegistry(join(dir, RolloutFixture.ManifestsFile))
        const gating = new GatingRegistry(join(dir, RolloutFixture.GatingFile))
        const selections = new SelectionRegistry(join(dir, RolloutFixture.SelectionsFile))
        const reports = new RolloutReportRegistry(join(dir, RolloutFixture.ReportsFile))
        const registrations = new RolloutRegistrationRegistry(join(dir, RolloutFixture.RegistrationsFile))
        await Promise.all([manifests.Load(), gating.Load(), selections.Load(), reports.Load(), registrations.Load()])
        return new PlatformDeploymentRegistry(manifests, gating, selections, reports, registrations, directory, orchestrators, { List: () => [] }, new EnvironmentPlacement(directory))
    }
}
