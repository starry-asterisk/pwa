using System;
using System.Runtime.InteropServices;

namespace MoaCapture;

internal sealed class DesktopVideoFrame : IDisposable
{
    private const uint CopyLayeredWindows = 0x40CC0020;
    private const int Halftone = 4;

    private readonly PhysicalRect region;
    private readonly int width, height;
    private readonly byte[] bgrx, nv12;
    private readonly IntPtr desktop, memory, bitmap, previousBitmap, pixels;

    public DesktopVideoFrame(PhysicalRect region, int width, int height)
    {
        this.region = region;
        this.width = width;
        this.height = height;
        bgrx = new byte[width * height * 4];
        nv12 = new byte[width * height * 3 / 2];
        try
        {
            desktop = NativeMethods.GetDC(IntPtr.Zero);
            if (desktop == IntPtr.Zero)
                throw new InvalidOperationException("녹화할 화면을 읽을 수 없습니다.");

            memory = NativeMethods.CreateCompatibleDC(desktop);
            if (memory == IntPtr.Zero)
                throw new InvalidOperationException("화면 녹화에 필요한 메모리를 만들지 못했습니다.");

            var info = new BitmapInfoHeader
            {
                Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(),
                Width = width,
                Height = -height, // Top-down BGRX rows.
                Planes = 1,
                BitCount = 32,
                SizeImage = (uint)bgrx.Length
            };
            bitmap = CreateDIBSection(desktop, in info, 0, out pixels, IntPtr.Zero, 0);
            if (bitmap == IntPtr.Zero || pixels == IntPtr.Zero)
                throw new InvalidOperationException("녹화 프레임을 만들지 못했습니다.");

            previousBitmap = NativeMethods.SelectObject(memory, bitmap);
            if (previousBitmap == IntPtr.Zero || previousBitmap == new IntPtr(-1))
                throw new InvalidOperationException("녹화 프레임을 설정하지 못했습니다.");

            if (region.Width != width || region.Height != height)
            {
                SetStretchBltMode(memory, Halftone);
                SetBrushOrgEx(memory, 0, 0, IntPtr.Zero);
            }
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public byte[] CaptureNv12()
    {
        bool captured = region.Width == width && region.Height == height
            ? NativeMethods.BitBlt(memory, 0, 0, width, height, desktop, region.Left, region.Top, CopyLayeredWindows)
            : StretchBlt(memory, 0, 0, width, height, desktop, region.Left, region.Top, region.Width, region.Height, CopyLayeredWindows);
        if (!captured || !GdiFlush())
            throw new InvalidOperationException("화면 녹화 프레임을 읽지 못했습니다.");

        Marshal.Copy(pixels, bgrx, 0, bgrx.Length);
        ConvertToNv12();
        return nv12;
    }

    private void ConvertToNv12()
    {
        // The Windows H.264 encoder accepts NV12: an 8-bit luma plane and a 4:2:0
        // interleaved chroma plane. Use limited-range BT.601 consistently with the media type.
        int lumaCount = width * height;
        for (int pixel = 0, source = 0; pixel < lumaCount; pixel++, source += 4)
        {
            int blue = bgrx[source], green = bgrx[source + 1], red = bgrx[source + 2];
            nv12[pixel] = (byte)(16 + ((66 * red + 129 * green + 25 * blue + 128) >> 8));
        }

        int chroma = lumaCount;
        int stride = width * 4;
        for (int y = 0; y < height; y += 2)
        {
            int topRow = y * stride;
            int bottomRow = topRow + stride;
            for (int x = 0; x < stride; x += 8)
            {
                int top = topRow + x, bottom = bottomRow + x;
                int blue = (bgrx[top] + bgrx[top + 4] + bgrx[bottom] + bgrx[bottom + 4] + 2) >> 2;
                int green = (bgrx[top + 1] + bgrx[top + 5] + bgrx[bottom + 1] + bgrx[bottom + 5] + 2) >> 2;
                int red = (bgrx[top + 2] + bgrx[top + 6] + bgrx[bottom + 2] + bgrx[bottom + 6] + 2) >> 2;
                nv12[chroma++] = (byte)(128 + ((-38 * red - 74 * green + 112 * blue + 128) >> 8));
                nv12[chroma++] = (byte)(128 + ((112 * red - 94 * green - 18 * blue + 128) >> 8));
            }
        }
    }

    public void Dispose()
    {
        if (previousBitmap != IntPtr.Zero && previousBitmap != new IntPtr(-1))
            NativeMethods.SelectObject(memory, previousBitmap);
        if (bitmap != IntPtr.Zero)
            NativeMethods.DeleteObject(bitmap);
        if (memory != IntPtr.Zero)
            NativeMethods.DeleteDC(memory);
        if (desktop != IntPtr.Zero)
            NativeMethods.ReleaseDC(IntPtr.Zero, desktop);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, BitCount;
        public uint Compression, SizeImage;
        public int XPelsPerMeter, YPelsPerMeter;
        public uint ColorsUsed, ImportantColors;
    }

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateDIBSection(IntPtr dc, in BitmapInfoHeader info, uint usage,
        out IntPtr bits, IntPtr section, uint offset);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StretchBlt(IntPtr destination, int x, int y, int width, int height,
        IntPtr source, int sourceX, int sourceY, int sourceWidth, int sourceHeight, uint operation);

    [DllImport("gdi32.dll")]
    private static extern int SetStretchBltMode(IntPtr dc, int mode);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr previousOrigin);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GdiFlush();
}
