using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace MoaCapture;

public sealed class EdgeWindow : Window
{
    private readonly CaptureSettings settings;
    private readonly Button button;
    private readonly Image icon;
    private readonly ContextMenu menu = new();
    private EdgePlacement placement;
    private PhysicalRect currentBounds;
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
        Width = Height = 48;
        UseLayoutRounding = true;
        icon = new Image { Source = Brand.Image, Width = 38, Height = 38 };
        button = Theme.Button("", true);
        button.Content = icon;
        button.Margin = button.Padding = new Thickness(0);
        button.BorderThickness = new Thickness(0);
        button.MinHeight = 0;
        Content = button;
        AutomationProperties.SetName(button, "모아 캡처 메뉴");
        button.ToolTip = "클릭해서 캡처 메뉴 열기 · 드래그해서 화면 가장자리로 이동";
        UpdateAppearance();

        foreach (var mode in CaptureOptions.Modes)
            AddItem(mode.Label, () => capture(mode.Mode));
        menu.Items.Add(new Separator());
        AddItem("모아 열기", MoaPwaLauncher.Open);
        menu.Items.Add(new Separator());
        AddItem("버튼 위치 초기화", ResetPosition);
        AddItem("업데이트 확인", checkUpdates);
        menu.Items.Add(new Separator());
        AddItem("종료", exit);
        menu.PlacementTarget = button;
        button.ContextMenu = menu;
        button.ContextMenuOpening += (_, _) => SetExpanded(true);
        menu.Closed += (_, _) => RefreshHover();
        button.Click += (_, _) =>
        {
            SetExpanded(true);
            menu.IsOpen = true;
        };

        MouseEnter += (_, _) => SetExpanded(true);
        MouseLeave += (_, _) => RefreshHover();
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
                RefreshHover();
            }
            else
            {
                pressing = dragging = expanded = false;
                menu.IsOpen = false;
                UpdateAppearance();
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

        dragging = true;
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

    private void RefreshHover() => Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(() =>
    {
        if (!IsVisible || pressing || dragging || menu.IsOpen)
            return;
        if (NativeMethods.GetCursorPos(out var point))
            SetExpanded(point.X >= currentBounds.Left && point.X < currentBounds.Right
                && point.Y >= currentBounds.Top && point.Y < currentBounds.Bottom);
    }));

    private void SetExpanded(bool value)
    {
        if (expanded == value || !IsVisible)
            return;
        expanded = value;
        UpdateAppearance();
        ApplyDocking();
    }

    private void UpdateAppearance()
    {
        icon.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
        Opacity = expanded ? 1 : .58;
        ToolTipService.SetIsEnabled(button, expanded);
    }

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
        Place(placement.Bounds(expanded));
    }

    private void Place(PhysicalRect bounds)
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle != IntPtr.Zero)
            NativeMethods.Place(handle, bounds, show: false);
        currentBounds = bounds;
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
