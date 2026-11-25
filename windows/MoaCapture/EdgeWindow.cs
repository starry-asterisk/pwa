using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
namespace MoaCapture;

public sealed class EdgeWindow : Window
{
    private readonly CaptureSettings settings;
    private readonly Button button;
    private bool pressing, moved;
    private int offsetX, offsetY;
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
        Width = 52;
        Height = 76;
        Opacity = .7;
        var panel = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        panel.Children.Add(new System.Windows.Controls.Image { Source = Brand.Image, Width = 32, Height = 32 });
        panel.Children.Add(new TextBlock { Text = "모아", FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center });
        button = Theme.Button("", true);
        button.Content = panel;
        button.Margin = new Thickness(0);
        button.Padding = new Thickness(2);
        button.BorderThickness = new Thickness(0);
        Content = button;
        AutomationProperties.SetName(button, "모아 캡처 메뉴");
        button.ToolTip = "클릭해서 캡처 메뉴 열기 · 드래그해서 위치 이동";
        MouseEnter += (_, _) => Opacity = 1;
        MouseLeave += (_, _) => { if (!pressing) Opacity = .7; };
        button.PreviewMouseLeftButtonDown += (_, _) => { pressing = true; moved = false; NativeMethods.GetCursorPos(out var p); NativeMethods.GetWindowRect(new WindowInteropHelper(this).Handle, out var r); offsetX = p.X - r.Left; offsetY = p.Y - r.Top; };
        button.PreviewMouseMove += (_, _) =>
        {
            if (!pressing || Mouse.LeftButton != MouseButtonState.Pressed)
                return;
            NativeMethods.GetCursorPos(out var p);
            NativeMethods.GetWindowRect(new WindowInteropHelper(this).Handle, out var current);
            int left = p.X - offsetX, top = p.Y - offsetY;
            if (Math.Abs(left - current.Left) + Math.Abs(top - current.Top) > 3)
                moved = true;
            if (moved)
            {
                var monitor = NativeMethods.ClosestMonitor(p.X, p.Y);
                NativeMethods.Place(new WindowInteropHelper(this).Handle, new(left, top, (int)Math.Round(52 * monitor.ScaleX), (int)Math.Round(76 * monitor.ScaleY)));
            }
        };
        button.PreviewMouseLeftButtonUp += (_, e) => { pressing = false; if (moved) { e.Handled = true; button.ReleaseMouseCapture(); SavePosition(); } moved = false; };
        var menu = new ContextMenu();
        foreach (var mode in CaptureOptions.Modes)
            AddItem(menu, mode.Label, () => capture(mode.Mode));
        menu.Items.Add(new Separator());
        AddItem(menu, "모아 열기", () => Process.Start(new ProcessStartInfo("https://starry-asterisk.github.io/pwa/") { UseShellExecute = true }));
        menu.Items.Add(new Separator());
        AddItem(menu, "버튼 위치 초기화", () => { settings.EdgeX = null; settings.EdgeY = null; PlaceInitial(); settings.Save(); });
        AddItem(menu, "업데이트 확인", checkUpdates);
        menu.Items.Add(new Separator());
        AddItem(menu, "종료", exit);
        button.ContextMenu = menu;
        button.Click += (_, _) =>
        {
            menu.PlacementTarget = button;
            menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Left;
            menu.IsOpen = true;
        };
        SourceInitialized += (_, _) =>
        {
            PlaceInitial();
        };
    }
    private static void AddItem(ContextMenu menu, string text, Action click, string gesture = "")
    {
        var item = new MenuItem { Header = text, InputGestureText = gesture };
        item.Click += (_, _) => click();
        menu.Items.Add(item);
    }
    public void PlaceInitial()
    {
        NativeMethods.GetCursorPos(out var cursor);
        int x = settings.EdgeX ?? cursor.X, y = settings.EdgeY ?? cursor.Y;
        var monitor = NativeMethods.ClosestMonitor(x, y);
        int width = (int)Math.Round(52 * monitor.ScaleX), height = (int)Math.Round(76 * monitor.ScaleY);
        int left = settings.EdgeX ?? monitor.WorkArea.Right - width - 3, top = settings.EdgeY ?? monitor.WorkArea.Top + (int)(monitor.WorkArea.Height * .42);
        left = Math.Clamp(left, monitor.WorkArea.Left, Math.Max(monitor.WorkArea.Left, monitor.WorkArea.Right - width));
        top = Math.Clamp(top, monitor.WorkArea.Top, Math.Max(monitor.WorkArea.Top, monitor.WorkArea.Bottom - height));
        NativeMethods.Place(new WindowInteropHelper(this).Handle, new(left, top, width, height));
    }
    private void SavePosition()
    {
        NativeMethods.GetWindowRect(new WindowInteropHelper(this).Handle, out var rect);
        var monitor = NativeMethods.ClosestMonitor((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
        int width = (int)Math.Round(52 * monitor.ScaleX), height = (int)Math.Round(76 * monitor.ScaleY);
        int x = (rect.Left + rect.Right) / 2 < monitor.WorkArea.Left + monitor.WorkArea.Width / 2 ? monitor.WorkArea.Left + 3 : monitor.WorkArea.Right - width - 3;
        int y = Math.Clamp(rect.Top, monitor.WorkArea.Top, Math.Max(monitor.WorkArea.Top, monitor.WorkArea.Bottom - height));
        NativeMethods.Place(new WindowInteropHelper(this).Handle, new(x, y, width, height));
        settings.EdgeX = x;
        settings.EdgeY = y;
        try
        {
            settings.Save();
        }
        catch (Exception error) { AppPaths.Log(error); }
    }
}
