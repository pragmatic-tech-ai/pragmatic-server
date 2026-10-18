import type { Cypher, IInstanceView, Scalar } from '@pragmatic-tech-ai/todl'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { IWriteInstanceGate } from './write-instance-gate.js'
import { ReflectedView } from './reflected-view.js'

/** A write was denied. Carries only the concept / action / field NAME - never a field value or secret. */
export class WriteAuthorizationError extends Error
{
    private static readonly ErrorName = 'WriteAuthorizationError'
    private static readonly Prefix = 'Write not authorized: '
    private static readonly Unaddressable = 'target node is not addressable'
    private static readonly FieldSuffix = ' (field '

    constructor(public readonly Concept: string | undefined, public readonly Action: PrivilegeAction | undefined, public readonly Field?: string)
    {
        super(WriteAuthorizationError.Describe(Concept, Action, Field))
        this.name = WriteAuthorizationError.ErrorName
    }

    private static Describe(concept: string | undefined, action: PrivilegeAction | undefined, field: string | undefined): string
    {
        if (concept === undefined || action === undefined) return WriteAuthorizationError.Prefix + WriteAuthorizationError.Unaddressable
        const base = WriteAuthorizationError.Prefix + String(action) + ' on ' + concept
        return field === undefined ? base : base + WriteAuthorizationError.FieldSuffix + field + ')'
    }
}

/** The in-flight view of a node created this query (payload + later SETs). */
class PayloadView implements IInstanceView
{
    private readonly fields: Map<string, Scalar>

    constructor(public readonly Concept: string, initial: ReadonlyMap<string, Scalar>)
    {
        this.fields = new Map(initial)
    }

    public Field(name: string): Scalar | undefined
    {
        return this.fields.get(name)
    }

    public Set(name: string, value: Scalar): void
    {
        this.fields.set(name, value)
    }

    public Remove(name: string): void
    {
        this.fields.delete(name)
    }
}

/** Decorates a writer so every op is authorized through the (synchronous) write gate before delegating. */
export class AuthorizingCypherWriter implements Cypher.ICypherWriter
{
    private readonly created = new Map<string, PayloadView>()

    constructor(
        private readonly inner: Cypher.ICypherWriter,
        private readonly gate: IWriteInstanceGate,
        private readonly graph: Cypher.ICypherGraph)
    {
    }

    public CreateNode(concept: string, properties: ReadonlyMap<string, Scalar>): string
    {
        // CreateDefaults fields are system-stamped: intentionally NOT subject to CanWriteField (only the caller's explicit props are checked), matching the connector/app write path.
        const merged = new Map<string, Scalar>(properties)
        for (const d of this.gate.CreateDefaults(concept)) merged.set(d.field, d.value)
        const view = new PayloadView(concept, merged)
        if (!this.gate.Authorize(PrivilegeAction.Create, view)) throw new WriteAuthorizationError(concept, PrivilegeAction.Create)
        for (const field of properties.keys())
        {
            if (!this.gate.CanWriteField(concept, field, PrivilegeAction.Create)) throw new WriteAuthorizationError(concept, PrivilegeAction.Create, field)
        }
        const id = this.inner.CreateNode(concept, properties)
        this.created.set(id, view)
        return id
    }

    public SetProperty(nodeId: string, name: string, value: Scalar): void
    {
        // The tracked created-node view is updated AFTER the delegated write: the op is authorized against the current (pre-write) state, later ops see the new value.
        this.AuthorizeUpdate(nodeId, name)
        this.inner.SetProperty(nodeId, name, value)
        this.created.get(nodeId)?.Set(name, value)
    }

    public RemoveProperty(nodeId: string, name: string): void
    {
        // Tracked view updated AFTER the delegated write (authorized against pre-write state).
        this.AuthorizeUpdate(nodeId, name)
        this.inner.RemoveProperty(nodeId, name)
        this.created.get(nodeId)?.Remove(name)
    }

    public CreateRelationship(fromId: string, member: string, toId: string): boolean
    {
        this.AuthorizeLink(fromId, member, toId)
        return this.inner.CreateRelationship(fromId, member, toId)
    }

    public DeleteRelationship(fromId: string, member: string, toId: string): boolean
    {
        this.AuthorizeLink(fromId, member, toId)
        return this.inner.DeleteRelationship(fromId, member, toId)
    }

    public DeleteNode(nodeId: string, detach: boolean): void
    {
        const view = this.Resolve(nodeId)
        if (!this.gate.Authorize(PrivilegeAction.Delete, view)) throw new WriteAuthorizationError(view.Concept, PrivilegeAction.Delete)
        this.inner.DeleteNode(nodeId, detach)
    }

    public Begin(): void
    {
        this.inner.Begin()
    }

    public Commit(): Cypher.ICypherGraph
    {
        return this.inner.Commit()
    }

    public Rollback(): void
    {
        this.inner.Rollback()
    }

    public Stats(): Cypher.CypherWriteStats
    {
        return this.inner.Stats()
    }

    private AuthorizeUpdate(nodeId: string, field: string): IInstanceView
    {
        const view = this.Resolve(nodeId)
        if (!this.gate.Authorize(PrivilegeAction.Update, view)) throw new WriteAuthorizationError(view.Concept, PrivilegeAction.Update)
        if (!this.gate.CanWriteField(view.Concept, field, PrivilegeAction.Update)) throw new WriteAuthorizationError(view.Concept, PrivilegeAction.Update, field)
        return view
    }

    private AuthorizeLink(fromId: string, member: string, toId: string): void
    {
        const source = this.Resolve(fromId)
        if (!this.gate.Authorize(PrivilegeAction.Update, source)) throw new WriteAuthorizationError(source.Concept, PrivilegeAction.Update)
        // a reference member is a field like any other: field security applies to setting/clearing it via an edge, same as SET
        if (!this.gate.CanWriteField(source.Concept, member, PrivilegeAction.Update)) throw new WriteAuthorizationError(source.Concept, PrivilegeAction.Update, member)
        if (!this.created.has(toId) && this.graph.Reflect(toId) === undefined) throw new WriteAuthorizationError(undefined, undefined)
    }

    /** Created-this-query first (the read graph cannot see it yet), else the read-filtered graph; absent/hidden is unaddressable. */
    private Resolve(nodeId: string): IInstanceView
    {
        const made = this.created.get(nodeId)
        if (made !== undefined) return made
        const mirror = this.graph.Reflect(nodeId)
        if (mirror === undefined) throw new WriteAuthorizationError(undefined, undefined)
        const view = ReflectedView.Of(mirror)
        if (view === undefined) throw new WriteAuthorizationError(undefined, undefined)
        return view
    }
}
