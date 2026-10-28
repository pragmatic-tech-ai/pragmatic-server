import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FleetPresentation } from '../src/fleet-presentation.js'
import { FleetConnection } from '../src/fleet-view-model.js'
import { PillKind } from '../src/kit/index.js'

describe('FleetPresentation', () =>
{
    it('maps every FleetConnection to the matching PillKind', () =>
    {
        assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Connected), PillKind.Connected)
        assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Quiet), PillKind.Quiet)
        assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Awaiting), PillKind.Awaiting)
    })
})
