import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'

/**
 * The component descriptor of the pragmatic-postgres image (its composition root is pragmatic-postgres-entrypoint.sh): what
 * the entrypoint and the reconcile read. The image is the Postgres other applications store in; it needs none of its own.
 * Every password is a mounted file; per-application passwords are files named for the application in the secrets folder.
 */
export class PragmaticPostgresComponent
{
    public static readonly Name = 'pragmatic-postgres'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.0'

    private static readonly Declaration: ComponentDeclaration = {
        name: PragmaticPostgresComponent.Name,
        version: PragmaticPostgresComponent.Version,
        options: [
            {
                name: 'core',
                description: 'One database and one role per application, reconciled on every start.',
                settings: [
                    { name: 'applicationsFile', type: SettingType.String, source: 'PRAGMATIC_POSTGRES_APPLICATIONS', default: '/etc/pragmatic-postgres/applications.conf', description: 'File of <application> <database> <role> lines.' },
                    { name: 'applicationSecretsDir', type: SettingType.String, source: 'PRAGMATIC_POSTGRES_SECRETS_DIR', default: '/run/secrets/pragmatic-postgres/applications', description: 'Folder holding one password file per application, named for the application.' },
                    { name: 'superuser', type: SettingType.String, source: 'POSTGRES_USER', default: 'postgres', description: 'Name of the superuser role.' },
                    { name: 'superuserPassword', type: SettingType.String, source: 'POSTGRES_PASSWORD_FILE', required: true, secret: true, description: 'The superuser password (a mounted secret file, /run/secrets/pragmatic-postgres/superuser in the image).' },
                ],
            },
        ],
        roles: [],
        postgres: false,
        ports: [{ name: 'postgres', number: 5432 }],
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(PragmaticPostgresComponent.Declaration)
    }
}
