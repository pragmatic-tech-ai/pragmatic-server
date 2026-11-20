import { ConfirmDialogViewModel } from "./confirm-dialog-view-model.js";
import { TenantNameConfirmDialogViewModel } from "./tenant-name-confirm-dialog-view-model.js";
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
            const _stackPanel43 = new StackPanel();
            _stackPanel43.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            _stackPanel43.set_property_value(StackPanel.MarginKey, new Thickness(0, 0, 0, 12));
            const _textBox44 = new TextBox();
            _textBox44.set_property_value(TextBox.UsesNativeInputKey, true);
            _textBox44.set_property_value(TextBox.TextKey, DataContextBinding(_textBox44, "Typed"));
            _textBox44.set_property_value(TextBox.PlaceholderKey, DataContextBinding(_textBox44, "Expected"));
            _stackPanel43.AddChild(_textBox44);
            const _textBlock45 = new TextBlock();
            _textBlock45.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock45, "MismatchText"));
            _textBlock45.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock45, "UiCaption"));
            _textBlock45.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock45, "StateDangerInk"));
            _textBlock45.set_property_value(TextBlock.MarginKey, new Thickness(0, 4, 0, 0));
            _textBlock45.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock45, "MismatchText", ToVisibility));
            _stackPanel43.AddChild(_textBlock45);
            _stackPanel39.AddChild(_stackPanel43);
            const _textBlock46 = new TextBlock();
            _textBlock46.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock46, "ErrorText"));
            _textBlock46.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock46, "StateDangerInk"));
            _textBlock46.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock46.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 12));
            _textBlock46.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock46, "ErrorText", ToVisibility));
            _stackPanel39.AddChild(_textBlock46);
            const _stackPanel47 = new StackPanel();
            _stackPanel47.set_property_value(StackPanel.OrientationKey, Orientation.Horizontal);
            _stackPanel47.set_property_value(StackPanel.HorizontalAlignmentKey, HorizontalAlignment.Right);
            const _button48 = new Button();
            _button48.set_property_value(Button.VariantKey, ButtonVariant.Secondary);
            _button48.set_property_value(Button.CommandKey, DataContextBinding(_button48, "CancelCommand"));
            _button48.set_property_value(Button.MarginKey, new Thickness(0, 0, 8, 0));
            const _textBlock49 = new TextBlock();
            _textBlock49.set_property_value(TextBlock.TextKey, "Cancel");
            _button48.Content = _textBlock49;
            _stackPanel47.AddChild(_button48);
            const _button50 = new Button();
            _button50.set_property_value(Button.VariantKey, ButtonVariant.Danger);
            _button50.set_property_value(Button.CommandKey, DataContextBinding(_button50, "ConfirmCommand"));
            const _textBlock51 = new TextBlock();
            _textBlock51.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock51, "ConfirmLabel"));
            _button50.Content = _textBlock51;
            _stackPanel47.AddChild(_button50);
            _stackPanel39.AddChild(_stackPanel47);
            return _stackPanel39;
        }, TenantNameConfirmDialogViewModel);
        t.Set(TenantNameConfirmDialogViewModel, _tmpl38);
        const _tmpl52 = new DataTemplate((_data) => {
            const _stackPanel53 = new StackPanel();
            _stackPanel53.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            _stackPanel53.set_property_value(StackPanel.MarginKey, new Thickness(0, 4, 0, 0));
            const _textBlock54 = new TextBlock();
            _textBlock54.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock54, "Message"));
            _textBlock54.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock54.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock54, "Fg1"));
            _textBlock54.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 8));
            _stackPanel53.AddChild(_textBlock54);
            const _textBlock55 = new TextBlock();
            _textBlock55.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock55, "ConsequencesText"));
            _textBlock55.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock55.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock55, "Fg2"));
            _textBlock55.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 12));
            _textBlock55.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock55, "ConsequencesText", ToVisibility));
            _stackPanel53.AddChild(_textBlock55);
            const _border56 = new Border();
            _border56.set_property_value(Border.FillKey, DynamicResource(_border56, "StateWarningSoft"));
            _border56.set_property_value(Border.PaddingKey, new Thickness(12, 8, 12, 8));
            _border56.set_property_value(Border.MarginKey, new Thickness(0, 0, 0, 12));
            _border56.set_property_value(Border.VisibilityKey, DataContextBinding(_border56, "Warning", ToVisibility));
            const _textBlock57 = new TextBlock();
            _textBlock57.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock57, "Warning"));
            _textBlock57.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock57, "StateWarningInk"));
            _textBlock57.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _border56.SetChild(_textBlock57);
            _stackPanel53.AddChild(_border56);
            const _textBlock58 = new TextBlock();
            _textBlock58.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock58, "ErrorText"));
            _textBlock58.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock58, "StateDangerInk"));
            _textBlock58.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock58.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 12));
            _textBlock58.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock58, "ErrorText", ToVisibility));
            _stackPanel53.AddChild(_textBlock58);
            const _stackPanel59 = new StackPanel();
            _stackPanel59.set_property_value(StackPanel.OrientationKey, Orientation.Horizontal);
            _stackPanel59.set_property_value(StackPanel.HorizontalAlignmentKey, HorizontalAlignment.Right);
            const _button60 = new Button();
            _button60.set_property_value(Button.VariantKey, ButtonVariant.Secondary);
            _button60.set_property_value(Button.CommandKey, DataContextBinding(_button60, "CancelCommand"));
            _button60.set_property_value(Button.MarginKey, new Thickness(0, 0, 8, 0));
            const _textBlock61 = new TextBlock();
            _textBlock61.set_property_value(TextBlock.TextKey, "Cancel");
            _button60.Content = _textBlock61;
            _stackPanel59.AddChild(_button60);
            const _button62 = new Button();
            _button62.set_property_value(Button.VariantKey, ButtonVariant.Danger);
            _button62.set_property_value(Button.CommandKey, DataContextBinding(_button62, "ConfirmCommand"));
            _button62.set_property_value(Button.VisibilityKey, DataContextBinding(_button62, "IsDanger", ToVisibility));
            const _textBlock63 = new TextBlock();
            _textBlock63.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock63, "ConfirmLabel"));
            _button62.Content = _textBlock63;
            _stackPanel59.AddChild(_button62);
            const _button64 = new Button();
            _button64.set_property_value(Button.VariantKey, ButtonVariant.Primary);
            _button64.set_property_value(Button.CommandKey, DataContextBinding(_button64, "ConfirmCommand"));
            _button64.set_property_value(Button.VisibilityKey, DataContextBinding(_button64, "IsNotDanger", ToVisibility));
            const _textBlock65 = new TextBlock();
            _textBlock65.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock65, "ConfirmLabel"));
            _button64.Content = _textBlock65;
            _stackPanel59.AddChild(_button64);
            _stackPanel53.AddChild(_stackPanel59);
            return _stackPanel53;
        }, ConfirmDialogViewModel);
        t.Set(ConfirmDialogViewModel, _tmpl52);
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
