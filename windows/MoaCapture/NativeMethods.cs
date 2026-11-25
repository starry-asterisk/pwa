using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace MoaCapture;

public readonly record struct PhysicalRect(int Left, int Top, int Width, int Height)
{
    public int Right => Left + Width;
    public int Bottom => Top + Height;
    public bool IsEmpty => Width <= 0 || Height <= 0;
    public PhysicalRect Intersect(PhysicalRect other)
    {
        int left = Math.Max(Left, other.Left), top = Math.Max(Top, other.Top);
        return new(left, top, Math.Max(0, Math.Min(Right, other.Right) - left), Math.Max(0, Math.Min(Bottom, other.Bottom) - top));
    }
    public static PhysicalRect Between(NativeMethods.POINT a, NativeMethods.POINT b) => new(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
}
public sealed record CaptureMonitor(IntPtr Handle, PhysicalRect Bounds, PhysicalRect WorkArea, double ScaleX, double ScaleY);
public static class NativeMethods
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X; public int Y; public POINT(int x, int y)
        {
            X = x;
            Y = y;
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left, Top, Right, Bottom; public readonly PhysicalRect ToPhysical() => new(Left, Top, Right - Left, Bottom - Top);
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int Size; public RECT Monitor; public RECT Work; public int Flags;
    }
    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref RECT rectangle, IntPtr data);
    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDpiAwarenessContext(IntPtr awareness);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sx, int sy, uint rop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    public static List<CaptureMonitor> Monitors()
    {
        var monitors = new List<CaptureMonitor>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr handle, IntPtr dc, ref RECT rectangle, IntPtr data) =>
        {
            var info = new MONITORINFO { Size = Marshal.SizeOf<MONITORINFO>() };
            if (!GetMonitorInfo(handle, ref info))
                return true;
            double sx = 1, sy = 1;
            try
            {
                if (GetDpiForMonitor(handle, 0, out uint x, out uint y) == 0)
                {
                    sx = x / 96d;
                    sy = y / 96d;
                }
            }
            catch (EntryPointNotFoundException) { }
            monitors.Add(new(handle, info.Monitor.ToPhysical(), info.Work.ToPhysical(), sx, sy));
            return true;
        }, IntPtr.Zero);
        if (monitors.Count == 0)
            throw new InvalidOperationException("연결된 화면을 찾을 수 없습니다.");
        return monitors;
    }
    public static CaptureMonitor ClosestMonitor(int x, int y)
    {
        var monitors = Monitors();
        var best = monitors[0];
        long distance = long.MaxValue;
        foreach (var monitor in monitors)
        {
            long dx = Math.Max(monitor.Bounds.Left - x, Math.Max(0, x - (monitor.Bounds.Right - 1)));
            long dy = Math.Max(monitor.Bounds.Top - y, Math.Max(0, y - (monitor.Bounds.Bottom - 1)));
            long d = dx * dx + dy * dy;
            if (d < distance)
            {
                best = monitor;
                distance = d;
            }
        }
        return best;
    }
    public static void Place(IntPtr window, PhysicalRect bounds, bool activate = false, bool show = true)
    {
        uint flags = (activate ? 0u : 0x0010u) | (show ? 0x0040u : 0u);
        if (!SetWindowPos(window, new IntPtr(-1), bounds.Left, bounds.Top, bounds.Width, bounds.Height, flags))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
}
