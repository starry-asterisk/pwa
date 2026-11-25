using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace MoaCapture;

public sealed class EdgeWindow : Window
{
    private const double IdleOpacity = .58;
    private readonly CaptureSettings settings;
    private readonly Button button;
    private readonly Grid viewport = new() { ClipToBounds = true };
    private readonly TranslateTransform slide = new();
    private readonly ContextMenu menu = new();
    // The extra hover area is sensed without making transparent pixels absorb clicks.
    private readonly DispatcherTimer hoverTimer = new(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(40) };
    private EdgePlacement placement;
    private NativeMethods.POINT pressPoint;
    private bool pressing, dragging, expanded;

    public EdgeWindow(CaptureSettings settings, Action<CaptureMode> capture, Action checkUpdates, Action exit)
    {
        this.settings = settings;
        Title = Brand.Name;
        Icon = Brand.Image;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        Width = Height = EdgePlacement.ButtonSize;
        UseLayoutRounding = true;
        button = Theme.Button("", primary: true);
        button.Opacity = IdleOpacity;
        button.Content = new Image { Source = Brand.Image, Width = 38, Height = 38 };
        button.Margin = button.Padding = new Thickness(0);
        button.BorderThickness = new Thickness(0);
        button.MinHeight = 0;
        button.RenderTransform = slide;
        viewport.Children.Add(button);
        Content = viewport;
        AutomationProperties.SetName(button, "모아 캡처 메뉴");

        foreach (var mode in CaptureOptions.Modes)
            AddItem(mode.Label, () => capture(mode.Mode));
        menu.Items.Add(new Separator());
        AddItem("모아 열기", MoaPwaLauncher.Open);
        menu.Items.Add(new Separator());
        AddItem("버튼 위치 초기화", ResetPosition);
        AddItem("업데이트 확인", checkUpdates);
        menu.Items.Add(new Separator());
        AddItem("종료", exit);
        menu.PlacementTarget = viewport;
        button.ContextMenu = menu;
        ContextMenuService.SetPlacementTarget(button, viewport);
        button.ContextMenuOpening += (_, _) => SetExpanded(true);
        menu.Closed += (_, _) => RefreshHover();
        button.Click += (_, _) =>
        {
            SetExpanded(true);
            menu.IsOpen = true;
        };

        button.MouseEnter += (_, _) => SetExpanded(true);
        button.MouseLeave += (_, _) => RefreshHover();
        hoverTimer.Tick += (_, _) => CheckHover();
        Closed += (_, _) => hoverTimer.Stop();
        button.PreviewMouseLeftButtonDown += (_, _) =>
        {
            pressing = NativeMethods.GetCursorPos(out pressPoint);
            SetExpanded(true);
        };
        button.PreviewMouseMove += TrackDrag;
        button.PreviewMouseLeftButtonUp += FinishDrag;
        button.LostMouseCapture += (_, _) =>
        {
            pressing = false;
            if (dragging)
            {
                dragging = false;
                ApplyDocking();
            }
            RefreshHover();
        };
        SourceInitialized += (_, _) => PlaceInitial();
        DpiChanged += (_, _) => Dispatcher.BeginInvoke(DispatcherPriority.Render, new Action(() =>
        {
            if (IsVisible)
                PositionWindow();
        }));
        IsVisibleChanged += (_, _) =>
        {
            if (IsVisible)
            {
                ApplyDocking();
                hoverTimer.Start();
                RefreshHover();
            }
            else
            {
                hoverTimer.Stop();
                pressing = dragging = expanded = false;
                menu.IsOpen = false;
                PositionButton(animate: false);
            }
        };
    }

    public void PlaceInitial()
    {
        NativeMethods.GetCursorPos(out var cursor);
        var monitor = NativeMethods.ClosestMonitor(settings.EdgeX ?? cursor.X, settings.EdgeY ?? cursor.Y);
        placement = EdgePlacement.Restore(monitor, settings.DockSide, settings.EdgeX, settings.EdgeY);
        ApplyDocking();
        RefreshHover();
    }

    private void TrackDrag(object sender, MouseEventArgs args)
    {
        if (!pressing || args.LeftButton != MouseButtonState.Pressed || !NativeMethods.GetCursorPos(out var cursor))
            return;
        if (!dragging
            && Math.Abs(cursor.X - pressPoint.X) < SystemParameters.MinimumHorizontalDragDistance * placement.Monitor.ScaleX
            && Math.Abs(cursor.Y - pressPoint.Y) < SystemParameters.MinimumVerticalDragDistance * placement.Monitor.ScaleY)
            return;

        if (!dragging)
        {
            dragging = true;
            PositionButton(animate: false);
        }
        Place(EdgePlacement.DragBounds(NativeMethods.ClosestMonitor(cursor.X, cursor.Y), cursor.X, cursor.Y));
    }

    private void FinishDrag(object sender, MouseButtonEventArgs args)
    {
        pressing = false;
        if (!dragging)
            return;

        dragging = false;
        args.Handled = true;
        if (NativeMethods.GetCursorPos(out var cursor))
        {
            placement = EdgePlacement.Snap(NativeMethods.ClosestMonitor(cursor.X, cursor.Y), cursor.X, cursor.Y);
            var anchor = placement.Anchor;
            settings.DockSide = placement.Edge;
            settings.EdgeX = anchor.X;
            settings.EdgeY = anchor.Y;
            SaveSettings();
        }
        ApplyDocking();
        button.ReleaseMouseCapture();
        RefreshHover();
    }

    private void PositionWindow()
    {
        if (dragging && NativeMethods.GetCursorPos(out var cursor))
            Place(EdgePlacement.DragBounds(NativeMethods.ClosestMonitor(cursor.X, cursor.Y), cursor.X, cursor.Y));
        else
            ApplyDocking();
    }

    private void RefreshHover() => Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(CheckHover));

    private void CheckHover()
    {
        if (!IsVisible || pressing || dragging || menu.IsOpen)
            return;
        SetExpanded(button.IsMouseOver || (placement.Monitor is not null
            && NativeMethods.GetCursorPos(out var cursor) && placement.IsNearHandle(cursor)));
    }

    private void SetExpanded(bool value)
    {
        if (expanded == value || !IsVisible)
            return;
        expanded = value;
        PositionButton(animate: true);
    }

    private void PositionButton(bool animate)
    {
        double x = 0, y = 0;
        double opacity = expanded ? 1 : IdleOpacity;
        if (!expanded && placement.Monitor is { } monitor)
        {
            // The clipped viewport stays inside the work area, including at monitor seams and taskbars.
            var bounds = placement.Bounds();
            double recessedX = Math.Max(0, bounds.Width / monitor.ScaleX - EdgePlacement.HandleThickness);
            double recessedY = Math.Max(0, bounds.Height / monitor.ScaleY - EdgePlacement.HandleThickness);
            x = placement.Edge == DockEdge.Left ? -recessedX : placement.Edge == DockEdge.Right ? recessedX : 0;
            y = placement.Edge == DockEdge.Top ? -recessedY : placement.Edge == DockEdge.Bottom ? recessedY : 0;
        }

        bool useMotion = animate && SystemParameters.ClientAreaAnimation;
        slide.BeginAnimation(TranslateTransform.XProperty, Transition(slide.X, x, useMotion));
        slide.X = x;
        slide.BeginAnimation(TranslateTransform.YProperty, Transition(slide.Y, y, useMotion));
        slide.Y = y;
        button.BeginAnimation(OpacityProperty, Transition(button.Opacity, opacity, useMotion));
        button.Opacity = opacity;
    }

    private static DoubleAnimation? Transition(double from, double to, bool animate) => animate && from != to
        ? new DoubleAnimation(from, to, TimeSpan.FromMilliseconds(160))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            FillBehavior = FillBehavior.Stop
        }
        : null;

    private void ApplyDocking()
    {
        if (placement.Monitor is null)
            return;
        menu.Placement = placement.Edge switch
        {
            DockEdge.Left => PlacementMode.Right,
            DockEdge.Right => PlacementMode.Left,
            DockEdge.Top => PlacementMode.Bottom,
            _ => PlacementMode.Top
        };
        ContextMenuService.SetPlacement(button, menu.Placement);
        Place(placement.Bounds());
        PositionButton(animate: false);
    }

    private void Place(PhysicalRect bounds)
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle != IntPtr.Zero)
            NativeMethods.Place(handle, bounds, show: false);
    }

    private void ResetPosition()
    {
        settings.DockSide = null;
        settings.EdgeX = settings.EdgeY = null;
        PlaceInitial();
        SaveSettings();
    }

    private void SaveSettings()
    {
        try { settings.Save(); }
        catch (Exception error) { AppPaths.Log(error); }
    }

    private void AddItem(string text, Action click)
    {
        var item = new MenuItem { Header = text };
        item.Click += (_, _) => click();
        menu.Items.Add(item);
    }
}
