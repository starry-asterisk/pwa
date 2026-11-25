using System;

namespace MoaCapture;

public enum DockEdge { Left, Right, Top, Bottom }

internal readonly record struct EdgePlacement(CaptureMonitor Monitor, DockEdge Edge, int Along)
{
    public const int ButtonSize = 48;
    public const int HandleThickness = 8;
    private const int HoverPadding = 5;
    private const int LegacyWidth = 52;
    private const int LegacyHeight = 76;

    public static EdgePlacement Snap(CaptureMonitor monitor, int x, int y)
    {
        var work = monitor.WorkArea;
        x = Math.Clamp(x, work.Left, work.Right - 1);
        y = Math.Clamp(y, work.Top, work.Bottom - 1);
        int left = x - work.Left, right = work.Right - 1 - x;
        int top = y - work.Top, bottom = work.Bottom - 1 - y;
        if (Math.Min(left, right) / monitor.ScaleX <= Math.Min(top, bottom) / monitor.ScaleY)
            return At(monitor, left <= right ? DockEdge.Left : DockEdge.Right, y);
        return At(monitor, top <= bottom ? DockEdge.Top : DockEdge.Bottom, x);
    }

    public static EdgePlacement Restore(CaptureMonitor monitor, DockEdge? edge, int? savedX, int? savedY)
    {
        var work = monitor.WorkArea;
        int defaultY = work.Top + (int)(work.Height * .42);
        return edge switch
        {
            DockEdge.Left or DockEdge.Right => At(monitor, edge.Value, savedY ?? defaultY),
            DockEdge.Top or DockEdge.Bottom => At(monitor, edge.Value, savedX ?? work.Left + work.Width / 2),
            _ => At(monitor,
                savedX is int x && (long)x + Pixels(LegacyWidth, monitor.ScaleX) / 2 <= work.Left + work.Width / 2
                    ? DockEdge.Left : DockEdge.Right,
                savedY is int y ? (long)y + Pixels(LegacyHeight, monitor.ScaleY) / 2 : defaultY)
        };
    }

    public NativeMethods.POINT Anchor => Edge switch
    {
        DockEdge.Left => new(Monitor.WorkArea.Left, Along),
        DockEdge.Right => new(Monitor.WorkArea.Right - 1, Along),
        DockEdge.Top => new(Along, Monitor.WorkArea.Top),
        _ => new(Along, Monitor.WorkArea.Bottom - 1)
    };

    public PhysicalRect Bounds()
    {
        var work = Monitor.WorkArea;
        int width = Math.Min(work.Width, Pixels(ButtonSize, Monitor.ScaleX));
        int height = Math.Min(work.Height, Pixels(ButtonSize, Monitor.ScaleY));
        int x = Edge switch
        {
            DockEdge.Left => work.Left,
            DockEdge.Right => work.Right - width,
            _ => CenteredOrigin(Along, work.Left, work.Width, width)
        };
        int y = Edge switch
        {
            DockEdge.Top => work.Top,
            DockEdge.Bottom => work.Bottom - height,
            _ => CenteredOrigin(Along, work.Top, work.Height, height)
        };
        return new(x, y, width, height);
    }

    public bool IsNearHandle(NativeMethods.POINT point)
    {
        var bounds = Bounds();
        if (point.X < bounds.Left || point.X >= bounds.Right || point.Y < bounds.Top || point.Y >= bounds.Bottom)
            return false;

        int depth = Edge switch
        {
            DockEdge.Left => point.X - bounds.Left,
            DockEdge.Right => bounds.Right - 1 - point.X,
            DockEdge.Top => point.Y - bounds.Top,
            _ => bounds.Bottom - 1 - point.Y
        };
        double scale = IsVertical(Edge) ? Monitor.ScaleX : Monitor.ScaleY;
        return depth < Pixels(HandleThickness + HoverPadding, scale);
    }

    public static PhysicalRect DragBounds(CaptureMonitor monitor, int x, int y)
    {
        int width = Pixels(ButtonSize, monitor.ScaleX), height = Pixels(ButtonSize, monitor.ScaleY);
        return new(x - width / 2, y - height / 2, width, height);
    }

    private static EdgePlacement At(CaptureMonitor monitor, DockEdge edge, long along)
    {
        var work = monitor.WorkArea;
        bool vertical = IsVertical(edge);
        int start = vertical ? work.Top : work.Left;
        int available = vertical ? work.Height : work.Width;
        int length = Math.Min(available, Pixels(ButtonSize, vertical ? monitor.ScaleY : monitor.ScaleX));
        return new(monitor, edge, CenteredOrigin(along, start, available, length) + length / 2);
    }

    private static int CenteredOrigin(long center, int start, int available, int length)
        => (int)Math.Clamp(center - length / 2, start, (long)start + available - length);

    private static bool IsVertical(DockEdge edge) => edge is DockEdge.Left or DockEdge.Right;

    private static int Pixels(int dips, double scale) => Math.Max(1, (int)Math.Round(dips * scale));
}
