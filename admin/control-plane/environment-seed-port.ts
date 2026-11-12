import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { BundleBuilder, type EnvDefinition, type EnvOidc } from '../../environments/seed/bundle.js'
import { UserSeeder, type UserSeed } from '../../environments/seed/users.js'

/** Writes an environment's config bundle; every runtime backend (Docker on a dev box, in-cluster in a hive) prepares through it. */
export interface IBundleBuilder
{
    Generate(def: EnvDefinition, bundleDir: string, seedDir?: string, oidc?: EnvOidc): Promise<void>
}

/** Seeds an environment's users over its admin protocol. */
export interface IUserSeeder
{
    Login(baseHttpUrl: string, tenant: string, email: string, password: string): Promise<string>
    Connect(wsUrl: string, tenant: string, token: string): Promise<unknown>
    SeedUsers(conn: unknown, users: UserSeed[]): Promise<void>
    Dispose(conn: unknown): void
}

export class BundleBuilderAdapter implements IBundleBuilder
{
    public Generate(def: EnvDefinition, bundleDir: string, seedDir?: string, oidc?: EnvOidc): Promise<void>
    {
        return BundleBuilder.Generate(def, bundleDir, seedDir, oidc)
    }
}

export class UserSeederAdapter implements IUserSeeder
{
    public constructor(private readonly seeder: UserSeeder = new UserSeeder())
    {
    }

    public Login(baseHttpUrl: string, tenant: string, email: string, password: string): Promise<string>
    {
        return this.seeder.Login(baseHttpUrl, tenant, email, password)
    }

    public Connect(wsUrl: string, tenant: string, token: string): Promise<unknown>
    {
        return this.seeder.Connect(wsUrl, tenant, token)
    }

    public SeedUsers(conn: unknown, users: UserSeed[]): Promise<void>
    {
        return this.seeder.SeedUsers(conn as MessageConnection, users)
    }

    public Dispose(conn: unknown): void
    {
        (conn as MessageConnection).dispose()
    }
}
