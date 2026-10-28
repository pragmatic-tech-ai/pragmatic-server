import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FleetPresentation } from '../src/fleet-presentation.js'
import { FleetConnection } from '../src/fleet-view-model.js'
import type { FleetHiveDto } from '../src/portal-types.js'
import { PillKind } from '../src/kit/index.js'

describe('FleetPresentation', () =>
{
    it('maps every FleetConnection to the matching PillKind', () =>
    {
        assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Connected), PillKind.Connected)
        assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Quiet), PillKind.Quiet)
        assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Awaiting), PillKind.Awaiting)
    })

    it('OwnerLabel joins client and tenant, falls back to the present one, then unassigned', () =>
    {
        const hive = (client: string | null, tenant: string | null): FleetHiveDto => ({
            client: client ? { id: 'c', displayName: client } : null,
            tenant: tenant ? { id: 't', displayName: tenant } : null,
        }) as FleetHiveDto
        assert.equal(FleetPresentation.OwnerLabel(hive('Client', 'Tenant')), 'Client / Tenant')
        assert.equal(FleetPresentation.OwnerLabel(hive('Client', null)), 'Client')
        assert.equal(FleetPresentation.OwnerLabel(hive(null, 'Tenant')), 'Tenant')
        assert.equal(FleetPresentation.OwnerLabel(hive(null, null)), '(unassigned)')
    })
})
