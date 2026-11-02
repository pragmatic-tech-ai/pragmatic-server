import { ActivityPageViewModel, ActivityRowViewModel } from "./activity-page-view-model.js";
import { OverviewPageViewModel } from "./overview-page-view-model.js";
import { DataTemplate, Dock, DockPanel, Orientation, StackPanel, TextBlock, TextWrapping } from "@pragmatic-tech-ai/mural/basic";
import { Button, ButtonVariant } from "@pragmatic-tech-ai/mural/framework/buttons/button.js";
import { ListBox } from "@pragmatic-tech-ai/mural/framework/list/list-box.js";
import { ScrollViewer } from "@pragmatic-tech-ai/mural/framework/surfaces/scroll-viewer.js";
import { DataContextBinding, DynamicResource, HorizontalAlignment, ResourceDictionary, Thickness, ToVisibility } from "@pragmatic-tech-ai/mural/runtime";


const _gate_OverviewResources = Symbol("OverviewResources.ctor");
export class OverviewResources extends ResourceDictionary {
    constructor(_g) {
        super();
        if (_g !== _gate_OverviewResources) {
            throw new Error("OverviewResources is private — use OverviewResources.Clone()");
        }
    }
    static Clone() {
        const t = new OverviewResources(_gate_OverviewResources);
        const _tmpl0 = new DataTemplate((_data) => {
            const _stackPanel1 = new StackPanel();
            _stackPanel1.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            _stackPanel1.set_property_value(StackPanel.MarginKey, new Thickness(24, 20, 24, 20));
            const _textBlock2 = new TextBlock();
            _textBlock2.set_property_value(TextBlock.TextKey, "Overview");
            _textBlock2.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock2, "H3"));
            _textBlock2.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock2, "Fg0"));
            _stackPanel1.AddChild(_textBlock2);
            return _stackPanel1;
        }, OverviewPageViewModel);
        t.Set(OverviewPageViewModel, _tmpl0);
        const _tmpl3 = new DataTemplate((_data) => {
            const _dockPanel4 = new DockPanel();
            _dockPanel4.set_property_value(DockPanel.MarginKey, new Thickness(8, 4, 8, 4));
            const _textBlock5 = new TextBlock();
            _textBlock5.set_property_value(DockPanel.DockKey, Dock.Right);
            _textBlock5.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock5, "WhenLabel"));
            _textBlock5.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock5, "UiCaption"));
            _textBlock5.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock5, "Fg2"));
            _textBlock5.set_property_value(TextBlock.MarginKey, new Thickness(12, 0, 0, 0));
            _dockPanel4.AddChild(_textBlock5);
            const _textBlock6 = new TextBlock();
            _textBlock6.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock6, "Summary"));
            _textBlock6.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock6, "Fg1"));
            _textBlock6.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _dockPanel4.AddChild(_textBlock6);
            return _dockPanel4;
        }, ActivityRowViewModel);
        t.Set("ActivityRowTemplate", _tmpl3);
        const _tmpl7 = new DataTemplate((_data) => {
            const _dockPanel8 = new DockPanel();
            _dockPanel8.set_property_value(DockPanel.MarginKey, new Thickness(24, 20, 24, 20));
            const _stackPanel9 = new StackPanel();
            _stackPanel9.set_property_value(DockPanel.DockKey, Dock.Top);
            _stackPanel9.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            _stackPanel9.set_property_value(StackPanel.MarginKey, new Thickness(0, 0, 0, 16));
            const _button10 = new Button();
            _button10.set_property_value(Button.VariantKey, ButtonVariant.Ghost);
            _button10.set_property_value(Button.CommandKey, DataContextBinding(_button10, "BackCommand"));
            _button10.set_property_value(Button.HorizontalAlignmentKey, HorizontalAlignment.Left);
            _button10.set_property_value(Button.MarginKey, new Thickness(0, 0, 0, 8));
            const _textBlock11 = new TextBlock();
            _textBlock11.set_property_value(TextBlock.TextKey, "Back");
            _button10.Content = _textBlock11;
            _stackPanel9.AddChild(_button10);
            const _textBlock12 = new TextBlock();
            _textBlock12.set_property_value(TextBlock.TextKey, "Activity");
            _textBlock12.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock12, "H3"));
            _textBlock12.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock12, "Fg0"));
            _stackPanel9.AddChild(_textBlock12);
            const _textBlock13 = new TextBlock();
            _textBlock13.set_property_value(TextBlock.TextKey, "Changes to your environments observed while this page has been open. Newest first.");
            _textBlock13.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock13, "Body"));
            _textBlock13.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock13, "Fg2"));
            _textBlock13.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock13.set_property_value(TextBlock.MarginKey, new Thickness(0, 4, 0, 0));
            _stackPanel9.AddChild(_textBlock13);
            _dockPanel8.AddChild(_stackPanel9);
            const _textBlock14 = new TextBlock();
            _textBlock14.set_property_value(DockPanel.DockKey, Dock.Top);
            _textBlock14.set_property_value(TextBlock.TextKey, "No activity observed yet this session.");
            _textBlock14.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock14, "Fg2"));
            _textBlock14.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock14, "IsEmpty", ToVisibility));
            _dockPanel8.AddChild(_textBlock14);
            const _scrollViewer15 = new ScrollViewer();
            _scrollViewer15.set_property_value(ScrollViewer.HorizontalScrollEnabledKey, false);
            _scrollViewer15.set_property_value(ScrollViewer.VisibilityKey, DataContextBinding(_scrollViewer15, "IsPopulated", ToVisibility));
            const _listBox16 = new ListBox();
            _listBox16.set_property_value(ListBox.StyleKey, DynamicResource(_listBox16, "TenantTableList"));
            _listBox16.set_property_value(ListBox.HorizontalAlignmentKey, HorizontalAlignment.Stretch);
            _listBox16.set_property_value(ListBox.ItemsSourceKey, DataContextBinding(_listBox16, "Rows"));
            _listBox16.set_property_value(ListBox.ItemTemplateKey, _tmpl3);
            _scrollViewer15.Content = _listBox16;
            _dockPanel8.AddChild(_scrollViewer15);
            return _dockPanel8;
        }, ActivityPageViewModel);
        t.Set(ActivityPageViewModel, _tmpl7);
        return t;
    }
    get ActivityRowTemplate() { return this.Resolve("ActivityRowTemplate"); }
    set ActivityRowTemplate(v) { this.Set("ActivityRowTemplate", v); }
}
