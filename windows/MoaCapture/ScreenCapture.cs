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
        IntPtr desktop = NativeMethods.GetDC(IntPtr.Zero), memory = IntPtr.Zero, bitmap = IntPtr.Zero, old = IntPtr.Zero;
        try
        {
            if (desktop == IntPtr.Zero)
                throw new InvalidOperationException("화면을 읽을 수 없습니다.");
            memory = NativeMethods.CreateCompatibleDC(desktop);
            bitmap = NativeMethods.CreateCompatibleBitmap(desktop, rectangle.Width, rectangle.Height);
            if (memory == IntPtr.Zero || bitmap == IntPtr.Zero)
                throw new InvalidOperationException("화면을 담을 공간이 부족합니다.");
            old = NativeMethods.SelectObject(memory, bitmap);
            if (!NativeMethods.BitBlt(memory, 0, 0, rectangle.Width, rectangle.Height, desktop, rectangle.Left, rectangle.Top, 0x40CC0020))
                throw new InvalidOperationException("화면을 캡처하지 못했습니다.");
            BitmapSource source = Imaging.CreateBitmapSourceFromHBitmap(bitmap, IntPtr.Zero, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
            source.Freeze();
            return source;
        }
        finally
        {
            if (old != IntPtr.Zero && memory != IntPtr.Zero)
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
        if (selection.Width < 6 || selection.Height < 6)
            throw new InvalidOperationException("조금 더 넓은 영역을 선택해 주세요.");
        if (selection.Width > 16_383 || selection.Height > 16_383 || (long)selection.Width * selection.Height > 40_000_000)
            throw new InvalidOperationException("선택한 영역이 너무 큽니다. 조금 더 작게 캡처해 주세요.");
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
        byte[] bytes = EncodePng(bitmap);
        if (bytes.Length > 25 * 1024 * 1024)
            throw new InvalidOperationException("캡처 이미지가 25MB를 넘습니다. 조금 더 작은 영역을 선택해 주세요.");
        return new(bytes, bitmap, selection.Width, selection.Height);
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