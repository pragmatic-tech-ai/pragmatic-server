import { randomBytes } from 'node:crypto';

export class AuthorizationCodeBinding
{
    public constructor(
        public readonly Sub: string,
        public readonly TenantId: string,
        public readonly ClientId: string,
        public readonly RedirectUri: string,
        public readonly Nonce: string,
        public readonly CodeChallenge: string,
        public readonly ExpiresAt: Date,
        public readonly Email: string,
        public readonly Name: string)
    {
    }
}

export interface IAuthorizationCodeStore
{
    Issue(binding: AuthorizationCodeBinding): Promise<string>;
    Take(code: string): Promise<AuthorizationCodeBinding | null>;
}

export class InMemoryAuthorizationCodeStore implements IAuthorizationCodeStore
{
    private static readonly CodeEncoding = 'base64url';
    private static readonly MinCodeBytes = 16;
    private static readonly TooFewBytesMessage = 'codeBytes must be at least 16 bytes of entropy';

    private readonly entries = new Map<string, AuthorizationCodeBinding>();

    public constructor(
        private readonly now: () => Date = () => new Date(),
        private readonly codeBytes: number = 32)
    {
        if (!(codeBytes >= InMemoryAuthorizationCodeStore.MinCodeBytes))
        {
            throw new Error(InMemoryAuthorizationCodeStore.TooFewBytesMessage);
        }
    }

    public async Issue(binding: AuthorizationCodeBinding): Promise<string>
    {
        const code = randomBytes(this.codeBytes).toString(InMemoryAuthorizationCodeStore.CodeEncoding);
        this.entries.set(code, binding);
        return code;
    }

    public async Take(code: string): Promise<AuthorizationCodeBinding | null>
    {
        const binding = this.entries.get(code);
        if (binding === undefined)
        {
            return null;
        }
        this.entries.delete(code);
        return binding.ExpiresAt.getTime() <= this.now().getTime() ? null : binding;
    }
}
