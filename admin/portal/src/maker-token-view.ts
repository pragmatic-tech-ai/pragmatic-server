import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import type { IPortalNavigator, MakerTokenDto } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Mints a maker token for a Development environment and reveals it once.
// The token is held only in this view's memory and the text it renders.
export class MakerTokenView extends PortalViewBase
{
    public static readonly MintLabel = 'Mint maker token'
    public static readonly HeadingText = 'Maker token'
    public static readonly WarningText = 'Copy this token now - it will not be shown again.'
    private static readonly PrincipalPrefix = 'Principal: '
    private static readonly DetailSeparator = '  '
    private static readonly NeverExpires = 'Expires: never'
    private static readonly ExpiresPrefix = 'Expires: '

    // Mural's TextBox has no IsReadOnly, so this is editable; harmless because it holds only a shown-once display copy of a secret the operator already has, and it is dropped on navigation. Set IsReadOnly here if Mural ever gains it.
    private readonly tokenBox = new TextBox()
    private readonly warning = new TextBlock()
    private readonly details = new TextBlock()
    private issued: MakerTokenDto | undefined

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly envName: string)
    {
        super()
        const heading = new TextBlock()
        heading.Text = MakerTokenView.HeadingText
        this.AddChild(heading)
        this.AddChild(this.MakeButton(MakerTokenView.MintLabel, () => { void this.Mint() }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowDetail(this.envName) }))
        this.AddChild(this.message)
        this.AddChild(this.warning)
        this.AddChild(this.details)
        this.AddChild(this.tokenBox)
    }

    // Run() refreshes after a successful mint; that is when the token is revealed.
    public Refresh(): Promise<void>
    {
        this.Reveal()
        return Promise.resolve()
    }

    private async Mint(): Promise<void>
    {
        await this.Run(async () =>
        {
            this.issued = await this.client.IssueMakerToken(this.envName)
        })
    }

    private Reveal(): void
    {
        if (this.issued === undefined)
        {
            return
        }
        this.message.Text = PortalViewBase.NoMessage
        this.warning.Text = MakerTokenView.WarningText
        const expiry = this.issued.expiresAt === null ? MakerTokenView.NeverExpires : MakerTokenView.ExpiresPrefix + this.issued.expiresAt
        this.details.Text = MakerTokenView.PrincipalPrefix + this.issued.principalId + MakerTokenView.DetailSeparator + expiry
        this.tokenBox.Text = this.issued.token
    }
}
