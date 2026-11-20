import { SignInFacts } from '@pragmatic-tech-ai/pragmatic-identity-realm';

/** The stored form of a sign-in (in authorization codes, SSO sessions and refresh tokens). */
export type RealmSignInJson = {
    accountId: string;
    source: string;
    subject: string;
    groups: string[];
    email: string;
    name: string;
    emailVerified: boolean | null;
    authenticatedAt: string;
};

/**
 * What one sign-in established, kept with everything issued from it: the realm account, the source it came through, the
 * subject and groups there (the input of role resolution, so roles follow the mappings at every refresh), the email and
 * name, whether the source verified the email, and when the person authenticated.
 */
export class RealmSignIn
{
    public readonly Groups: readonly string[];

    public constructor(
        public readonly AccountId: string,
        public readonly Source: string,
        public readonly Subject: string,
        groups: Iterable<string>,
        public readonly Email: string,
        public readonly Name: string,
        public readonly EmailVerified: boolean | undefined,
        public readonly AuthenticatedAt: Date)
    {
        this.Groups = Object.freeze([...groups]);
        Object.freeze(this);
    }

    public Facts(): SignInFacts
    {
        return new SignInFacts(this.AccountId, this.Source, this.Subject, this.Groups);
    }

    public ToJson(): RealmSignInJson
    {
        return {
            accountId: this.AccountId,
            source: this.Source,
            subject: this.Subject,
            groups: [...this.Groups],
            email: this.Email,
            name: this.Name,
            emailVerified: this.EmailVerified ?? null,
            authenticatedAt: this.AuthenticatedAt.toISOString(),
        };
    }

    /** The sign-in a stored document holds; undefined when it is not one. */
    public static FromJson(value: unknown): RealmSignIn | undefined
    {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
        {
            return undefined;
        }
        const json = value as Partial<RealmSignInJson>;
        const at = typeof json.authenticatedAt === 'string' ? new Date(json.authenticatedAt) : undefined;
        if (typeof json.accountId !== 'string' || typeof json.source !== 'string' || typeof json.subject !== 'string'
            || !Array.isArray(json.groups) || typeof json.email !== 'string' || typeof json.name !== 'string'
            || at === undefined || Number.isNaN(at.getTime()))
        {
            return undefined;
        }
        const verified = typeof json.emailVerified === 'boolean' ? json.emailVerified : undefined;
        return new RealmSignIn(json.accountId, json.source, json.subject, json.groups.filter(group => typeof group === 'string'), json.email, json.name, verified, at);
    }
}
