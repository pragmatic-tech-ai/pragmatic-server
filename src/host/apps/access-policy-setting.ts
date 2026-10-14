import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'

/** Thrown when an application's access-policy setting is unreadable or structurally invalid (fail-closed). */
export class MalformedPolicyError extends Error
{
    constructor(message: string)
    {
        super(message)
        this.name = new.target.name
    }
}

/**
 * Loads the mutable per-application runtime access-policy SETTING
 * (`<appName>/access-policy.json`): an object mapping concept full name to an array of serialized rules.
 * An ABSENT file means allow-all (`[]`); a malformed file throws (never silently allow-all).
 */
export class AccessPolicySetting
{
    public static readonly PolicyFile = 'access-policy.json'
    private static readonly Separator = '/'
    private static readonly NotJson = 'Access policy is not valid JSON: '
    private static readonly NotObject = 'Access policy must be a JSON object mapping concept to a rule array: '
    private static readonly NotArray = 'Access policy rules must be an array for concept: '

    public static async Load(storage: IStorage, appName: string): Promise<readonly { concept: string; rulesJson: string }[]>
    {
        const path = appName + AccessPolicySetting.Separator + AccessPolicySetting.PolicyFile
        if (!(await storage.Exists(path))) return []
        const text = await storage.ReadText(path)
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            throw new MalformedPolicyError(AccessPolicySetting.NotJson + path)
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        {
            throw new MalformedPolicyError(AccessPolicySetting.NotObject + path)
        }
        const result: { concept: string; rulesJson: string }[] = []
        for (const [concept, rules] of Object.entries(parsed))
        {
            if (!Array.isArray(rules)) throw new MalformedPolicyError(AccessPolicySetting.NotArray + concept)
            result.push({ concept, rulesJson: JSON.stringify(rules) })
        }
        return result
    }
}
