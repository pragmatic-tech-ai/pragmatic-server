import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';

/** A secret file store is read-only: the deploy's secret sync writes its files. */
export class FileSecretStoreReadOnlyError extends Error
{
    private static readonly ErrorName = 'FileSecretStoreReadOnlyError';
    private static readonly Text = 'the file secret store is read-only (its files come from the deploy)';

    public constructor()
    {
        super(FileSecretStoreReadOnlyError.Text);
        this.name = FileSecretStoreReadOnlyError.ErrorName;
    }
}

/**
 * The `file` store of a realm's secrets home: one secret per file in a folder (the platform's secret sync, a mounted
 * Kubernetes Secret). A name is one plain path segment; anything else, or an unreadable file, reads as absent. Trailing
 * line breaks are dropped. Values are never logged.
 */
export class FileSecretStore implements ISecretStore
{
    private static readonly SafeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    private static readonly TrailingLineBreaks = /[\r\n]+$/;
    private static readonly Utf8 = 'utf8';

    public constructor(private readonly directory: string)
    {
    }

    public async Get(reference: string): Promise<string | null>
    {
        if (!FileSecretStore.SafeName.test(reference))
        {
            return null;
        }
        try
        {
            const value = (await readFile(join(this.directory, reference), FileSecretStore.Utf8)).replace(FileSecretStore.TrailingLineBreaks, '');
            return value === '' ? null : value;
        }
        catch
        {
            return null;
        }
    }

    public async Put(_reference: string, _secret: string): Promise<void>
    {
        throw new FileSecretStoreReadOnlyError();
    }

    public async Delete(_reference: string): Promise<void>
    {
        throw new FileSecretStoreReadOnlyError();
    }
}
