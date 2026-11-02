import { ConfirmDialogViewModel } from "./confirm-dialog-view-model.js";
import { NameConfirmDialogViewModel } from "./name-confirm-dialog-view-model.js";
import { TenantSectionService } from "./tenant-section-service.js";
import { Border, ContentPresenter, ControlTemplate, DataTemplate, Grid, ItemsPresenter, Orientation, StackPanel, TargetedSetter, TemplatePropertyTrigger, TextBlock, TextBox, TextWrapping } from "@pragmatic-tech-ai/mural/basic";
import { Button, ButtonVariant } from "@pragmatic-tech-ai/mural/framework/buttons/button.js";
import { ListBox, ListBoxItem } from "@pragmatic-tech-ai/mural/framework/list/list-box.js";
import { ScrollViewer } from "@pragmatic-tech-ai/mural/framework/surfaces/scroll-viewer.js";
import { Application, Color, DataContextBinding, DynamicResource, HorizontalAlignment, ResourceDictionary, Setter, SetterFactory, Style, Thickness, ToVisibility } from "@pragmatic-tech-ai/mural/runtime";
import { Pen, SolidColorBrush } from "@pragmatic-tech-ai/mural/visual-engine";


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
            return _border1;
        }, TenantSectionService);
        t.Set(TenantSectionService, _tmpl0);
        const _tmpl2 = new ControlTemplate((_templatedParent) => {
            const _scrollViewer3 = new ScrollViewer();
            _scrollViewer3.Name = "PART_Scroll";
            _scrollViewer3.set_property_value(ScrollViewer.HorizontalScrollEnabledKey, false);
            _scrollViewer3.set_property_value(ScrollViewer.VerticalScrollEnabledKey, false);
            const _itemsPresenter4 = new ItemsPresenter();
            _scrollViewer3.Content = _itemsPresenter4;
            return _scrollViewer3;
        });
        t.Set("TenantTable", _tmpl2);
        const _tmpl5 = (() => {
            const _factory = (_templatedParent) => {
                let _border6, _border7, _border8, _contentPresenter9;
                _border6 = new Border();
                _border6.Name = "PART_FocusRing";
                _border6.set_property_value(Border.FillKey, new SolidColorBrush(Color.FromHex('#00000000')));
                _border6.set_property_value(Border.CornerRadiusKey, DynamicResource(_border6, "RadiusMd"));
                _border7 = new Border();
                _border7.Name = "PART_Border";
                _border7.set_property_value(Border.FillKey, new SolidColorBrush(Color.FromHex('#00000000')));
                _border7.set_property_value(Border.CornerRadiusKey, DynamicResource(_border7, "RadiusMd"));
                _border8 = new Border();
                _border8.Name = "PART_Selected";
                _border8.set_property_value(Border.FillKey, new SolidColorBrush(Color.FromHex('#00000000')));
                _border8.set_property_value(Border.CornerRadiusKey, DynamicResource(_border8, "RadiusMd"));
                _contentPresenter9 = new ContentPresenter();
                _contentPresenter9.Name = "PART_HeadlineSlot";
                _contentPresenter9.set_property_value(ContentPresenter.HorizontalAlignmentKey, HorizontalAlignment.Stretch);
                _border8.SetChild(_contentPresenter9);
                _border7.SetChild(_border8);
                _border6.SetChild(_border7);
                return _border6;
            };
            const _tplSet10 = [new TargetedSetter(Border, "Fill", new SetterFactory((_t) => DynamicResource(_t, "SurfaceSelected")), "PART_Selected")];
            const _tplTrig11 = new TemplatePropertyTrigger(ListBoxItem, "IsSelected", true, _tplSet10, undefined);
            const _tplSet12 = [new TargetedSetter(Border, "Fill", new SetterFactory((_t) => DynamicResource(_t, "RowHoverFill")), "PART_Border")];
            const _tplTrig13 = new TemplatePropertyTrigger(ListBoxItem, "IsMouseOver", true, _tplSet12, undefined);
            const _tplSet14 = [new TargetedSetter(Border, "Stroke", ((_e) => { _e.Brush = DynamicResource(_e, "BorderFocus"); _e.Thickness = 2; return _e; })(new Pen()), "PART_FocusRing")];
            const _tplTrig15 = new TemplatePropertyTrigger(ListBoxItem, "IsFocused", true, _tplSet14, undefined);
            return new ControlTemplate(_factory, [_tplTrig11, _tplTrig13, _tplTrig15]);
        })();
        t.Set("TenantTableRowTemplate", _tmpl5);
        const _setter16 = new Setter(ListBoxItem, "Template", _tmpl5);
        const _setter17 = new Setter(TextBlock, "Foreground", new SetterFactory((_t) => DynamicResource(_t, "Fg1")));
        const _style18 = new Style(ListBoxItem, [_setter16, _setter17], undefined, [], []);
        t.Set("TenantTableRow", _style18);
        const _setter19 = new Setter(ListBox, "Template", _tmpl2);
        const _setter20 = new Setter(ListBox, "ItemContainerStyle", _style18);
        const _style21 = new Style(ListBox, [_setter19, _setter20], undefined, [], []);
        t.Set("TenantTableList", _style21);
        const _setter22 = new Setter(Grid, "Margin", new Thickness(8, 4, 8, 4));
        const _style23 = new Style(Grid, [_setter22], undefined, [], []);
        t.Set("TenantTableColumns", _style23);
        const _setter24 = new Setter(TextBlock, "Foreground", new SetterFactory((_t) => DynamicResource(_t, "Fg2")));
        const _style25 = new Style(TextBlock, [_setter24], () => Application.current?.Resources.Resolve("UiCaption"), [], []);
        t.Set("TenantTableHeader", _style25);
        const _setter26 = new Setter(TextBlock, "Margin", new Thickness(18, 0, 0, 0));
        const _style27 = new Style(TextBlock, [_setter26], _style25, [], []);
        t.Set("TenantTableLinkHeader", _style27);
        const _setter28 = new Setter(TextBlock, "Foreground", new SetterFactory((_t) => DynamicResource(_t, "Fg0")));
        const _setter29 = new Setter(TextBlock, "Margin", new Thickness(0, 0, 0, 6));
        const _style30 = new Style(TextBlock, [_setter28, _setter29], () => Application.current?.Resources.Resolve("UiLabel"), [], []);
        t.Set("TenantSectionCaption", _style30);
        const _setter31 = new Setter(Border, "Fill", new SetterFactory((_t) => DynamicResource(_t, "Bg1")));
        const _setter32 = new Setter(Border, "Stroke", ((_e) => { _e.Brush = DynamicResource(_e, "Border"); return _e; })(new Pen()));
        const _setter33 = new Setter(Border, "Padding", new Thickness(12, 10, 12, 10));
        const _setter34 = new Setter(Border, "Margin", new Thickness(0, 0, 0, 16));
        const _style35 = new Style(Border, [_setter31, _setter32, _setter33, _setter34], undefined, [], []);
        t.Set("TenantPanel", _style35);
        const _setter36 = new Setter(TextBlock, "Foreground", new SetterFactory((_t) => DynamicResource(_t, "Fg2")));
        const _style37 = new Style(TextBlock, [_setter36], () => Application.current?.Resources.Resolve("UiCaption"), [], []);
        t.Set("TenantKey", _style37);
        const _tmpl38 = new DataTemplate((_data) => {
            const _stackPanel39 = new StackPanel();
            _stackPanel39.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            _stackPanel39.set_property_value(StackPanel.MarginKey, new Thickness(0, 4, 0, 0));
            const _textBlock40 = new TextBlock();
            _textBlock40.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock40, "Message"));
            _textBlock40.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock40.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock40, "Fg1"));
            _textBlock40.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 8));
            _stackPanel39.AddChild(_textBlock40);
            const _textBlock41 = new TextBlock();
            _textBlock41.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock41, "ConsequencesText"));
            _textBlock41.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock41.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock41, "Fg2"));
            _textBlock41.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 12));
            _textBlock41.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock41, "ConsequencesText", ToVisibility));
            _stackPanel39.AddChild(_textBlock41);
            const _textBlock42 = new TextBlock();
            _textBlock42.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock42, "PromptText"));
            _textBlock42.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock42, "UiCaption"));
            _textBlock42.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock42, "Fg2"));
            _textBlock42.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 4));
            _stackPanel39.AddChild(_textBlock42);
            const _textBox43 = new TextBox();
            _textBox43.set_property_value(TextBox.TextKey, DataContextBinding(_textBox43, "Typed"));
            _textBox43.set_property_value(TextBox.PlaceholderKey, DataContextBinding(_textBox43, "Expected"));
            _textBox43.set_property_value(TextBox.MarginKey, new Thickness(0, 0, 0, 12));
            _stackPanel39.AddChild(_textBox43);
            const _textBlock44 = new TextBlock();
            _textBlock44.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock44, "ErrorText"));
            _textBlock44.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock44, "StateDangerInk"));
            _textBlock44.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock44.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 12));
            _textBlock44.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock44, "ErrorText", ToVisibility));
            _stackPanel39.AddChild(_textBlock44);
            const _stackPanel45 = new StackPanel();
            _stackPanel45.set_property_value(StackPanel.OrientationKey, Orientation.Horizontal);
            _stackPanel45.set_property_value(StackPanel.HorizontalAlignmentKey, HorizontalAlignment.Right);
            const _button46 = new Button();
            _button46.set_property_value(Button.VariantKey, ButtonVariant.Secondary);
            _button46.set_property_value(Button.CommandKey, DataContextBinding(_button46, "CancelCommand"));
            _button46.set_property_value(Button.MarginKey, new Thickness(0, 0, 8, 0));
            const _textBlock47 = new TextBlock();
            _textBlock47.set_property_value(TextBlock.TextKey, "Cancel");
            _button46.Content = _textBlock47;
            _stackPanel45.AddChild(_button46);
            const _button48 = new Button();
            _button48.set_property_value(Button.VariantKey, ButtonVariant.Danger);
            _button48.set_property_value(Button.CommandKey, DataContextBinding(_button48, "ConfirmCommand"));
            const _textBlock49 = new TextBlock();
            _textBlock49.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock49, "ConfirmLabel"));
            _button48.Content = _textBlock49;
            _stackPanel45.AddChild(_button48);
            _stackPanel39.AddChild(_stackPanel45);
            return _stackPanel39;
        }, NameConfirmDialogViewModel);
        t.Set(NameConfirmDialogViewModel, _tmpl38);
        const _tmpl50 = new DataTemplate((_data) => {
            const _stackPanel51 = new StackPanel();
            _stackPanel51.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            _stackPanel51.set_property_value(StackPanel.MarginKey, new Thickness(0, 4, 0, 0));
            const _textBlock52 = new TextBlock();
            _textBlock52.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock52, "Message"));
            _textBlock52.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock52.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock52, "Fg1"));
            _textBlock52.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 8));
            _stackPanel51.AddChild(_textBlock52);
            const _textBlock53 = new TextBlock();
            _textBlock53.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock53, "ConsequencesText"));
            _textBlock53.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock53.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock53, "Fg2"));
            _textBlock53.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 12));
            _textBlock53.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock53, "ConsequencesText", ToVisibility));
            _stackPanel51.AddChild(_textBlock53);
            const _border54 = new Border();
            _border54.set_property_value(Border.FillKey, DynamicResource(_border54, "StateWarningSoft"));
            _border54.set_property_value(Border.PaddingKey, new Thickness(12, 8, 12, 8));
            _border54.set_property_value(Border.MarginKey, new Thickness(0, 0, 0, 12));
            _border54.set_property_value(Border.VisibilityKey, DataContextBinding(_border54, "Warning", ToVisibility));
            const _textBlock55 = new TextBlock();
            _textBlock55.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock55, "Warning"));
            _textBlock55.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock55, "StateWarningInk"));
            _textBlock55.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _border54.SetChild(_textBlock55);
            _stackPanel51.AddChild(_border54);
            const _textBlock56 = new TextBlock();
            _textBlock56.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock56, "ErrorText"));
            _textBlock56.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock56, "StateDangerInk"));
            _textBlock56.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock56.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 12));
            _textBlock56.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock56, "ErrorText", ToVisibility));
            _stackPanel51.AddChild(_textBlock56);
            const _stackPanel57 = new StackPanel();
            _stackPanel57.set_property_value(StackPanel.OrientationKey, Orientation.Horizontal);
            _stackPanel57.set_property_value(StackPanel.HorizontalAlignmentKey, HorizontalAlignment.Right);
            const _button58 = new Button();
            _button58.set_property_value(Button.VariantKey, ButtonVariant.Secondary);
            _button58.set_property_value(Button.CommandKey, DataContextBinding(_button58, "CancelCommand"));
            _button58.set_property_value(Button.MarginKey, new Thickness(0, 0, 8, 0));
            const _textBlock59 = new TextBlock();
            _textBlock59.set_property_value(TextBlock.TextKey, "Cancel");
            _button58.Content = _textBlock59;
            _stackPanel57.AddChild(_button58);
            const _button60 = new Button();
            _button60.set_property_value(Button.VariantKey, ButtonVariant.Danger);
            _button60.set_property_value(Button.CommandKey, DataContextBinding(_button60, "ConfirmCommand"));
            _button60.set_property_value(Button.VisibilityKey, DataContextBinding(_button60, "IsDanger", ToVisibility));
            const _textBlock61 = new TextBlock();
            _textBlock61.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock61, "ConfirmLabel"));
            _button60.Content = _textBlock61;
            _stackPanel57.AddChild(_button60);
            const _button62 = new Button();
            _button62.set_property_value(Button.VariantKey, ButtonVariant.Primary);
            _button62.set_property_value(Button.CommandKey, DataContextBinding(_button62, "ConfirmCommand"));
            _button62.set_property_value(Button.VisibilityKey, DataContextBinding(_button62, "IsNotDanger", ToVisibility));
            const _textBlock63 = new TextBlock();
            _textBlock63.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock63, "ConfirmLabel"));
            _button62.Content = _textBlock63;
            _stackPanel57.AddChild(_button62);
            _stackPanel51.AddChild(_stackPanel57);
            return _stackPanel51;
        }, ConfirmDialogViewModel);
        t.Set(ConfirmDialogViewModel, _tmpl50);
        return t;
    }
    get TenantTable() { return this.Resolve("TenantTable"); }
    set TenantTable(v) { this.Set("TenantTable", v); }
    get TenantTableRowTemplate() { return this.Resolve("TenantTableRowTemplate"); }
    set TenantTableRowTemplate(v) { this.Set("TenantTableRowTemplate", v); }
    get TenantTableRow() { return this.Resolve("TenantTableRow"); }
    set TenantTableRow(v) { this.Set("TenantTableRow", v); }
    get TenantTableList() { return this.Resolve("TenantTableList"); }
    set TenantTableList(v) { this.Set("TenantTableList", v); }
    get TenantTableColumns() { return this.Resolve("TenantTableColumns"); }
    set TenantTableColumns(v) { this.Set("TenantTableColumns", v); }
    get TenantTableHeader() { return this.Resolve("TenantTableHeader"); }
    set TenantTableHeader(v) { this.Set("TenantTableHeader", v); }
    get TenantTableLinkHeader() { return this.Resolve("TenantTableLinkHeader"); }
    set TenantTableLinkHeader(v) { this.Set("TenantTableLinkHeader", v); }
    get TenantSectionCaption() { return this.Resolve("TenantSectionCaption"); }
    set TenantSectionCaption(v) { this.Set("TenantSectionCaption", v); }
    get TenantPanel() { return this.Resolve("TenantPanel"); }
    set TenantPanel(v) { this.Set("TenantPanel", v); }
    get TenantKey() { return this.Resolve("TenantKey"); }
    set TenantKey(v) { this.Set("TenantKey", v); }
}
