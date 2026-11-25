using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Win32;

namespace MoaCapture;

public sealed class CaptureApplication : System.Windows.Application
{
    private readonly string[] arguments;
    private readonly OcrService recognizer = new();
    private readonly NativeHandoffBridge bridge = new();
    private EdgeWindow? edge;
    private System.Windows.Forms.NotifyIcon? tray;
    private CaptureSession? selection;
    private bool capturing;
    private bool exiting;

    public CaptureApplication(string[] args)
    {
        arguments = args;
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        DispatcherUnhandledException += (_, eventArgs) =>
        {
            AppPaths.Log(eventArgs.Exception);
            selection?.Cancel();
            edge?.Show();
            MessageBox.Show("작업을 완료하지 못했습니다. 다시 시도해 주세요.", "모아 캡처", MessageBoxButton.OK, MessageBoxImage.Warning);
            eventArgs.Handled = true;
        };
    }

    protected override async void OnStartup(StartupEventArgs eventArgs)
    {
        base.OnStartup(eventArgs);
        if (Array.IndexOf(arguments, "--self-test") >= 0)
        {
            int code = await NativeDiagnostics.RunAsync(recognizer);
            Shutdown(code);
            return;
        }
        edge = new EdgeWindow(CaptureSettings.Load(), () => _ = StartCaptureAsync(), () => _ = ShowUpdatesAsync());
        MainWindow = edge;
        edge.Show();
        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("화면 캡처", null, (_, _) => Dispatcher.BeginInvoke(new Action(() => _ = StartCaptureAsync())));
        menu.Items.Add("버튼 표시", null, (_, _) => Dispatcher.BeginInvoke(new Action(() => { edge.Show(); edge.PlaceInitial(); })));
        menu.Items.Add("업데이트 확인", null, (_, _) => Dispatcher.BeginInvoke(new Action(() => _ = ShowUpdatesAsync())));
        menu.Items.Add("종료", null, (_, _) => Dispatcher.BeginInvoke(new Action(Shutdown)));
        tray = new System.Windows.Forms.NotifyIcon { Icon = System.Drawing.SystemIcons.Application, Text = "모아 캡처", Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += (_, _) => Dispatcher.BeginInvoke(new Action(() => _ = StartCaptureAsync()));
        SystemEvents.DisplaySettingsChanged += DisplaysChanged;
        _ = DesktopUpdater.CheckAsync();
    }

    private async Task StartCaptureAsync()
    {
        if (capturing || exiting || edge is null)
            return;
        capturing = true;
        edge.Hide();
        try
        {
            // Give DWM time to remove our edge button before freezing the displays.
            await Task.Delay(140);
            var snapshots = await Task.Run(ScreenCapture.FreezeDisplays);
            if (exiting)
                return;
            selection = new CaptureSession(snapshots);
            var captured = await selection.RunAsync();
            selection = null;
            if (captured is not null && !exiting)
            {
                var preview = new CaptureResultWindow(captured, recognizer, bridge);
                preview.ShowDialog();
            }
        }
        catch (Exception exception)
        {
            AppPaths.Log(exception);
            if (!exiting)
                MessageBox.Show(exception is InvalidOperationException ? exception.Message : "화면을 캡처하지 못했습니다. 다시 시도해 주세요.", "모아 캡처", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            selection?.Cancel();
            selection = null;
            capturing = false;
            if (!exiting)
                edge.Show();
        }
    }

    private async Task ShowUpdatesAsync()
    {
        string message = await DesktopUpdater.CheckAsync();
        if (!exiting)
            MessageBox.Show(message, "모아 캡처 업데이트", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void DisplaysChanged(object? sender, EventArgs args) => Dispatcher.BeginInvoke(DispatcherPriority.Normal, new Action(() =>
    {
        selection?.Cancel();
        if (!capturing)
            edge?.PlaceInitial();
    }));

    protected override void OnExit(ExitEventArgs eventArgs)
    {
        exiting = true;
        SystemEvents.DisplaySettingsChanged -= DisplaysChanged;
        selection?.Cancel();
        tray?.Dispose();
        bridge.Dispose();
        recognizer.Dispose();
        base.OnExit(eventArgs);
    }
}
