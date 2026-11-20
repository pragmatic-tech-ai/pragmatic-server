import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { SettingType } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDeclarations, type ComponentDeclaration } from '../component-declaration.js'

class DeclarationFixture
{
    public static readonly PackageJson = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json')
    public static readonly Utf8 = 'utf8'

    public static readonly Sample: ComponentDeclaration = {
        name: 'sample-app',
        options: [
            {
                name: 'core',
                description: 'Core.',
                settings: [
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_PORT', default: 8080, description: 'Port.' },
                    { name: 'token', type: SettingType.String, source: 'PRAGMATIC_TOKEN_FILE', required: true, secret: true, description: 'Token.' },
                ],
            },
        ],
        roles: [{ name: 'app.admin', description: 'Admin.' }],
        postgres: true,
        ports: [{ name: 'http', number: 8080 }],
        health: { port: 'http', path: '/healthz' },
    }
}

describe('ComponentDeclarations', () =>
{
    it('declares every descriptor at the server package version', () =>
    {
        const manifest = JSON.parse(readFileSync(DeclarationFixture.PackageJson, DeclarationFixture.Utf8)) as { version: string }
        assert.equal(ComponentDeclarations.Version, manifest.version)
    })

    it('builds options, settings (source as the description prefix), roles, storage, ports and health', () =>
    {
        const descriptor = ComponentDeclarations.Build(DeclarationFixture.Sample)
        assert.equal(descriptor.Name, 'sample-app')
        assert.equal(descriptor.Version, ComponentDeclarations.Version)
        const [port, token] = descriptor.Options[0].Settings
        assert.deepEqual([port.Name, port.Default, port.Required, port.Secret, port.Description], ['port', 8080, false, false, 'PRAGMATIC_PORT: Port.'])
        assert.deepEqual([token.Name, token.Default, token.Required, token.Secret], ['token', undefined, true, true])
        assert.deepEqual(descriptor.Roles.map(role => role.Name), ['app.admin'])
        assert.equal(descriptor.Storage.Postgres, true)
        assert.deepEqual(descriptor.Endpoints.Ports.map(p => [p.Name, p.Number]), [['http', 8080]])
        assert.deepEqual([descriptor.Endpoints.Health?.Port, descriptor.Endpoints.Health?.Path], ['http', '/healthz'])
    })

    it('leaves the descriptor rules to the builder: a secret with a default is refused', () =>
    {
        const bad: ComponentDeclaration = {
            ...DeclarationFixture.Sample,
            options: [{ name: 'core', description: '', settings: [{ name: 'key', type: SettingType.String, source: 'PRAGMATIC_KEY', secret: true, default: 'x', description: '' }] }],
        }
        assert.throws(() => ComponentDeclarations.Build(bad), /cannot have a default/)
    })
})
