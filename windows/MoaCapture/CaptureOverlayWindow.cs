using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
namespace MoaCapture;

public sealed class CaptureSession
{
    private readonly IReadOnlyList<MonitorSnapshot> snapshots;
    private readonly List<CaptureOverlayWindow> windows = new();
    private readonly TaskCompletionSource<CapturedImage?> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private NativeMethods.POINT start;
    private bool dragging, ended;
    public PhysicalRect Selection
    {
        get; private set;
    }
    public bool HasSelection => !Selection.IsEmpty;
    public CaptureSession(IReadOnlyList<MonitorSnapshot> source)
    {
        snapshots = source;
    }
    public Task<CapturedImage?> RunAsync()
    {
        try
        {
            foreach (var snapshot in snapshots)
            {
                var window = new CaptureOverlayWindow(snapshot, this);
                windows.Add(window);
                window.Show();
            }
            if (windows.Count > 0)
                windows[0].Activate();
            return completion.Task;
        }
        catch
        {
            Cancel();
            throw;
        }
    }
    public bool HasExactMonitorPlacement
    {
        get
        {
            foreach (var window in windows)
                if (!window.HasExpectedBounds())
                    return false;
            return windows.Count == snapshots.Count;
        }
    }
    public void Begin()
    {
        NativeMethods.GetCursorPos(out start);
        dragging = true;
        Selection = default;
        Redraw();
    }
    public void Move()
    {
        if (!dragging || ended)
            return;
        NativeMethods.GetCursorPos(out var end);
        Selection = PhysicalRect.Between(start, end);
        Redraw();
    }
    public void Finish()
    {
        if (ended || !dragging)
            return;
        Move();
        dragging = false;
        if (Selection.Width < 6 || Selection.Height < 6)
        {
            Selection = default;
            Redraw();
            return;
        }
        CompleteSelection(Selection);
    }
    public void CompleteSelection(PhysicalRect selection)
    {
        if (ended)
            return;
        ended = true;
        Selection = selection;
        try
        {
            var image = ScreenCapture.Crop(snapshots, selection);
            CloseWindows();
            completion.TrySetResult(image);
        }
        catch (Exception exception)
        {
            CloseWindows();
            completion.TrySetException(exception);
        }
    }
    public void Cancel()
    {
        if (ended)
            return;
        ended = true;
        CloseWindows();
        completion.TrySetResult(null);
    }
    private void Redraw()
    {
        foreach (var window in windows)
            window.Refresh();
    }
    internal void WindowClosed(CaptureOverlayWindow window)
    {
        windows.Remove(window);
        if (!ended)
            Cancel();
    }
    private void CloseWindows()
    {
        foreach (var window in windows.ToArray())
            window.Close();
        windows.Clear();
    }
}
public sealed class CaptureOverlayWindow : Window
{
    private readonly OverlaySurface surface;
    private readonly CaptureMonitor monitor;
    private readonly CaptureSession session;
    public CaptureOverlayWindow(MonitorSnapshot snapshot, CaptureSession owner)
    {
        monitor = snapshot.Monitor;
        session = owner;
        Title = "모아 캡처 영역 선택";
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        Topmost = true;
        Background = Brushes.Black;
        Cursor = Cursors.Cross;
        Width = monitor.Bounds.Width / monitor.ScaleX;
        Height = monitor.Bounds.Height / monitor.ScaleY;
        surface = new OverlaySurface(snapshot, owner);
        Content = surface;
        SourceInitialized += (_, _) => Place();
        Loaded += (_, _) => Dispatcher.BeginInvoke(DispatcherPriority.Render, new Action(Place));
        PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape) { e.Handled = true; session.Cancel(); } };
        Closed += (_, _) => session.WindowClosed(this);
        surface.MouseLeftButtonDown += (_, e) => { surface.Focus(); surface.CaptureMouse(); session.Begin(); e.Handled = true; };
        surface.MouseMove += (_, _) => session.Move();
        surface.MouseLeftButtonUp += (_, e) => { surface.ReleaseMouseCapture(); session.Finish(); e.Handled = true; };
        surface.MouseRightButtonDown += (_, _) => session.Cancel();
    }
    private void Place()
    {
        NativeMethods.Place(new WindowInteropHelper(this).Handle, monitor.Bounds);
    }
    public bool HasExpectedBounds()
    {
        return NativeMethods.GetWindowRect(new WindowInteropHelper(this).Handle, out var actual)
            && actual.ToPhysical() == monitor.Bounds;
    }
    public void Refresh() => surface.InvalidateVisual();
    private sealed class OverlaySurface : FrameworkElement
    {
        private readonly MonitorSnapshot snapshot;
        private readonly CaptureSession session;
        private readonly Brush shade = new SolidColorBrush(Color.FromArgb(110, 10, 13, 23));
        public OverlaySurface(MonitorSnapshot snapshot, CaptureSession session)
        {
            this.snapshot = snapshot;
            this.session = session;
            Focusable = true;
        }
        protected override void OnRender(DrawingContext drawing)
        {
            base.OnRender(drawing);
            if (ActualWidth <= 0 || ActualHeight <= 0)
                return;
            var full = new Rect(0, 0, ActualWidth, ActualHeight);
            drawing.DrawImage(snapshot.Image, full);
            var area = snapshot.Monitor.Bounds.Intersect(session.Selection);
            double sx = ActualWidth / snapshot.Monitor.Bounds.Width, sy = ActualHeight / snapshot.Monitor.Bounds.Height;
            if (area.IsEmpty)
                drawing.DrawRectangle(shade, null, full);
            else
            {
                var selected = new Rect((area.Left - snapshot.Monitor.Bounds.Left) * sx, (area.Top - snapshot.Monitor.Bounds.Top) * sy, area.Width * sx, area.Height * sy);
                var excluded = new CombinedGeometry(GeometryCombineMode.Exclude, new RectangleGeometry(full), new RectangleGeometry(selected));
                drawing.DrawGeometry(shade, null, excluded);
                drawing.DrawRectangle(null, new Pen(Brushes.White, 2), selected);
                drawing.DrawRectangle(null, new Pen(new SolidColorBrush(Color.FromRgb(151, 127, 244)), 1), selected);
                string dimensions = $"{session.Selection.Width} × {session.Selection.Height} px";
                DrawLabel(drawing, dimensions, Math.Max(8, Math.Min(selected.Left, ActualWidth - 180)), Math.Max(8, selected.Top - 38), 14);
            }
            DrawLabel(drawing, "드래그로 영역 선택  ·  Esc 취소", Math.Max(12, (ActualWidth - 275) / 2), 25, 14);
        }
        private void DrawLabel(DrawingContext drawing, string text, double x, double y, double size)
        {
            var formatted = new FormattedText(text, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, new Typeface("Segoe UI"), size, Brushes.White, VisualTreeHelper.GetDpi(this).PixelsPerDip);
            var background = new Rect(x - 12, y - 7, formatted.Width + 24, formatted.Height + 14);
            drawing.DrawRoundedRectangle(new SolidColorBrush(Color.FromArgb(230, 35, 32, 51)), null, background, 8, 8);
            drawing.DrawText(formatted, new Point(x, y));
        }
    }
}
