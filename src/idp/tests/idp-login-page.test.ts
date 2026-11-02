import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdpLoginPage } from '../idp-login-page.js';

const Index = '<html><head><meta name="pragmatic-login" content="ready"></head><body></body></html>';

test('Render sets the failed flag only after a rejected sign-in', () =>
{
    const page = IdpLoginPage.FromHtml(Index);
    assert.equal(page.Render(false), Index);
    assert.ok(page.Render(true).includes('<meta name="pragmatic-login" content="failed">'));
    assert.ok(!page.Render(true).includes('content="ready"'));
});

test('an index without the flag is refused, so a wrong build can never be served', () =>
{
    assert.throws(() => IdpLoginPage.FromHtml('<html></html>'), /pragmatic-login/);
});

test('Load refuses an unbuilt app, naming the build command', () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-login-page-'));
    try
    {
        assert.throws(() => IdpLoginPage.Load(dir), /not built/);
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the placeholder carries the marker and serves no assets', () =>
{
    const page = IdpLoginPage.Placeholder();
    assert.ok(page.Render(false).includes(IdpLoginPage.Marker));
    assert.equal(page.ReadAsset('assets/app.js'), undefined);
});
