using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace MoaCapture;

public sealed record WindowCaptureTarget(nint Handle, string Title)
{
    public override string ToString() => Title;
}

internal static class WindowCapture
{
    private const uint DwmExtendedFrameBounds = 9;
    private const uint DwmCloaked = 14;
    private const uint RenderFullContent = 2;
    private const int ExtendedStyle = -20;
    private const int ToolWindowStyle = 0x00000080;
    private const int AppWindowStyle = 0x00040000;
    private const uint AbortIfHung = 0x0002;
    private const uint ErrorOnExit = 0x0020;

    public static IReadOnlyList<WindowCaptureTarget> GetTargets()
    {
        var targets = new List<WindowCaptureTarget>();
        var shell = GetShellWindow();
        if (!EnumWindows((window, _) =>
        {
            if (GetTarget(window, shell) is { } target)
                targets.Add(target);
            return true;
        }, 0))
            throw new InvalidOperationException("열린 창 목록을 확인할 수 없습니다. 다시 시도해 주세요.");
        return targets;
    }

    public static WindowCaptureTarget? GetActiveTarget() => GetTarget(GetForegroundWindow(), GetShellWindow());

    public static (PhysicalRect Bounds, PhysicalRect Visible) GetBounds(nint window)
    {
        if (!IsEligible(window, GetShellWindow()) || !NativeMethods.GetWindowRect(window, out var rectangle))
            throw new InvalidOperationException("선택한 창이 닫혔거나 최소화되었습니다. 창을 연 뒤 다시 선택해 주세요.");
        if (GetWindowDisplayAffinity(window, out uint affinity) && affinity != 0)
            throw new InvalidOperationException("선택한 창에서 화면 캡처를 허용하지 않습니다.");

        var bounds = rectangle.ToPhysical();
        if (DwmGetWindowAttribute(window, DwmExtendedFrameBounds, out NativeMethods.RECT frame,
                (uint)Marshal.SizeOf<NativeMethods.RECT>()) >= 0)
        {
            var visible = bounds.Intersect(frame.ToPhysical());
            if (!visible.IsEmpty)
                return (bounds, visible);
        }
        return (bounds, bounds);
    }

    public static bool Draw(nint window, nint destination)
    {
        // PrintWindow is synchronous, so avoid requesting a redraw from an already hung window.
        if (SendMessageTimeout(window, 0, 0, 0, AbortIfHung | ErrorOnExit, 250, out _) == 0)
            return false;
        return PrintWindow(window, destination, RenderFullContent);
    }

    private static WindowCaptureTarget? GetTarget(nint window, nint shell)
    {
        if (!IsEligible(window, shell))
            return null;

        var title = new StringBuilder(513);
        if (GetWindowText(window, title, title.Capacity) == 0)
            return null;
        string name = title.ToString().Trim();
        return name.Length == 0 ? null : new WindowCaptureTarget(window, name);
    }

    private static bool IsEligible(nint window, nint shell)
    {
        if (window == 0 || window == shell || !IsWindowVisible(window) || IsIconic(window))
            return false;

        if (GetWindowThreadProcessId(window, out uint process) == 0 || process == Environment.ProcessId)
            return false;

        var windowClass = new StringBuilder(128);
        if (GetClassName(window, windowClass, windowClass.Capacity) == 0
            || windowClass.ToString() is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd")
            return false;

        int style = GetWindowLong(window, ExtendedStyle);
        if ((style & ToolWindowStyle) != 0 && (style & AppWindowStyle) == 0)
            return false;

        return DwmGetWindowAttribute(window, DwmCloaked, out uint cloaked, sizeof(uint)) < 0 || cloaked == 0;
    }

    private delegate bool EnumWindowsCallback(nint window, nint state);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsCallback callback, nint state);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern nint GetShellWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint window, out uint process);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", ExactSpelling = true)]
    private static extern int GetWindowLong(nint window, int index);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint window, StringBuilder title, int maximum);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint window, StringBuilder name, int maximum);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(nint window, uint attribute, out uint value, uint size);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(nint window, uint attribute, out NativeMethods.RECT value, uint size);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowDisplayAffinity(nint window, out uint affinity);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern nint SendMessageTimeout(nint window, uint message, nuint wParam, nint lParam,
        uint flags, uint timeout, out nuint result);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PrintWindow(nint window, nint destination, uint flags);
}
