import type { IGraphQuery, IInstanceMirror, FieldView, ReflectedNode, TypeInfo, TermInfo } from '@pragmatic-tech-ai/todl/graph-api'
import type { Scalar } from '@pragmatic-tech-ai/todl'

/** Per-request field read authorizer, principal-bound. */
export interface IFieldReadMask
{
    CanRead(concept: string, field: string): boolean
}

/** No identity / no field security: every field is readable. */
export class AllowAllFieldReadMask implements IFieldReadMask
{
    public static readonly Instance = new AllowAllFieldReadMask()

    public CanRead(): boolean
    {
        return true
    }
}

/** Wraps a mirror so denied scalar fields read as absent (field()/fields() and the raw node.attrs). */
export class MaskedMirror implements IInstanceMirror
{
    constructor(private readonly inner: IInstanceMirror, private readonly mask: IFieldReadMask) {}

    public get type(): TypeInfo
    {
        return this.inner.type
    }

    public get class(): TermInfo | undefined
    {
        return this.inner.class
    }

    public get node(): ReflectedNode
    {
        const concept = this.inner.type?.fullName
        const source = this.inner.node
        if (concept === undefined)
        {
            return source
        }
        const attrs: Record<string, Scalar> = {}
        for (const key of Object.keys(source.attrs))
        {
            if (this.mask.CanRead(concept, key))
            {
                attrs[key] = source.attrs[key]
            }
        }
        return { ...source, attrs }
    }

    public field(name: string): FieldView | undefined
    {
        const concept = this.inner.type?.fullName
        if (concept !== undefined && !this.mask.CanRead(concept, name))
        {
            return undefined
        }
        return this.inner.field(name)
    }

    public fields(): FieldView[]
    {
        const concept = this.inner.type?.fullName
        if (concept === undefined)
        {
            return this.inner.fields()
        }
        return this.inner.fields().filter(fv => this.mask.CanRead(concept, fv.field.name))
    }
}

/** Outermost read decorator: masks every mirror the inner graph returns. Schema queries pass through. */
export class FieldMaskedGraphQuery implements IGraphQuery
{
    constructor(private readonly inner: IGraphQuery, private readonly mask: IFieldReadMask) {}

    public Concepts(): ReturnType<IGraphQuery['Concepts']> { return this.inner.Concepts() }
    public Type(name: string): ReturnType<IGraphQuery['Type']> { return this.inner.Type(name) }
    public Term(id: string): ReturnType<IGraphQuery['Term']> { return this.inner.Term(id) }
    public Narrower(termId: string): ReturnType<IGraphQuery['Narrower']> { return this.inner.Narrower(termId) }
    public Broader(termId: string): ReturnType<IGraphQuery['Broader']> { return this.inner.Broader(termId) }
    public Descendants(termId: string): ReturnType<IGraphQuery['Descendants']> { return this.inner.Descendants(termId) }
    public Ancestors(termId: string): ReturnType<IGraphQuery['Ancestors']> { return this.inner.Ancestors(termId) }
    public IconKey(typeId: string): string | undefined { return this.inner.IconKey(typeId) }

    public InstancesOf(conceptId: string): IInstanceMirror[]
    {
        return this.inner.InstancesOf(conceptId).map(m => this.Wrap(m))
    }

    public Reflect(id: string): IInstanceMirror | undefined
    {
        const mirror = this.inner.Reflect(id)
        return mirror === undefined ? undefined : this.Wrap(mirror)
    }

    public Refs(id: string, member: string): IInstanceMirror[]
    {
        return this.inner.Refs(id, member).map(m => this.Wrap(m))
    }

    public Referrers(id: string, member?: string): IInstanceMirror[]
    {
        return this.inner.Referrers(id, member).map(m => this.Wrap(m))
    }

    public Search(text: string): IInstanceMirror[]
    {
        return this.inner.Search(text).map(m => this.Wrap(m))
    }

    public AllInstances(): IInstanceMirror[]
    {
        return this.inner.AllInstances().map(m => this.Wrap(m))
    }

    private Wrap(mirror: IInstanceMirror): IInstanceMirror
    {
        return new MaskedMirror(mirror, this.mask)
    }
}
