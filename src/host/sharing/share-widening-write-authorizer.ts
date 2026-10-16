import type { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { IWriteAuthorizer } from '../cypher/read-filter-source.js'
import type { ShareGrantIndex } from './share-grant-index.js'

/** Coarse write-OR: a share granting the action on ANY record of the concept lets the op past the per-concept gate. */
export class ShareWideningWriteAuthorizer implements IWriteAuthorizer
{
    constructor(private readonly inner: IWriteAuthorizer, private readonly index: ShareGrantIndex)
    {
    }

    public Allows(concept: string, action: PrivilegeAction): boolean
    {
        return this.inner.Allows(concept, action) || this.index.HasAnyGrant(concept, action)
    }
}
