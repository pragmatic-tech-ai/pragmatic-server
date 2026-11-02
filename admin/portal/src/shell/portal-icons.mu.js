import { ResourceDictionary } from "@pragmatic-tech-ai/mural/runtime";
import { ArcSegment, EllipseGeometry, GeometryGroup, LineSegment, PathFigure, PathGeometry, Point, Rect, RectangleGeometry, Size, SweepDirection } from "@pragmatic-tech-ai/mural/visual-engine";


const _gate_PortalIcons = Symbol("PortalIcons.ctor");
export class PortalIcons extends ResourceDictionary {
    constructor(_g) {
        super();
        if (_g !== _gate_PortalIcons) {
            throw new Error("PortalIcons is private — use PortalIcons.Clone()");
        }
    }
    static Clone() {
        const t = new PortalIcons(_gate_PortalIcons);
        const _inc0 = new GeometryGroup([new RectangleGeometry(new Rect(3, 3, 8, 18), 1, 1), new RectangleGeometry(new Rect(13, 3, 8, 8), 1, 1), new RectangleGeometry(new Rect(13, 13, 8, 8), 1, 1)]);
        t.Set("FleetIcon", _inc0);
        const _inc1 = new GeometryGroup([new PathGeometry([new PathFigure(new Point(4, 21), [new LineSegment(new Point(4, 4)), new LineSegment(new Point(14, 2)), new LineSegment(new Point(14, 21))], true)]), new PathGeometry([new PathFigure(new Point(15.5, 21), [new LineSegment(new Point(15.5, 9)), new LineSegment(new Point(20, 9)), new LineSegment(new Point(20, 21))], true)])]);
        t.Set("ClientsIcon", _inc1);
        const _inc2 = new GeometryGroup([new EllipseGeometry(new Point(8.5, 7), 3.5, 3.5), new PathGeometry([new PathFigure(new Point(2, 21), [new ArcSegment(new Point(15, 21), new Size(6.5, 6.5), 0, false, SweepDirection.Clockwise)], true)]), new EllipseGeometry(new Point(19, 10), 2.5, 2.5), new PathGeometry([new PathFigure(new Point(15.5, 21), [new ArcSegment(new Point(22.5, 21), new Size(3.5, 3.5), 0, false, SweepDirection.Clockwise)], true)])]);
        t.Set("TenantsIcon", _inc2);
        const _inc3 = new PathGeometry([new PathFigure(new Point(12, 2), [new LineSegment(new Point(20.7, 7)), new LineSegment(new Point(20.7, 17)), new LineSegment(new Point(12, 22)), new LineSegment(new Point(3.3, 17)), new LineSegment(new Point(3.3, 7))], true)]);
        t.Set("HivesIcon", _inc3);
        const _inc4 = new GeometryGroup([new PathGeometry([new PathFigure(new Point(12, 2), [new LineSegment(new Point(21, 6.5)), new LineSegment(new Point(12, 11)), new LineSegment(new Point(3, 6.5))], true)]), new PathGeometry([new PathFigure(new Point(3, 8.5), [new LineSegment(new Point(11, 12.5)), new LineSegment(new Point(11, 22)), new LineSegment(new Point(3, 18))], true)]), new PathGeometry([new PathFigure(new Point(13, 12.5), [new LineSegment(new Point(21, 8.5)), new LineSegment(new Point(21, 18)), new LineSegment(new Point(13, 22))], true)])]);
        t.Set("ReleasesIcon", _inc4);
        const _inc5 = new PathGeometry([new PathFigure(new Point(12, 2), [new LineSegment(new Point(20, 5)), new LineSegment(new Point(20, 11)), new LineSegment(new Point(18, 16)), new LineSegment(new Point(12, 22)), new LineSegment(new Point(6, 16)), new LineSegment(new Point(4, 11)), new LineSegment(new Point(4, 5))], true)]);
        t.Set("ReleasePolicyIcon", _inc5);
        const _inc6 = new PathGeometry([new PathFigure(new Point(5, 2), [new LineSegment(new Point(19, 2)), new LineSegment(new Point(19, 4)), new LineSegment(new Point(13.5, 12)), new LineSegment(new Point(19, 20)), new LineSegment(new Point(19, 22)), new LineSegment(new Point(5, 22)), new LineSegment(new Point(5, 20)), new LineSegment(new Point(10.5, 12)), new LineSegment(new Point(5, 4))], true)]);
        t.Set("ActivityIcon", _inc6);
        const _inc7 = new GeometryGroup([new RectangleGeometry(new Rect(3, 5, 4, 2), 0, 0), new RectangleGeometry(new Rect(8, 3, 3, 6), 1, 1), new RectangleGeometry(new Rect(12, 5, 9, 2), 0, 0), new RectangleGeometry(new Rect(3, 11, 10, 2), 0, 0), new RectangleGeometry(new Rect(14, 9, 3, 6), 1, 1), new RectangleGeometry(new Rect(18, 11, 3, 2), 0, 0), new RectangleGeometry(new Rect(3, 17, 2, 2), 0, 0), new RectangleGeometry(new Rect(6, 15, 3, 6), 1, 1), new RectangleGeometry(new Rect(10, 17, 11, 2), 0, 0)]);
        t.Set("SettingsIcon", _inc7);
        return t;
    }
}
