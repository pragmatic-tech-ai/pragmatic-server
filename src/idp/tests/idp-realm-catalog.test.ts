import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdpRealmCatalog } from '../idp-realm-catalog.js';

class CatalogFixture
{
    public static readonly DirPrefix = 'idp-realm-catalog-';

    public static async Run(body: (realmsDir: string) => Promise<void>): Promise<void>
    {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), CatalogFixture.DirPrefix));
        try
        {
            await body(path.join(root, 'realms'));
        }
        finally
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
}

test('a recorded realm is listed after reopening, with its display name', () => CatalogFixture.Run(async dir =>
{
    const first = await IdpRealmCatalog.Open(dir);
    await first.Record('acme', 'Acme Corp');
    const reopened = await IdpRealmCatalog.Open(dir);
    assert.deepEqual(reopened.Entries(), [{ tenantId: 'acme', displayName: 'Acme Corp' }]);
}));

test('a realm folder that predates the catalog is still listed (display name falls back to the tenant id)', () => CatalogFixture.Run(async dir =>
{
    fs.mkdirSync(path.join(dir, 'legacy-tenant'), { recursive: true });
    fs.mkdirSync(path.join(dir, '_reserved'), { recursive: true });
    const catalog = await IdpRealmCatalog.Open(dir);
    assert.deepEqual(catalog.Entries(), [{ tenantId: 'legacy-tenant', displayName: 'legacy-tenant' }]);
}));

test('a recorded realm with a folder is listed once; a missing realms folder opens empty', () => CatalogFixture.Run(async dir =>
{
    assert.deepEqual((await IdpRealmCatalog.Open(dir)).Entries(), []);
    const catalog = await IdpRealmCatalog.Open(dir);
    await catalog.Record('acme', 'Acme Corp');
    fs.mkdirSync(path.join(dir, 'acme'), { recursive: true });
    assert.deepEqual(catalog.Entries(), [{ tenantId: 'acme', displayName: 'Acme Corp' }]);
}));

test('an unreadable catalog is refused rather than silently forgetting realms', () => CatalogFixture.Run(async dir =>
{
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'realm-catalog.json'), '[1,2]');
    await assert.rejects(IdpRealmCatalog.Open(dir), /realm catalog/);
}));
