import { fromJSON, ModelShardExtractor, ConnectorPlanEmitter } from '@pragmatic-tech-ai/todl'
import type { ModelConnectorPlan, ConnectorBinding, ConnectorSpec, PackageDocument } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { PragmaticAppManifest } from '../apps/pragmatic-app-manifest.js'

/** Reconstructs an application's merged connector plan from its published packages' model.json. */
export class AppConnectorPlan
{
    private static readonly ModelFile = 'model.json'
    private static readonly PathSeparator = '/'
    private static readonly PlanVersion = '0.0.0'

    public static async For(storage: IStorage, manifest: PragmaticAppManifest): Promise<ModelConnectorPlan>
    {
        const connectors: ConnectorSpec[] = []
        const bindings: ConnectorBinding[] = []
        const seenConnectors = new Set<string>()
        for (const pkg of manifest.packages)
        {
            const path = [pkg.id, pkg.version, AppConnectorPlan.ModelFile].join(AppConnectorPlan.PathSeparator)
            if (!(await storage.Exists(path)))
            {
                continue
            }
            const doc = JSON.parse(await storage.ReadText(path)) as PackageDocument
            const repo = fromJSON(doc)
            for (const modelId of ModelShardExtractor.ModelsOf(doc))
            {
                const plan = ConnectorPlanEmitter.PlanFor(repo, modelId)
                if (plan === undefined)
                {
                    continue
                }
                for (const spec of plan.Connectors)
                {
                    if (!seenConnectors.has(spec.Name))
                    {
                        seenConnectors.add(spec.Name)
                        connectors.push(spec)
                    }
                }
                bindings.push(...plan.Bindings)
            }
        }
        return { Model: manifest.name, Version: AppConnectorPlan.PlanVersion, Connectors: connectors, Bindings: bindings }
    }
}
