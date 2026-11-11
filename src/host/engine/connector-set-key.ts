import type { ExternalIdentity, IExternalConnectorPlan } from '@pragmatic-tech-ai/todl/engine'

/**
 * The identity of an engine's external connector set (ruling S2's reopen rule): equal keys mean the connectors an
 * engine was opened with still serve the new snapshot, so the host upgrades in place; a different key reopens (an
 * engine's connectors are fixed at Open). The key is the canonical JSON (object keys sorted) of each plan's `Name`,
 * `Spec` and `Bindings`, plans sorted by name, and, with `identity`, of every bound member the connectors resolve
 * through it (the member each field map entry names, as the identity finds it on the concept, its ancestors or
 * aspects).
 *
 * Wider than S2's "Name and Spec": a `DataSourceConnector` captures its plan's bindings and the member shapes it reads
 * at construction, so a binding added to an unchanged connector, or a bound member whose type changed, must reopen
 * too or the running connector would serve the old shapes.
 */
export class ConnectorSetKey
{
    private constructor()
    {
    }

    public static Of(plans: readonly IExternalConnectorPlan[], identity?: ExternalIdentity): string
    {
        const sorted = [...plans].sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0))
        return ConnectorSetKey.Canonical(sorted.map(plan => ({
            Name: plan.Name,
            Spec: plan.Spec,
            Bindings: plan.Bindings,
            Members: identity === undefined ? null : plan.Bindings.map(binding => ConnectorSetKey.MembersOf(binding, identity)),
        })))
    }

    /** The members a binding's field map names, as `identity` resolves them (null where it finds none). */
    private static MembersOf(binding: IExternalConnectorPlan['Bindings'][number], identity: ExternalIdentity): unknown[]
    {
        return Object.keys(binding.Binding.FieldMap).sort().map(member => identity.FindMember(binding.Binding.Concept, member) ?? null)
    }

    /** JSON with every object's keys sorted (arrays keep their order), so equal content gives one string. */
    private static Canonical(value: unknown): string
    {
        return JSON.stringify(value, (_key, raw: unknown) =>
        {
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
            if (raw instanceof Set) return [...raw].sort()
            const sorted: Record<string, unknown> = {}
            for (const key of Object.keys(raw).sort()) sorted[key] = (raw as Record<string, unknown>)[key]
            return sorted
        })
    }
}
