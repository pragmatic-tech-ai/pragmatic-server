import { ConfigurationValidator } from '@pragmatic-tech-ai/pragmatic-component';
import { RuntimeConfiguration, SecretValue } from '@pragmatic-tech-ai/pragmatic-configuration';
import { RealmConfiguration } from '../realm-configuration-reader.js';
import { TenantIdpComponent } from '../tenant-idp-component.js';

/** A realm configuration for tests: the document validated against the service's descriptor, secrets given resolved. */
export class RealmTestConfiguration
{
    public static Of(realm: string, document: unknown, secrets: Record<string, string> = {}, displayName?: string): RealmConfiguration
    {
        const descriptor = TenantIdpComponent.Descriptor();
        const validation = new ConfigurationValidator(descriptor).Validate(document);
        if (validation.Configuration === undefined)
        {
            throw new Error('test configuration does not validate: ' + validation.Errors.map(e => e.toString()).join('; '));
        }
        const values = new Map(Object.entries(secrets).map(([key, value]) => [key, new SecretValue(value)]));
        return new RealmConfiguration(realm, displayName, new RuntimeConfiguration(1, descriptor.Version, descriptor.ContentDigest(), validation.Configuration, values));
    }

    /** The key a secret setting's value is held under (`<option>/<setting>`). */
    public static Secret(option: string, setting: string): string
    {
        return RuntimeConfiguration.SecretKey(option, setting);
    }
}
