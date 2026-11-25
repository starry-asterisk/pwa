using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace MoaCapture;

internal sealed class RecordingWindow : Window
{
    private readonly Stopwatch elapsed = new();
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromMilliseconds(200) };
    private readonly TextBlock status;
    private readonly Button stopButton;
    private bool finished;

    public RecordingWindow(PhysicalRect region, Action stop)
    {
        Title = "모아 화면 녹화";
        Icon = Brand.Image;
        Width = 242;
        Height = 54;
        Topmost = true;
        ShowActivated = false;
        ShowInTaskbar = false;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        Background = Brushes.White;

        var row = new DockPanel { LastChildFill = true, Margin = new Thickness(10, 7, 8, 7) };
        stopButton = Theme.Button("녹화 종료", true);
        stopButton.Margin = new Thickness(4, 0, 0, 0);
        stopButton.Click += (_, _) => stop();
        DockPanel.SetDock(stopButton, Dock.Right);
        row.Children.Add(stopButton);
        status = Theme.Label("● 녹화  00:00", 14, true);
        status.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(status);
        Content = row;

        SourceInitialized += (_, _) =>
        {
            var handle = new WindowInteropHelper(this).Handle;
            _ = SetWindowDisplayAffinity(handle, 0x11);
            var monitor = NativeMethods.ClosestMonitor(region.Left + region.Width / 2, region.Top + region.Height / 2);
            foreach (var candidate in NativeMethods.Monitors())
                if (candidate.WorkArea.Intersect(region).IsEmpty)
                {
                    monitor = candidate;
                    break;
                }
            int width = (int)Math.Ceiling(Width * monitor.ScaleX);
            int height = (int)Math.Ceiling(Height * monitor.ScaleY);
            int left = Math.Max(monitor.WorkArea.Left, monitor.WorkArea.Right - width - 12);
            int top = monitor.WorkArea.Top + 12;
            if (region.Top >= monitor.WorkArea.Top + height + 24)
                top = monitor.WorkArea.Top + 12;
            else if (region.Bottom + height + 24 <= monitor.WorkArea.Bottom)
                top = monitor.WorkArea.Bottom - height - 12;
            NativeMethods.Place(handle, new PhysicalRect(left, top, width, height));
        };
        Closing += (_, args) =>
        {
            if (finished)
                return;
            args.Cancel = true;
            stop();
        };
        timer.Tick += (_, _) => status.Text = $"● 녹화  {elapsed.Elapsed:mm\\:ss}";
        elapsed.Start();
        timer.Start();
    }

    public void Finishing()
    {
        timer.Stop();
        stopButton.IsEnabled = false;
        status.Text = "녹화 저장 중…";
    }

    public void Complete()
    {
        finished = true;
        timer.Stop();
        Close();
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowDisplayAffinity(nint window, uint affinity);
}
