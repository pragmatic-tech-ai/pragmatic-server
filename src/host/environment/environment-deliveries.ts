import type { PackageRef } from '@pragmatic-tech-ai/todl/domain'
import { DeliveryChannel } from '@pragmatic-tech-ai/todl/engine'
import type { IPackageDelivery } from '@pragmatic-tech-ai/todl/engine'
import type { PragmaticAppsRegistry } from '../apps/pragmatic-apps-registry.js'
import type { PromoteRecordStore } from './promote-record-store.js'

/**
 * One delivery a deploy or promote is about to make: an app's (Deploy, name = the app name) or the promote set's
 * (Promote, name = the record name) packages.
 */
export type DeliveryChange = {
    readonly Channel: DeliveryChannel
    readonly Name: string
    readonly Packages: readonly Required<PackageRef>[]
}

/**
 * Where a deploy or promote hands its change (ruling S4): validates the prospective delivery set, runs `persist` (the
 * app live pointer or the promote record) only when it composes, then redelivers. Implemented by EnvironmentEngineHost.
 */
export interface IDeliveryGate
{
    Deliver<T>(change: DeliveryChange, persist: () => Promise<T>): Promise<T>
}

/**
 * The package sets a runtime environment holds (ruling S3): one Deploy delivery per app with a `live` pointer (name =
 * the app name, packages = that version's `application.json` packages) plus, when the promote record exists, one
 * Promote delivery (name = the record's `name`, packages = its `packages`). Sorted Deploy before Promote, then by name.
 * Read from storage on every call: the persisted pointers and the record are the only state.
 */
export class EnvironmentDeliveries
{
    public constructor(private readonly apps: PragmaticAppsRegistry, private readonly promote: PromoteRecordStore)
    {
    }

    public async Current(): Promise<readonly IPackageDelivery[]>
    {
        const deliveries: IPackageDelivery[] = []
        for (const app of await this.apps.LiveApplications())
        {
            deliveries.push({ Channel: DeliveryChannel.Deploy, Name: app.Manifest.name, Packages: EnvironmentDeliveries.Refs(app.Manifest.packages) })
        }
        const record = await this.promote.Read()
        if (record !== null)
        {
            deliveries.push({ Channel: DeliveryChannel.Promote, Name: record.name, Packages: EnvironmentDeliveries.Refs(record.packages) })
        }
        return EnvironmentDeliveries.Sorted(deliveries)
    }

    /**
     * The prospective deliveries once `change` is made: a Deploy replaces the same-named app's delivery; a Promote
     * replaces the promote set whatever its name (the environment holds one promote record, which a promote
     * overwrites).
     */
    public async With(change: DeliveryChange): Promise<readonly IPackageDelivery[]>
    {
        const kept = (await this.Current()).filter(delivery => !EnvironmentDeliveries.Replaces(change, delivery))
        const added: IPackageDelivery = { Channel: change.Channel, Name: change.Name, Packages: change.Packages.map(ref => ({ model: ref.model, version: ref.version })) }
        return EnvironmentDeliveries.Sorted([...kept, added])
    }

    private static Replaces(change: DeliveryChange, delivery: IPackageDelivery): boolean
    {
        if (delivery.Channel !== change.Channel) return false
        return change.Channel === DeliveryChannel.Promote || delivery.Name === change.Name
    }

    private static Refs(packages: readonly { readonly id: string; readonly version: string }[]): Required<PackageRef>[]
    {
        return packages.map(ref => ({ model: ref.id, version: ref.version }))
    }

    private static Sorted(deliveries: IPackageDelivery[]): readonly IPackageDelivery[]
    {
        return deliveries.sort((a, b) => a.Channel - b.Channel || (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0))
    }
}
