import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InfraTargetMode, InfraTargetModes } from '../infra-target-mode.js'

class ModeFixture
{
    public static readonly Setting = 'PRAGMATIC_ADMIN_INFRA_TARGET'
}

describe('InfraTargetModes.Parse', () =>
{
    it('defaults to local when unset or blank, so the laptop is unchanged', () =>
    {
        assert.equal(InfraTargetModes.Parse({}), InfraTargetMode.Local)
        assert.equal(InfraTargetModes.Parse({ [ModeFixture.Setting]: '' }), InfraTargetMode.Local)
        assert.equal(InfraTargetModes.Parse({ [ModeFixture.Setting]: 'local' }), InfraTargetMode.Local)
    })

    it('reads none, trimmed and case-insensitive', () =>
    {
        assert.equal(InfraTargetModes.Parse({ [ModeFixture.Setting]: 'none' }), InfraTargetMode.None)
        assert.equal(InfraTargetModes.Parse({ [ModeFixture.Setting]: ' NONE ' }), InfraTargetMode.None)
    })

    it('refuses any other value, naming the setting', () =>
    {
        assert.throws(() => InfraTargetModes.Parse({ [ModeFixture.Setting]: 'docker' }), /PRAGMATIC_ADMIN_INFRA_TARGET/)
    })
})
