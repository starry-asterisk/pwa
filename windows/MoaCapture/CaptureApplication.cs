using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace MoaCapture;

public sealed class CaptureApplication : Application
{
    private readonly string[] arguments;
    private readonly OcrService recognizer = new();
    private readonly NativeHandoffBridge bridge = new();
    private readonly CaptureDelivery delivery;
    private EdgeWindow? edge;
    private Forms.NotifyIcon? tray;
    private Forms.ToolStripMenuItem? trayStop;
    private System.Drawing.Icon? trayIcon;
    private CaptureSession? selection;
    private ScreenRecorder? recorder;
    private RecordingWindow? recordingControls;
    private UpdateStatusWindow? updateStatus;
    private bool capturing;
    private bool exitRequested;

    public CaptureApplication(string[] args)
    {
        arguments = args;
        delivery = new CaptureDelivery(recognizer, bridge);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        DispatcherUnhandledException += (_, eventArgs) =>
        {
            AppPaths.Log(eventArgs.Exception);
            selection?.Cancel();
            if (!capturing && !exitRequested)
                edge?.Show();
            MessageBox.Show("작업을 완료하지 못했습니다. 다시 시도해 주세요.", Brand.Name, MessageBoxButton.OK, MessageBoxImage.Warning);
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
        edge = new EdgeWindow(CaptureSettings.Load(), mode => _ = StartCaptureAsync(mode), () => _ = ShowUpdatesAsync(), RequestExit);
        MainWindow = edge;
        edge.Show();
        var menu = new Forms.ContextMenuStrip();
        foreach (var option in CaptureOptions.Modes)
            menu.Items.Add(option.Label, null, (_, _) => Dispatcher.BeginInvoke(new Action(() => _ = StartCaptureAsync(option.Mode))));
        trayStop = new Forms.ToolStripMenuItem("녹화 종료") { Enabled = false };
        trayStop.Click += (_, _) => Dispatcher.BeginInvoke(new Action(StopRecording));
        menu.Items.Add(trayStop);
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("버튼 표시", null, (_, _) => Dispatcher.BeginInvoke(new Action(() =>
        {
            if (!capturing)
            {
                edge.Show();
                edge.PlaceInitial();
            }
        })));
        menu.Items.Add("업데이트 확인", null, (_, _) => Dispatcher.BeginInvoke(new Action(() => _ = ShowUpdatesAsync())));
        menu.Items.Add("종료", null, (_, _) => Dispatcher.BeginInvoke(new Action(RequestExit)));
        trayIcon = Brand.CreateTrayIcon();
        tray = new Forms.NotifyIcon { Icon = trayIcon, Text = Brand.Name, Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += (_, _) => Dispatcher.BeginInvoke(new Action(() => _ = StartCaptureAsync(CaptureMode.Region)));
        SystemEvents.DisplaySettingsChanged += DisplaysChanged;
        DesktopUpdater.BeginCheck();
    }

    private async Task StartCaptureAsync(CaptureMode mode)
    {
        if (capturing || exitRequested || edge is null)
            return;
        capturing = true;
        edge.Hide();
        updateStatus?.Hide();
        try
        {
            if (mode == CaptureMode.Recording)
            {
                await RecordAsync();
                return;
            }

            var image = mode switch
            {
                CaptureMode.Region => await SelectImageAsync(),
                CaptureMode.Desktop => await CaptureDesktopAsync(),
                CaptureMode.Window => await CaptureWindowAsync(),
                _ => null
            };
            if (image is not null && !exitRequested)
            {
                string title = mode switch
                {
                    CaptureMode.Desktop => "전체 화면 캡처",
                    CaptureMode.Window => "창 캡처",
                    _ => "영역 캡처"
                };
                await delivery.SendImageAsync(image, title);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            AppPaths.Log(error);
            if (!exitRequested)
            {
                string message = mode == CaptureMode.Recording ? "화면을 녹화하지 못했습니다. 다시 시도해 주세요." : "화면을 캡처하지 못했습니다. 다시 시도해 주세요.";
                MessageBox.Show(error is InvalidOperationException ? error.Message : message, Brand.Name, MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        finally
        {
            selection?.Cancel();
            selection = null;
            capturing = false;
            if (exitRequested)
                Shutdown();
            else
            {
                edge.Show();
                updateStatus?.Show();
            }
        }
    }

    private async Task<CaptureSession> StartSelectionAsync()
    {
        // Wait for the desktop compositor to hide our menu and edge button.
        await Task.Delay(140);
        var snapshots = await Task.Run(ScreenCapture.FreezeDisplays);
        return selection = new CaptureSession(snapshots);
    }

    private async Task<CapturedImage?> SelectImageAsync()
    {
        var session = await StartSelectionAsync();
        if (exitRequested)
            return null;
        var result = await session.RunAsync();
        selection = null;
        return result;
    }

    private static async Task<CapturedImage> CaptureDesktopAsync()
    {
        await Task.Delay(140);
        return await Task.Run(ScreenCapture.CaptureDesktop);
    }

    private static async Task<CapturedImage?> CaptureWindowAsync()
    {
        var windows = await Task.Run(ScreenCapture.GetWindows);
        if (windows.Count == 0)
            throw new InvalidOperationException("캡처할 수 있는 열린 창이 없습니다.");
        var picker = new CaptureChoiceWindow<WindowCaptureTarget>("캡처할 창 선택", null, windows, "창 캡처");
        if (picker.ShowDialog() != true || picker.Choice is not { } choice)
            return null;
        await Task.Delay(140);
        return await Task.Run(() => ScreenCapture.CaptureWindow(choice.Handle));
    }

    private async Task RecordAsync()
    {
        var picker = new CaptureChoiceWindow<string>("녹화할 화면 선택", "최대 60초 동안 화면을 녹화합니다.",
            ["영역 선택", "전체 화면"], "선택");
        if (picker.ShowDialog() != true || exitRequested)
            return;

        PhysicalRect region;
        if (picker.Choice == "전체 화면")
            region = ScreenCapture.GetDesktopBounds();
        else
        {
            var session = await StartSelectionAsync();
            if (exitRequested)
                return;
            var area = await session.SelectAsync();
            selection = null;
            if (area is not PhysicalRect selected)
                return;
            region = selected;
        }

        await Task.Delay(140);
        if (exitRequested)
            return;
        var current = ScreenRecorder.Start(region, Path.Combine(AppPaths.DataDirectory, "recordings"));
        ScreenRecording? recording = null;
        recorder = current;
        try
        {
            trayStop!.Enabled = true;
            recordingControls = new RecordingWindow(region, StopRecording);
            recordingControls.Show();
            recording = await current.Completion;
            CloseRecordingControls();
            await delivery.SendRecordingAsync(recording);
        }
        finally
        {
            CloseRecordingControls();
            if (recording is not null)
            {
                try { File.Delete(recording.FilePath); }
                catch (IOException error) { AppPaths.Log(error); }
                catch (UnauthorizedAccessException error) { AppPaths.Log(error); }
            }
            else
                current.Cancel();
        }
    }

    private void StopRecording()
    {
        if (recorder is null || trayStop?.Enabled != true)
            return;
        trayStop.Enabled = false;
        recordingControls?.Finishing();
        _ = recorder.StopAsync();
    }

    private void CloseRecordingControls()
    {
        recorder = null;
        if (trayStop is not null)
            trayStop.Enabled = false;
        recordingControls?.Complete();
        recordingControls = null;
    }

    private void RequestExit()
    {
        exitRequested = true;
        if (!capturing)
        {
            Shutdown();
            return;
        }

        selection?.Cancel();
        StopRecording();
    }

    private async Task ShowUpdatesAsync()
    {
        if (capturing || exitRequested)
            return;

        var status = updateStatus;
        if (status is null)
        {
            status = new UpdateStatusWindow(RestartToApplyUpdate);
            updateStatus = status;
            status.Closed += (_, _) => updateStatus = null;
            status.Show();
            status.Activate();
        }
        else
        {
            if (status.WindowState == WindowState.Minimized)
                status.WindowState = WindowState.Normal;
            status.Activate();
            if (status.IsBusy)
                return;
            status.ShowChecking();
        }

        await Dispatcher.Yield(DispatcherPriority.Background);
        if (exitRequested || !ReferenceEquals(updateStatus, status))
            return;

        var check = DesktopUpdater.BeginCheck();
        int lastProgress = -1;
        void RefreshProgress()
        {
            int percent = check.DownloadProgress;
            if (percent >= 0 && percent != lastProgress)
            {
                lastProgress = percent;
                status.ShowDownloading(percent);
            }
        }

        var progressTimer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(100) };
        progressTimer.Tick += (_, _) => RefreshProgress();
        EventHandler stopTimer = (_, _) => progressTimer.Stop();
        status.Closed += stopTimer;
        try
        {
            RefreshProgress();
            progressTimer.Start();
            var result = await check.Completion;
            if (!exitRequested && ReferenceEquals(updateStatus, status))
                status.ShowResult(result.Message, result.CanRestart);
        }
        finally
        {
            progressTimer.Stop();
            status.Closed -= stopTimer;
        }
    }

    private void RestartToApplyUpdate()
    {
        if (capturing || exitRequested)
            return;

        var error = DesktopUpdater.ScheduleRestart();
        if (error is not null)
        {
            updateStatus?.ShowResult(error.Message, error.CanRestart);
            return;
        }

        RequestExit();
    }

    private void DisplaysChanged(object? sender, EventArgs args) => Dispatcher.BeginInvoke(DispatcherPriority.Normal, new Action(() =>
    {
        selection?.Cancel();
        StopRecording();
        if (!capturing)
            edge?.PlaceInitial();
    }));

    protected override void OnExit(ExitEventArgs eventArgs)
    {
        exitRequested = true;
        SystemEvents.DisplaySettingsChanged -= DisplaysChanged;
        selection?.Cancel();
        recorder?.Cancel();
        tray?.Dispose();
        trayIcon?.Dispose();
        bridge.Dispose();
        recognizer.Dispose();
        base.OnExit(eventArgs);
    }
}
