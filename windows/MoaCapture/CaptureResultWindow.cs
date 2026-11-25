using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;

namespace MoaCapture;

public sealed class CaptureResultWindow : Window
{
    private readonly CapturedImage image;
    private readonly OcrService recognizer;
    private readonly NativeHandoffBridge bridge;
    private readonly Action<string> reopenCapture;
    private readonly CancellationTokenSource cancellation = new();
    private readonly TextBox title;
    private readonly TextBox text;
    private readonly TextBlock status;
    private readonly Button send;
    private readonly Button folder;
    private bool busy;
    private bool closed;
    private string? capturePath;
    private string ocrHint = "";

    public CaptureResultWindow(CapturedImage image, OcrService recognizer, NativeHandoffBridge bridge, Action<string>? reopenCapture = null)
    {
        this.image = image;
        this.recognizer = recognizer;
        this.bridge = bridge;
        this.reopenCapture = reopenCapture ?? (path => Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }));
        Title = "캡처한 기록 · 모아";
        Width = 890;
        Height = 760;
        MinWidth = 610;
        MinHeight = 570;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        NativeMethods.GetCursorPos(out var cursor);
        var currentMonitor = NativeMethods.ClosestMonitor(cursor.X, cursor.Y);
        double availableWidth = Math.Max(320, currentMonitor.WorkArea.Width / currentMonitor.ScaleX - 40);
        double availableHeight = Math.Max(300, currentMonitor.WorkArea.Height / currentMonitor.ScaleY - 40);
        Width = Math.Min(Width, availableWidth);
        Height = Math.Min(Height, availableHeight);
        MinWidth = Math.Min(MinWidth, availableWidth);
        MinHeight = Math.Min(MinHeight, availableHeight);
        MaxWidth = availableWidth;
        MaxHeight = availableHeight;
        Background = new SolidColorBrush(Color.FromRgb(247, 248, 252));
        FontFamily = new FontFamily("Segoe UI");
        var root = new Grid { Margin = new Thickness(28) };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Content = root;

        var header = new StackPanel { Margin = new Thickness(0, 0, 0, 18) };
        header.Children.Add(Theme.Label("캡처한 기록", 25, true));
        header.Children.Add(new TextBlock { Text = "화면과 읽어낸 텍스트를 자동으로 모아에 전달합니다.", Foreground = Theme.Muted, FontSize = 14, Margin = new Thickness(0, 5, 0, 0) });
        root.Children.Add(header);

        var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(scroll, 1);
        root.Children.Add(scroll);
        var body = new StackPanel();
        scroll.Content = body;
        body.Children.Add(Theme.Label("메모 제목", 14, true));
        title = Theme.TextBox($"화면 캡처 {DateTime.Now:M월 d일 HH:mm}");
        title.MaxLength = 200;
        title.Margin = new Thickness(0, 7, 0, 16);
        body.Children.Add(title);
        var preview = new Image { Source = image.Preview, Stretch = Stretch.Uniform, MaxHeight = 260 };
        body.Children.Add(new Border { Child = preview, Padding = new Thickness(12), CornerRadius = new CornerRadius(9), BorderBrush = Theme.Line, BorderThickness = new Thickness(1), Background = Brushes.White });
        body.Children.Add(new TextBlock { Text = $"{image.Width:N0} × {image.Height:N0} px · PNG", Foreground = Theme.Muted, FontSize = 13, Margin = new Thickness(0, 7, 0, 17) });
        body.Children.Add(Theme.Label("읽어낸 텍스트", 14, true));
        text = Theme.TextBox("", true);
        text.MinHeight = 160;
        text.MaxHeight = 280;
        text.MaxLength = 100_000;
        text.IsEnabled = false;
        text.Margin = new Thickness(0, 7, 0, 10);
        body.Children.Add(text);
        status = new TextBlock { Text = "이 컴퓨터에서 텍스트를 읽고 있어요…", Foreground = Theme.Muted, TextWrapping = TextWrapping.Wrap, FontSize = 14, Margin = new Thickness(0, 0, 0, 14) };
        body.Children.Add(status);

        var footer = new StackPanel { Margin = new Thickness(0, 18, 0, 0) };
        Grid.SetRow(footer, 2);
        root.Children.Add(footer);
        var buttons = new WrapPanel();
        footer.Children.Add(buttons);
        send = Theme.Button("준비 중…", true);
        send.IsEnabled = false;
        send.Click += async (_, _) => await SendAsync();
        buttons.Children.Add(send);
        var copy = Theme.Button("텍스트 복사");
        copy.Click += (_, _) => CopyText();
        buttons.Children.Add(copy);
        var save = Theme.Button("PNG 저장");
        save.Click += (_, _) => SaveImage();
        buttons.Children.Add(save);
        folder = Theme.Button("캡처 파일 위치");
        folder.Visibility = Visibility.Collapsed;
        folder.Click += (_, _) => OpenCaptureFolder();
        buttons.Children.Add(folder);
        footer.Children.Add(new TextBlock { Text = "텍스트는 이 컴퓨터에서 읽습니다. 모아에서 저장을 확인한 뒤 창을 닫아 주세요.", Foreground = Theme.Muted, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 11, 0, 0) });
        Loaded += async (_, _) => await ReadTextAsync();
        Closed += (_, _) => { closed = true; cancellation.Cancel(); };
        PreviewKeyDown += (_, eventArgs) => { if (eventArgs.Key == System.Windows.Input.Key.Escape) Close(); };
    }

    private async Task ReadTextAsync()
    {
        try
        {
            var result = await recognizer.RecognizeAsync(image.PngBytes, cancellation.Token);
            if (closed)
                return;
            text.Text = result.Text;
            status.Text = string.IsNullOrWhiteSpace(result.Text)
                ? "텍스트를 찾지 못했어요. 이미지는 그대로 보내거나 내용을 직접 적을 수 있습니다."
                : result.Text.Length > 100_000 ? "텍스트가 너무 깁니다. 10만 자 이하로 줄여서 보내 주세요." : "텍스트를 읽었습니다. 모아로 전달합니다.";
            if (string.IsNullOrWhiteSpace(result.Text))
                ocrHint = "텍스트를 찾지 못해 이미지만 전달합니다. ";
        }
        catch (OperationCanceledException) { }
        catch (Exception exception)
        {
            AppPaths.Log(exception);
            if (!closed)
            {
                ocrHint = "텍스트를 읽지 못해 이미지만 전달합니다. ";
                status.Text = ocrHint;
            }
        }
        finally
        {
            if (!closed)
            {
                text.IsEnabled = true;
                send.IsEnabled = true;
            }
        }
        if (!closed && !cancellation.IsCancellationRequested)
            await SendAsync();
    }

    private async Task SendAsync()
    {
        if (busy || closed)
            return;
        if (text.Text.Length > 100_000)
        {
            status.Text = "텍스트를 10만 자 이하로 줄여 주세요.";
            return;
        }
        busy = true;
        send.IsEnabled = false;
        status.Text = "모아로 보낼 캡처 파일을 준비하고 있어요…";
        try
        {
            if (capturePath is not null)
            {
                if (!File.Exists(capturePath))
                {
                    status.Text = "캡처 파일을 찾지 못했습니다. 새로 캡처해 주세요.";
                    return;
                }
                reopenCapture(capturePath);
                status.Text = "기존 캡처 파일을 모아에서 다시 열도록 요청했습니다. 앱에서 저장을 확인해 주세요.";
                return;
            }
            var payload = new CapturePayload(image.PngBytes, text.Text, string.IsNullOrWhiteSpace(title.Text) ? "화면 캡처" : title.Text.Trim(), image.Width, image.Height, DateTimeOffset.Now);
            var result = await bridge.OpenAsync(payload, cancellation.Token);
            if (closed)
                return;
            capturePath = result.FilePath;
            status.Text = ocrHint + result.Message
                + (capturePath is null ? "" : $"\n캡처 파일: {capturePath}");
            if (capturePath is not null)
            {
                title.IsReadOnly = true;
                text.IsReadOnly = true;
            }
            folder.Visibility = capturePath is null ? Visibility.Collapsed : Visibility.Visible;
        }
        catch (OperationCanceledException) { }
        catch (Exception exception)
        {
            AppPaths.Log(exception);
            if (!closed)
                status.Text = exception is CaptureStorageException ? exception.Message : capturePath is null
                ? "캡처 파일을 준비하지 못했습니다. 저장공간을 확인한 뒤 다시 시도해 주세요."
                : "기존 캡처 파일을 열지 못했습니다. 캡처 파일 위치에서 모아의 연결 앱을 선택해 주세요.";
        }
        finally
        {
            busy = false;
            if (!closed)
            {
                send.IsEnabled = true;
                send.Content = capturePath is null ? "다시 시도" : "모아에서 다시 열기";
            }
        }
    }

    private void CopyText()
    {
        if (string.IsNullOrWhiteSpace(text.Text))
        {
            status.Text = "복사할 텍스트가 없습니다.";
            return;
        }
        try
        {
            Clipboard.SetText(text.Text);
            status.Text = "텍스트를 복사했습니다.";
        }
        catch (Exception exception) { AppPaths.Log(exception); status.Text = "클립보드가 사용 중입니다. 잠시 뒤 다시 시도해 주세요."; }
    }

    private void SaveImage()
    {
        var dialog = new SaveFileDialog { FileName = $"moa-capture-{DateTime.Now:yyyyMMdd-HHmmss}.png", Filter = "PNG 이미지|*.png", DefaultExt = ".png", AddExtension = true };
        if (dialog.ShowDialog(this) != true)
            return;
        try
        {
            File.WriteAllBytes(dialog.FileName, image.PngBytes);
            status.Text = "PNG 이미지를 저장했습니다.";
        }
        catch (Exception exception) { AppPaths.Log(exception); status.Text = "이미지를 저장하지 못했습니다. 폴더의 권한과 저장공간을 확인해 주세요."; }
    }

    private void OpenCaptureFolder()
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
        catch (Exception exception) { AppPaths.Log(exception); status.Text = $"캡처 파일: {capturePath}"; }
    }
}
