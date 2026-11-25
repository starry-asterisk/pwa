using System;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace MoaCapture;

internal sealed class CaptureResultWindow : Window
{
    private readonly Func<Task<HandoffResult>> retry;
    private readonly TextBlock status;
    private readonly Button open;
    private readonly Button folder;
    private string? capturePath;
    private bool busy;

    public CaptureResultWindow(HandoffResult failure, Func<Task<HandoffResult>> retry, Action<Window> saveMedia)
    {
        this.retry = retry;
        Title = Brand.Name;
        Icon = Brand.Image;
        Width = 460;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        var panel = new StackPanel { Margin = new Thickness(24) };
        Content = panel;
        panel.Children.Add(Theme.Label("캡처를 모아에 전달하지 못했어요", 20, true));
        status = Theme.Label("", 14);
        status.Margin = new Thickness(0, 10, 0, 17);
        panel.Children.Add(status);
        var actions = new WrapPanel();
        panel.Children.Add(actions);
        open = Theme.Button("다시 시도", true);
        open.Click += async (_, _) => await RetryAsync();
        actions.Children.Add(open);
        folder = Theme.Button("캡처 파일 위치");
        folder.Click += (_, _) => OpenFolder();
        actions.Children.Add(folder);
        var save = Theme.Button("파일 저장");
        save.Click += (_, _) => saveMedia(this);
        actions.Children.Add(save);
        Closing += (_, eventArgs) => eventArgs.Cancel = busy;
        ShowFailure(failure);
    }

    private async Task RetryAsync()
    {
        if (busy)
            return;
        busy = true;
        open.IsEnabled = false;
        status.Text = "캡처 파일을 전달하고 있어요…";
        try
        {
            var result = await retry();
            if (result.Success)
            {
                busy = false;
                Close();
                return;
            }
            ShowFailure(result);
        }
        finally
        {
            busy = false;
            open.IsEnabled = true;
        }
    }

    private void ShowFailure(HandoffResult failure)
    {
        capturePath = failure.FilePath;
        status.Text = failure.Message;
        folder.Visibility = capturePath is null ? Visibility.Collapsed : Visibility.Visible;
    }

    private void OpenFolder()
    {
        if (capturePath is null)
            return;
        try
        {
            var info = new ProcessStartInfo("explorer.exe") { UseShellExecute = true };
            info.ArgumentList.Add("/select,");
            info.ArgumentList.Add(capturePath);
            Process.Start(info);
        }
        catch (Exception exception)
        {
            AppPaths.Log(exception);
            status.Text = $"캡처 파일: {capturePath}";
        }
    }
}
