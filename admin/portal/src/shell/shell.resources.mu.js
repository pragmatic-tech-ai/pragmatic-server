import { PortalSessionService } from "./portal-session-service.js";
import { Border, DataTemplate, Dock, DockPanel, Orientation, StackPanel, TextBlock } from "@pragmatic-tech-ai/mural/basic";
import { Button, ButtonVariant } from "@pragmatic-tech-ai/mural/framework/buttons/button.js";
import { DataContextBinding, DynamicResource, ResourceDictionary, Thickness, ToVisibility, VerticalAlignment } from "@pragmatic-tech-ai/mural/runtime";
import { Pen } from "@pragmatic-tech-ai/mural/visual-engine";


const _gate_ShellResources = Symbol("ShellResources.ctor");
export class ShellResources extends ResourceDictionary {
    constructor(_g) {
        super();
        if (_g !== _gate_ShellResources) {
            throw new Error("ShellResources is private — use ShellResources.Clone()");
        }
    }
    static Clone() {
        const t = new ShellResources(_gate_ShellResources);
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
            const _stackPanel8 = new StackPanel();
            _stackPanel8.set_property_value(StackPanel.OrientationKey, Orientation.Horizontal);
            _stackPanel8.set_property_value(StackPanel.VerticalAlignmentKey, VerticalAlignment.Center);
            const _textBlock9 = new TextBlock();
            _textBlock9.set_property_value(TextBlock.TextKey, "Platform Admin");
            _textBlock9.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock9, "UiLabel"));
            _textBlock9.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock9, "Fg0"));
            _textBlock9.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 16, 0));
            _stackPanel8.AddChild(_textBlock9);
            const _textBlock10 = new TextBlock();
            _textBlock10.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock10, "ReadOnlyNotice"));
            _textBlock10.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock10, "UiCaption"));
            _textBlock10.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock10, "StateWarningInk"));
            _textBlock10.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 16, 0));
            _textBlock10.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock10, "ReadOnlyNotice", ToVisibility));
            _stackPanel8.AddChild(_textBlock10);
            const _textBlock11 = new TextBlock();
            _textBlock11.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock11, "LogoutError"));
            _textBlock11.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock11, "UiCaption"));
            _textBlock11.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock11, "StateDangerInk"));
            _textBlock11.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock11, "LogoutError", ToVisibility));
            _stackPanel8.AddChild(_textBlock11);
            _dockPanel2.AddChild(_stackPanel8);
            _border1.SetChild(_dockPanel2);
            return _border1;
        }, PortalSessionService);
        t.Set(PortalSessionService, _tmpl0);
        return t;
    }
}
