import { OverviewSectionService } from "./sections/overview/overview-section-service.js";
import { TenantSessionService } from "./shell/tenant-session-service.js";
import { Border, DataTemplate, Dock, DockPanel, Orientation, StackPanel, TextBlock } from "@pragmatic-tech-ai/mural/basic";
import { Button, ButtonVariant } from "@pragmatic-tech-ai/mural/framework/buttons/button.js";
import { DataContextBinding, DynamicResource, ResourceDictionary, ServiceBinding, ServiceProvider, Thickness, ToVisibility, VerticalAlignment } from "@pragmatic-tech-ai/mural/runtime";
import { Pen } from "@pragmatic-tech-ai/mural/visual-engine";


const _gate_AppResources = Symbol("AppResources.ctor");
export class AppResources extends ResourceDictionary {
    constructor(_g) {
        super();
        if (_g !== _gate_AppResources) {
            throw new Error("AppResources is private — use AppResources.Clone()");
        }
    }
    static Clone() {
        const t = new AppResources(_gate_AppResources);
        const _tmpl0 = new DataTemplate((_data) => {
            const _border1 = new Border();
            _border1.set_property_value(Border.FillKey, DynamicResource(_border1, "Bg0"));
            _border1.set_property_value(Border.StrokeKey, ((_e) => { _e.Brush = DynamicResource(_e, "Border"); return _e; })(new Pen()));
            _border1.set_property_value(Border.PaddingKey, new Thickness(16, 8, 16, 8));
            const _dockPanel2 = new DockPanel();
            const _button3 = new Button();
            _button3.set_property_value(DockPanel.DockKey, Dock.Right);
            _button3.set_property_value(Button.VariantKey, ButtonVariant.Text);
            _button3.set_property_value(Button.CommandKey, DataContextBinding(_button3, "LogoutCommand"));
            _button3.set_property_value(Button.MarginKey, new Thickness(12, 0, 0, 0));
            const _textBlock4 = new TextBlock();
            _textBlock4.set_property_value(TextBlock.TextKey, "Log out");
            _button3.Content = _textBlock4;
            _dockPanel2.AddChild(_button3);
            const _stackPanel5 = new StackPanel();
            _stackPanel5.set_property_value(DockPanel.DockKey, Dock.Right);
            _stackPanel5.set_property_value(StackPanel.OrientationKey, Orientation.Horizontal);
            _stackPanel5.set_property_value(StackPanel.VerticalAlignmentKey, VerticalAlignment.Center);
            const _textBlock6 = new TextBlock();
            _textBlock6.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock6, "Email"));
            _textBlock6.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock6, "UiLabel"));
            _textBlock6.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock6, "Fg0"));
            _textBlock6.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 8, 0));
            _stackPanel5.AddChild(_textBlock6);
            const _textBlock7 = new TextBlock();
            _textBlock7.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock7, "RoleLabel"));
            _textBlock7.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock7, "UiCaption"));
            _textBlock7.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock7, "Fg2"));
            _stackPanel5.AddChild(_textBlock7);
            _dockPanel2.AddChild(_stackPanel5);
            const _button8 = new Button();
            _button8.set_property_value(DockPanel.DockKey, Dock.Right);
            _button8.set_property_value(Button.VariantKey, ButtonVariant.Text);
            _button8.set_property_value(Button.CommandKey, ServiceBinding(_button8, ServiceProvider.tokenFor(OverviewSectionService), "OpenActivityCommand"));
            _button8.set_property_value(Button.MarginKey, new Thickness(0, 0, 16, 0));
            const _textBlock9 = new TextBlock();
            _textBlock9.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock9, "ActivityCountText"));
            _button8.Content = _textBlock9;
            _dockPanel2.AddChild(_button8);
            const _stackPanel10 = new StackPanel();
            _stackPanel10.set_property_value(StackPanel.OrientationKey, Orientation.Horizontal);
            _stackPanel10.set_property_value(StackPanel.VerticalAlignmentKey, VerticalAlignment.Center);
            const _textBlock11 = new TextBlock();
            _textBlock11.set_property_value(TextBlock.TextKey, "Tenant Admin");
            _textBlock11.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock11, "UiLabel"));
            _textBlock11.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock11, "Fg0"));
            _textBlock11.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 16, 0));
            _stackPanel10.AddChild(_textBlock11);
            const _textBlock12 = new TextBlock();
            _textBlock12.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock12, "OrganisationLabel"));
            _textBlock12.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock12, "Fg2"));
            _textBlock12.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock12, "HasOrganisation", ToVisibility));
            _stackPanel10.AddChild(_textBlock12);
            const _textBlock13 = new TextBlock();
            _textBlock13.set_property_value(TextBlock.TextKey, " / ");
            _textBlock13.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock13, "Fg3"));
            _textBlock13.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock13, "HasOrganisation", ToVisibility));
            _stackPanel10.AddChild(_textBlock13);
            const _textBlock14 = new TextBlock();
            _textBlock14.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock14, "TenantLabel"));
            _textBlock14.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock14, "UiLabel"));
            _textBlock14.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock14, "Fg0"));
            _textBlock14.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 8, 0));
            _stackPanel10.AddChild(_textBlock14);
            const _textBlock15 = new TextBlock();
            _textBlock15.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock15, "HiveLabel"));
            _textBlock15.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock15, "Code"));
            _textBlock15.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock15, "Fg2"));
            _textBlock15.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 16, 0));
            _stackPanel10.AddChild(_textBlock15);
            const _textBlock16 = new TextBlock();
            _textBlock16.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock16, "LogoutError"));
            _textBlock16.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock16, "UiCaption"));
            _textBlock16.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock16, "StateDangerInk"));
            _textBlock16.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock16, "LogoutError", ToVisibility));
            _stackPanel10.AddChild(_textBlock16);
            _dockPanel2.AddChild(_stackPanel10);
            _border1.SetChild(_dockPanel2);
            return _border1;
        }, TenantSessionService);
        t.Set(TenantSessionService, _tmpl0);
        return t;
    }
}
