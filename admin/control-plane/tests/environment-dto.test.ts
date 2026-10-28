import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EnvironmentDtoMapper } from '../environment-dto.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'

class DtoFixture
{
    public static readonly Repo = 't/northwind'
    public static readonly ArtifactTag = 'northwind-1.0.0'
    public static readonly Digest = 'sha256:DEADBEEF-SENTINEL'
    public static readonly BaseDomain = 'apps.example.com'

    public static Plain(): EnvironmentRecord
    {
        return {
            name: 'prod',
            type: EnvType.Runtime,
            template: Template.RuntimePostgres,
            environmentId: 'env-prod',
            hostPort: 4100,
            createdAt: '2026-10-28T00:00:00.000Z',
            status: EnvStatus.Running
        }
    }

    public static Full(): EnvironmentRecord
    {
        return {
            ...DtoFixture.Plain(),
            idpBaseDomain: DtoFixture.BaseDomain,
            appDeployment: {
                appName: 'northwind',
                appVersion: '1.0.0',
                repo: DtoFixture.Repo,
                artifactTag: DtoFixture.ArtifactTag,
                manifestDigest: DtoFixture.Digest
            }
        }
    }
}

test('ToDto exposes uiBundle identity and idpBaseDomain', () =>
{
    const dto = EnvironmentDtoMapper.ToDto(DtoFixture.Full())
    assert.deepEqual(dto.uiBundle, { appName: 'northwind', appVersion: '1.0.0' })
    assert.equal(dto.idpBaseDomain, DtoFixture.BaseDomain)
})

test('ToDto never leaks registry coordinates', () =>
{
    const wire = JSON.stringify(EnvironmentDtoMapper.ToDto(DtoFixture.Full()))
    assert.ok(!wire.includes(DtoFixture.Repo))
    assert.ok(!wire.includes(DtoFixture.ArtifactTag))
    assert.ok(!wire.includes(DtoFixture.Digest))
})

test('ToDto omits uiBundle without appDeployment', () =>
{
    assert.equal(EnvironmentDtoMapper.ToDto(DtoFixture.Plain()).uiBundle, undefined)
})

test('ToDto omits idpBaseDomain when unset', () =>
{
    assert.equal(EnvironmentDtoMapper.ToDto(DtoFixture.Plain()).idpBaseDomain, undefined)
})

test('ToDto keeps existing fields unchanged', () =>
{
    const dto = EnvironmentDtoMapper.ToDto(DtoFixture.Plain())
    assert.equal(dto.name, 'prod')
    assert.equal(dto.status, EnvStatus.Running)
    assert.equal(dto.httpUrl.includes('4100'), true)
    assert.equal(typeof dto.wsUrl, 'string')
    assert.equal('uiBundle' in dto, false)
})
