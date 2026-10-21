import { fromJSON, ModelShardExtractor, ConnectorPlanEmitter } from '@pragmatic-tech-ai/todl'
import type { ModelConnectorPlan, ConnectorBinding, ConnectorSpec, PackageDocument } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { PragmaticAppManifest, PragmaticAppPackageRef } from '../apps/pragmatic-app-manifest.js'

/** Reconstructs an application's merged connector plan from its published packages' model.json. */
export class AppConnectorPlan
{
    private static readonly ModelFile = 'model.json'
    private static readonly PathSeparator = '/'
    private static readonly ConflictPrefix = "app '"
    private static readonly ConflictMiddle = "' declares connector '"
    private static readonly ConflictSuffix = "' with conflicting definitions across packages"

    public static async For(storage: IStorage, manifest: PragmaticAppManifest): Promise<ModelConnectorPlan>
    {
        return AppConnectorPlan.ForPackages(storage, manifest.packages, manifest.name, manifest.version)
    }

    public static async ForPackages(storage: IStorage, packages: readonly PragmaticAppPackageRef[], model: string, version: string): Promise<ModelConnectorPlan>
    {
        const connectors: ConnectorSpec[] = []
        const bindings: ConnectorBinding[] = []
        const byIdentity = new Map<string, ConnectorSpec>()
        for (const pkg of packages)
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
                    AppConnectorPlan.AddConnector(connectors, byIdentity, spec, model)
                }
                bindings.push(...plan.Bindings)
            }
        }
        return { Model: model, Version: version, Connectors: connectors, Bindings: bindings }
    }

    // Dedups connectors by their namespace-qualified identity (Id, falling back to the bare Name
    // for hand-written specs). Two connectors that share a bare Name across namespaces have
    // distinct identities and are both kept — their bindings link back by ConnectorId. A repeat
    // of the SAME identity must be the same definition; otherwise packages disagree on what that
    // connector is, so the app is rejected rather than silently binding to whichever came first.
    private static AddConnector(connectors: ConnectorSpec[], byIdentity: Map<string, ConnectorSpec>, spec: ConnectorSpec, appName: string): void
    {
        const identity = spec.Id ?? spec.Name
        const existing = byIdentity.get(identity)
        if (existing === undefined)
        {
            byIdentity.set(identity, spec)
            connectors.push(spec)
            return
        }
        if (!AppConnectorPlan.SameSpec(existing, spec))
        {
            throw new Error(`${AppConnectorPlan.ConflictPrefix}${appName}${AppConnectorPlan.ConflictMiddle}${identity}${AppConnectorPlan.ConflictSuffix}`)
        }
    }

    private static SameSpec(a: ConnectorSpec, b: ConnectorSpec): boolean
    {
        return a.Name === b.Name
            && a.Kind === b.Kind
            && a.Connection === b.Connection
            && a.Secret === b.Secret
            && a.Provider === b.Provider
            && AppConnectorPlan.SameConfig(a.Config, b.Config)
    }

    private static SameConfig(a: Record<string, string>, b: Record<string, string>): boolean
    {
        const keys = Object.keys(a).sort()
        const other = Object.keys(b).sort()
        if (keys.length !== other.length)
        {
            return false
        }
        for (let i = 0; i < keys.length; i++)
        {
            const key = keys[i]!
            if (key !== other[i] || a[key] !== b[key])
            {
                return false
            }
        }
        return true
    }
}
