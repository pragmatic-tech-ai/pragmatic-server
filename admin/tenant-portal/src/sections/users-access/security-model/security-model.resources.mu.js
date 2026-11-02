import { SecurityModelEditorViewModel } from "./security-model-editor-view-model.js";
import { DataTemplate, Orientation, StackPanel, TextBlock } from "@pragmatic-tech-ai/mural/basic";
import { DynamicResource, ResourceDictionary } from "@pragmatic-tech-ai/mural/runtime";


const _gate_SecurityModelResources = Symbol("SecurityModelResources.ctor");
export class SecurityModelResources extends ResourceDictionary {
    constructor(_g) {
        super();
        if (_g !== _gate_SecurityModelResources) {
            throw new Error("SecurityModelResources is private — use SecurityModelResources.Clone()");
        }
    }
    static Clone() {
        const t = new SecurityModelResources(_gate_SecurityModelResources);
        const _tmpl0 = new DataTemplate((_data) => {
            const _stackPanel1 = new StackPanel();
            _stackPanel1.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            const _textBlock2 = new TextBlock();
            _textBlock2.set_property_value(TextBlock.TextKey, "Roles & permissions");
            _textBlock2.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock2, "UiLabel"));
            _textBlock2.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock2, "Fg0"));
            _stackPanel1.AddChild(_textBlock2);
            return _stackPanel1;
        }, SecurityModelEditorViewModel);
        t.Set(SecurityModelEditorViewModel, _tmpl0);
        return t;
    }
}
