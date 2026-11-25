using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
namespace MoaCapture;

public sealed record MonitorSnapshot(CaptureMonitor Monitor, BitmapSource Image);
public sealed record CapturedImage(byte[] PngBytes, BitmapSource Preview, int Width, int Height);
public static class ScreenCapture
{
    public static PhysicalRect GetDesktopBounds()
    {
        var monitors = NativeMethods.Monitors();
        int left = monitors[0].Bounds.Left, top = monitors[0].Bounds.Top;
        int right = monitors[0].Bounds.Right, bottom = monitors[0].Bounds.Bottom;
        foreach (var monitor in monitors)
        {
            left = Math.Min(left, monitor.Bounds.Left);
            top = Math.Min(top, monitor.Bounds.Top);
            right = Math.Max(right, monitor.Bounds.Right);
            bottom = Math.Max(bottom, monitor.Bounds.Bottom);
        }
        return new PhysicalRect(left, top, right - left, bottom - top);
    }

    public static CapturedImage CaptureDesktop()
    {
        var bounds = GetDesktopBounds();
        ValidateImageSize(bounds);
        return ToCapturedImage(CaptureRectangle(bounds));
    }

    public static IReadOnlyList<WindowCaptureTarget> GetWindows() => WindowCapture.GetTargets();

    public static WindowCaptureTarget? GetActiveWindow() => WindowCapture.GetActiveTarget();

    public static CapturedImage CaptureWindow(nint handle)
    {
        var (bounds, visible) = WindowCapture.GetBounds(handle);
        ValidateImageSize(bounds);
        var bitmap = RenderBitmap(bounds.Width, bounds.Height,
            (memory, _) => WindowCapture.Draw(handle, memory),
            "선택한 창의 화면을 읽을 수 없습니다. 창이 열려 있는지 확인하고 다시 시도해 주세요.");
        if (visible != bounds)
        {
            bitmap = new CroppedBitmap(bitmap, new Int32Rect(
                visible.Left - bounds.Left, visible.Top - bounds.Top, visible.Width, visible.Height));
            bitmap.Freeze();
        }
        return ToCapturedImage(bitmap);
    }

    public static List<MonitorSnapshot> FreezeDisplays()
    {
        var result = new List<MonitorSnapshot>();
        foreach (var monitor in NativeMethods.Monitors())
            result.Add(new(monitor, CaptureRectangle(monitor.Bounds)));
        return result;
    }
    public static BitmapSource CaptureRectangle(PhysicalRect rectangle)
    {
        if (rectangle.IsEmpty || (long)rectangle.Width * rectangle.Height > 80_000_000)
            throw new InvalidOperationException("화면의 크기가 너무 큽니다.");
        return RenderBitmap(rectangle.Width, rectangle.Height,
            (memory, desktop) => NativeMethods.BitBlt(memory, 0, 0, rectangle.Width, rectangle.Height,
                desktop, rectangle.Left, rectangle.Top, 0x40CC0020),
            "화면을 캡처하지 못했습니다.");
    }

    private static BitmapSource RenderBitmap(int width, int height,
        Func<IntPtr, IntPtr, bool> draw, string drawError)
    {
        IntPtr desktop = NativeMethods.GetDC(IntPtr.Zero), memory = IntPtr.Zero, bitmap = IntPtr.Zero, old = IntPtr.Zero;
        try
        {
            if (desktop == IntPtr.Zero)
                throw new InvalidOperationException("화면을 읽을 수 없습니다.");
            memory = NativeMethods.CreateCompatibleDC(desktop);
            bitmap = NativeMethods.CreateCompatibleBitmap(desktop, width, height);
            if (memory == IntPtr.Zero || bitmap == IntPtr.Zero)
                throw new InvalidOperationException("화면을 담을 공간이 부족합니다.");
            old = NativeMethods.SelectObject(memory, bitmap);
            if (old == IntPtr.Zero || old == new IntPtr(-1) || !draw(memory, desktop))
                throw new InvalidOperationException(drawError);
            BitmapSource source = Imaging.CreateBitmapSourceFromHBitmap(bitmap, IntPtr.Zero, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
            source.Freeze();
            return source;
        }
        finally
        {
            if (old != IntPtr.Zero && old != new IntPtr(-1) && memory != IntPtr.Zero)
                NativeMethods.SelectObject(memory, old);
            if (bitmap != IntPtr.Zero)
                NativeMethods.DeleteObject(bitmap);
            if (memory != IntPtr.Zero)
                NativeMethods.DeleteDC(memory);
            if (desktop != IntPtr.Zero)
                NativeMethods.ReleaseDC(IntPtr.Zero, desktop);
        }
    }
    public static CapturedImage Crop(IReadOnlyList<MonitorSnapshot> snapshots, PhysicalRect selection)
    {
        ValidateImageSize(selection);
        var visual = new DrawingVisual();
        using (var drawing = visual.RenderOpen())
        {
            drawing.DrawRectangle(Brushes.Black, null, new Rect(0, 0, selection.Width, selection.Height));
            foreach (var snapshot in snapshots)
            {
                var area = snapshot.Monitor.Bounds.Intersect(selection);
                if (area.IsEmpty)
                    continue;
                var sourceArea = new Int32Rect(area.Left - snapshot.Monitor.Bounds.Left, area.Top - snapshot.Monitor.Bounds.Top, area.Width, area.Height);
                var cropped = new CroppedBitmap(snapshot.Image, sourceArea);
                cropped.Freeze();
                drawing.DrawImage(cropped, new Rect(area.Left - selection.Left, area.Top - selection.Top, area.Width, area.Height));
            }
        }
        var bitmap = new RenderTargetBitmap(selection.Width, selection.Height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        bitmap.Freeze();
        return ToCapturedImage(bitmap);
    }

    private static void ValidateImageSize(PhysicalRect selection)
    {
        if (selection.Width < 6 || selection.Height < 6)
            throw new InvalidOperationException("조금 더 넓은 영역을 선택해 주세요.");
        if (selection.Width > 16_383 || selection.Height > 16_383 || (long)selection.Width * selection.Height > 40_000_000)
            throw new InvalidOperationException("선택한 영역이 너무 큽니다. 조금 더 작게 캡처해 주세요.");
    }

    private static CapturedImage ToCapturedImage(BitmapSource bitmap)
    {
        byte[] bytes = EncodePng(bitmap);
        if (bytes.Length > 25 * 1024 * 1024)
            throw new InvalidOperationException("캡처 이미지가 25MB를 넘습니다. 조금 더 작은 영역을 선택해 주세요.");
        return new(bytes, bitmap, bitmap.PixelWidth, bitmap.PixelHeight);
    }
    public static byte[] EncodePng(BitmapSource source)
    {
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(source));
        using var stream = new MemoryStream();
        encoder.Save(stream);
        return stream.ToArray();
    }
}
