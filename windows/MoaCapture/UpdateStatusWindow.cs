using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace MoaCapture;

internal sealed class UpdateStatusWindow : Window
{
    private readonly TextBlock status = Theme.Label("", 15);
    private readonly ProgressBar progress = new()
    {
        Foreground = Theme.Accent,
        Height = 6,
        Margin = new Thickness(0, 14, 0, 0)
    };

    public bool IsChecking => progress.IsIndeterminate;

    public UpdateStatusWindow()
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
        AutomationProperties.SetName(progress, "업데이트 확인 진행 상태");
        panel.Children.Add(status);
        panel.Children.Add(progress);

        var close = Theme.Button("닫기");
        close.HorizontalAlignment = HorizontalAlignment.Right;
        close.Margin = new Thickness(0, 18, 0, 0);
        close.Click += (_, _) => Close();
        panel.Children.Add(close);
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
        status.Text = "업데이트 확인 중…";
        progress.IsIndeterminate = true;
        progress.Visibility = Visibility.Visible;
    }

    public void ShowResult(string message)
    {
        status.Text = message;
        progress.IsIndeterminate = false;
        progress.Visibility = Visibility.Collapsed;
    }
}
