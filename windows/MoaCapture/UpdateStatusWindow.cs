using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace MoaCapture;

internal sealed class UpdateStatusWindow : Window
{
    private readonly TextBlock status = Theme.Label("", 15);
    private readonly TextBlock percentage = Theme.Label("", 15, bold: true);
    private readonly ProgressBar progress = new()
    {
        Foreground = Theme.Accent,
        Height = 6,
        Margin = new Thickness(0, 14, 0, 0)
    };
    private readonly Button restartButton = Theme.Button("다시 시작", primary: true);

    public bool IsBusy { get; private set; }

    public UpdateStatusWindow(Action restart)
    {
        Title = "모아 캡처 업데이트";
        Icon = Brand.Image;
        Width = 352;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        ShowActivated = false;
        Background = Brushes.White;

        var panel = new StackPanel { Margin = new Thickness(20) };
        AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
        AutomationProperties.SetName(progress, "업데이트 진행 상태");
        var heading = new DockPanel();
        percentage.Foreground = Theme.Muted;
        percentage.Margin = new Thickness(12, 0, 0, 0);
        DockPanel.SetDock(percentage, Dock.Right);
        heading.Children.Add(percentage);
        heading.Children.Add(status);
        panel.Children.Add(heading);
        panel.Children.Add(progress);

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 18, 0, 0)
        };
        var close = Theme.Button("닫기");
        close.Click += (_, _) => Close();
        restartButton.Margin = new Thickness(0);
        restartButton.IsDefault = true;
        restartButton.Click += (_, _) =>
        {
            restartButton.IsEnabled = false;
            restart();
        };
        actions.Children.Add(close);
        actions.Children.Add(restartButton);
        panel.Children.Add(actions);
        Content = panel;

        PreviewKeyDown += (_, args) =>
        {
            if (args.Key != Key.Escape)
                return;
            args.Handled = true;
            Close();
        };
        ShowChecking();
    }

    public void ShowChecking()
    {
        IsBusy = true;
        status.Text = "업데이트 확인 중…";
        percentage.Visibility = Visibility.Collapsed;
        progress.Value = 0;
        progress.IsIndeterminate = true;
        progress.Visibility = Visibility.Visible;
        restartButton.Visibility = Visibility.Collapsed;
    }

    public void ShowDownloading(int percent)
    {
        IsBusy = true;
        status.Text = "업데이트 다운로드 중…";
        percent = Math.Clamp(percent, 0, 100);
        percentage.Text = $"{percent}%";
        percentage.Visibility = Visibility.Visible;
        progress.IsIndeterminate = false;
        progress.Value = percent;
        progress.Visibility = Visibility.Visible;
        restartButton.Visibility = Visibility.Collapsed;
    }

    public void ShowResult(string message, bool canRestart)
    {
        IsBusy = false;
        status.Text = message;
        percentage.Visibility = Visibility.Collapsed;
        progress.IsIndeterminate = false;
        progress.Visibility = Visibility.Collapsed;
        restartButton.IsEnabled = canRestart;
        restartButton.Visibility = canRestart ? Visibility.Visible : Visibility.Collapsed;
    }
}
