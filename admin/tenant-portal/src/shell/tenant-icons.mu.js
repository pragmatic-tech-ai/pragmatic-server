import { ResourceDictionary } from "@pragmatic-tech-ai/mural/runtime";
import { ArcSegment, EllipseGeometry, GeometryGroup, LineSegment, PathFigure, PathGeometry, Point, Rect, RectangleGeometry, Size, SweepDirection } from "@pragmatic-tech-ai/mural/visual-engine";


const _gate_TenantIcons = Symbol("TenantIcons.ctor");
export class TenantIcons extends ResourceDictionary {
    constructor(_g) {
        super();
        if (_g !== _gate_TenantIcons) {
            throw new Error("TenantIcons is private — use TenantIcons.Clone()");
        }
    }
    static Clone() {
        const t = new TenantIcons(_gate_TenantIcons);
        const _inc0 = new PathGeometry([new PathFigure(new Point(12, 2.5), [new LineSegment(new Point(22, 11)), new LineSegment(new Point(19, 11)), new LineSegment(new Point(19, 21)), new LineSegment(new Point(14.5, 21)), new LineSegment(new Point(14.5, 15)), new LineSegment(new Point(9.5, 15)), new LineSegment(new Point(9.5, 21)), new LineSegment(new Point(5, 21)), new LineSegment(new Point(5, 11)), new LineSegment(new Point(2, 11))], true)]);
        t.Set("OverviewIcon", _inc0);
        const _inc1 = new GeometryGroup([new PathGeometry([new PathFigure(new Point(12, 2), [new LineSegment(new Point(22, 7)), new LineSegment(new Point(12, 12)), new LineSegment(new Point(2, 7))], true)]), new PathGeometry([new PathFigure(new Point(4.2, 10.6), [new LineSegment(new Point(12, 14.5)), new LineSegment(new Point(19.8, 10.6)), new LineSegment(new Point(22, 11.7)), new LineSegment(new Point(12, 16.7)), new LineSegment(new Point(2, 11.7))], true)]), new PathGeometry([new PathFigure(new Point(4.2, 15.3), [new LineSegment(new Point(12, 19.2)), new LineSegment(new Point(19.8, 15.3)), new LineSegment(new Point(22, 16.4)), new LineSegment(new Point(12, 21.4)), new LineSegment(new Point(2, 16.4))], true)])]);
        t.Set("EnvironmentsIcon", _inc1);
        const _inc2 = new GeometryGroup([new EllipseGeometry(new Point(8.5, 7), 3.5, 3.5), new PathGeometry([new PathFigure(new Point(2, 21), [new ArcSegment(new Point(15, 21), new Size(6.5, 6.5), 0, false, SweepDirection.Clockwise)], true)]), new EllipseGeometry(new Point(19, 10), 2.5, 2.5), new PathGeometry([new PathFigure(new Point(15.5, 21), [new ArcSegment(new Point(22.5, 21), new Size(3.5, 3.5), 0, false, SweepDirection.Clockwise)], true)])]);
        t.Set("UsersAccessIcon", _inc2);
        const _inc3 = new GeometryGroup([new PathGeometry([new PathFigure(new Point(12, 2), [new LineSegment(new Point(21, 6.5)), new LineSegment(new Point(12, 11)), new LineSegment(new Point(3, 6.5))], true)]), new PathGeometry([new PathFigure(new Point(3, 8.5), [new LineSegment(new Point(11, 12.5)), new LineSegment(new Point(11, 22)), new LineSegment(new Point(3, 18))], true)]), new PathGeometry([new PathFigure(new Point(13, 12.5), [new LineSegment(new Point(21, 8.5)), new LineSegment(new Point(21, 18)), new LineSegment(new Point(13, 22))], true)])]);
        t.Set("ReleasesIcon", _inc3);
        const _inc4 = new GeometryGroup([new RectangleGeometry(new Rect(3, 5, 4, 2), 0, 0), new RectangleGeometry(new Rect(8, 3, 3, 6), 1, 1), new RectangleGeometry(new Rect(12, 5, 9, 2), 0, 0), new RectangleGeometry(new Rect(3, 11, 10, 2), 0, 0), new RectangleGeometry(new Rect(14, 9, 3, 6), 1, 1), new RectangleGeometry(new Rect(18, 11, 3, 2), 0, 0), new RectangleGeometry(new Rect(3, 17, 2, 2), 0, 0), new RectangleGeometry(new Rect(6, 15, 3, 6), 1, 1), new RectangleGeometry(new Rect(10, 17, 11, 2), 0, 0)]);
        t.Set("SettingsIcon", _inc4);
        const _inc5 = new GeometryGroup([new EllipseGeometry(new Point(12, 8), 2.5, 2.5), new PathGeometry([new PathFigure(new Point(11, 11), [new LineSegment(new Point(13, 11)), new LineSegment(new Point(17, 22)), new LineSegment(new Point(14.8, 22)), new LineSegment(new Point(12, 14)), new LineSegment(new Point(9.2, 22)), new LineSegment(new Point(7, 22))], true)]), new PathGeometry([new PathFigure(new Point(5.6, 2.6), [new LineSegment(new Point(7, 4)), new ArcSegment(new Point(7, 12), new Size(7, 7), 0, false, SweepDirection.Counterclockwise), new LineSegment(new Point(5.6, 13.4)), new ArcSegment(new Point(5.6, 2.6), new Size(9, 9), 0, false, SweepDirection.Clockwise)], true)]), new PathGeometry([new PathFigure(new Point(18.4, 2.6), [new LineSegment(new Point(17, 4)), new ArcSegment(new Point(17, 12), new Size(7, 7), 0, false, SweepDirection.Clockwise), new LineSegment(new Point(18.4, 13.4)), new ArcSegment(new Point(18.4, 2.6), new Size(9, 9), 0, false, SweepDirection.Counterclockwise)], true)])]);
        t.Set("ConnectionIcon", _inc5);
        return t;
    }
}
