import { EnvironmentsPageViewModel } from "./environments-page-view-model.js";
import { DataTemplate, Orientation, StackPanel, TextBlock } from "@pragmatic-tech-ai/mural/basic";
import { DynamicResource, ResourceDictionary, Thickness } from "@pragmatic-tech-ai/mural/runtime";


const _gate_EnvironmentsResources = Symbol("EnvironmentsResources.ctor");
export class EnvironmentsResources extends ResourceDictionary {
    constructor(_g) {
        super();
        if (_g !== _gate_EnvironmentsResources) {
            throw new Error("EnvironmentsResources is private — use EnvironmentsResources.Clone()");
        }
    }
    static Clone() {
        const t = new EnvironmentsResources(_gate_EnvironmentsResources);
        const _tmpl0 = new DataTemplate((_data) => {
            const _stackPanel1 = new StackPanel();
            _stackPanel1.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            _stackPanel1.set_property_value(StackPanel.MarginKey, new Thickness(24, 20, 24, 20));
            const _textBlock2 = new TextBlock();
            _textBlock2.set_property_value(TextBlock.TextKey, "Environments");
            _textBlock2.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock2, "H3"));
            _textBlock2.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock2, "Fg0"));
            _stackPanel1.AddChild(_textBlock2);
            return _stackPanel1;
        }, EnvironmentsPageViewModel);
        t.Set(EnvironmentsPageViewModel, _tmpl0);
        return t;
    }
}
