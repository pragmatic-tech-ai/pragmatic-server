import { SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDeclarations, type ComponentDeclaration } from '../../src/component/component-declaration.js'

/**
 * The component descriptor of the UI-unpack init container (bin/pragmatic-ui-unpack): every variable it reads is required.
 * It pulls, verifies and unpacks one signed UI artifact, then exits: no port, no storage of its own.
 */
export class UiUnpackComponent
{
    public static readonly Name = 'pragmatic-ui-unpack'

    private static readonly Declaration: ComponentDeclaration = {
        name: UiUnpackComponent.Name,
        options: [
            {
                name: 'core',
                description: 'The UI artifact to unpack and the trust it is verified against.',
                settings: [
                    { name: 'registryBase', type: SettingType.Url, source: 'PRAGMATIC_UI_REGISTRY_BASE', required: true, description: 'Base URL of the registry the artifact is pulled from.' },
                    { name: 'repository', type: SettingType.String, source: 'PRAGMATIC_UI_REPO', required: true, description: 'The artifact repository.' },
                    { name: 'artifactTag', type: SettingType.String, source: 'PRAGMATIC_UI_ARTIFACT_TAG', required: true, description: 'The artifact tag.' },
                    { name: 'signatureTag', type: SettingType.String, source: 'PRAGMATIC_UI_SIG_TAG', required: true, description: 'The tag of the artifact signature.' },
                    { name: 'manifestDigest', type: SettingType.String, source: 'PRAGMATIC_UI_MANIFEST_DIGEST', required: true, description: 'The manifest digest the artifact must have.' },
                    { name: 'appName', type: SettingType.String, source: 'PRAGMATIC_UI_APP_NAME', required: true, description: 'The application the UI belongs to.' },
                    { name: 'appVersion', type: SettingType.String, source: 'PRAGMATIC_UI_APP_VERSION', required: true, description: 'The application version.' },
                    { name: 'trustRootRef', type: SettingType.String, source: 'PRAGMATIC_UI_TRUST_ROOT_REF', required: true, description: 'The trust root the signature must chain to.' },
                    { name: 'dataDir', type: SettingType.String, source: 'PRAGMATIC_UI_DATA_DIR', required: true, description: 'Folder the UI is unpacked into.' },
                    { name: 'trustDir', type: SettingType.String, source: 'PRAGMATIC_UI_TRUST_DIR', required: true, description: 'Folder of the trusted public keys.' },
                ],
            },
        ],
        roles: [],
        postgres: false,
        ports: [],
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(UiUnpackComponent.Declaration)
    }
}
