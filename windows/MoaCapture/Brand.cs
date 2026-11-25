using System;
using System.Windows;
using System.Windows.Media.Imaging;

namespace MoaCapture;

internal static class Brand
{
    public const string Name = "모아 캡처";
    public static BitmapImage Image { get; } = new(new Uri("pack://application:,,,/Assets/Moa.png"));

    public static System.Drawing.Icon CreateTrayIcon()
    {
        using var stream = Application.GetResourceStream(new Uri("pack://application:,,,/Assets/Moa.ico")).Stream;
        using var icon = new System.Drawing.Icon(stream, 32, 32);
        return (System.Drawing.Icon)icon.Clone();
    }
}
