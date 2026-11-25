using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace MoaCapture;

public static class NativeDiagnostics
{
    public static async Task<int> RunAsync(OcrService recognizer)
    {
        string reportPath = Path.Combine(AppPaths.DataDirectory, "self-test.json");
        Window? fixture = null;
        CaptureSession? session = null;
        try
        {
            CheckSyntheticCoordinates();
            CheckHandoffDirectories();
            var panel = new StackPanel { Margin = new Thickness(36), Background = Brushes.White };
            panel.Children.Add(new TextBlock { Text = "MOA CAPTURE TEST 12345", FontSize = 34, FontWeight = FontWeights.Bold, Foreground = Brushes.Black });
            panel.Children.Add(new TextBlock { Text = "모아 화면 캡처 테스트", FontSize = 25, FontFamily = new FontFamily("Malgun Gothic"), Foreground = Brushes.Black, Margin = new Thickness(0, 24, 0, 0) });
            panel.Children.Add(new TextBlock { Text = "Frozen pixels. Local OCR. No hosted backend.", FontSize = 20, Foreground = Brushes.Black, Margin = new Thickness(0, 22, 0, 0) });
            fixture = new Window { Title = "모아 캡처 통합 테스트", Width = 760, Height = 310, Content = panel, Background = Brushes.White, Topmost = true, WindowStartupLocation = WindowStartupLocation.CenterScreen };
            fixture.Show();
            fixture.Activate();
            await Dispatcher.Yield(DispatcherPriority.Render);
            await Task.Delay(280);
            Require(Brand.Image.PixelWidth == 192, "The PWA brand image is missing from the companion.");
            using (var icon = Brand.CreateTrayIcon())
                Require(icon.Width == 32, "The companion tray icon is missing.");
            var topLeft = fixture.PointToScreen(new Point(12, 12));
            var bottomRight = fixture.PointToScreen(new Point(fixture.ActualWidth - 24, fixture.ActualHeight - 50));
            var rectangle = new PhysicalRect((int)topLeft.X, (int)topLeft.Y, (int)(bottomRight.X - topLeft.X), (int)(bottomRight.Y - topLeft.Y));
            var snapshots = ScreenCapture.FreezeDisplays();
            foreach (var snapshot in snapshots)
                Require(snapshot.Image.PixelWidth == snapshot.Monitor.Bounds.Width && snapshot.Image.PixelHeight == snapshot.Monitor.Bounds.Height, "Physical monitor capture dimensions differ.");
            var desktop = ScreenCapture.CaptureDesktop();
            Require(desktop.Width == ScreenCapture.GetDesktopBounds().Width && desktop.Height == ScreenCapture.GetDesktopBounds().Height, "Full desktop capture dimensions differ.");
            var recorder = ScreenRecorder.Start(rectangle, Path.Combine(AppPaths.DataDirectory, "recordings"));
            await Task.Delay(500);
            var recording = await recorder.StopAsync();
            Require(recording.Duration > TimeSpan.Zero && recording.Width <= 1280 && recording.Height <= 720, "The Windows recording did not produce bounded video.");
            fixture.Hide();
            session = new CaptureSession(snapshots);
            Task<CapturedImage?> selection = session.RunAsync();
            await Dispatcher.Yield(DispatcherPriority.Render);
            await Task.Delay(180);
            Require(session.HasExactMonitorPlacement, "Overlay physical bounds differ from monitor bounds.");
            session.CompleteSelection(rectangle);
            var capture = await selection ?? throw new InvalidOperationException("The frozen selection was cancelled.");
            session = null;
            File.WriteAllBytes(Path.Combine(AppPaths.DataDirectory, "self-test-capture.png"), capture.PngBytes);
            var recognized = await recognizer.RecognizeAsync(capture.PngBytes);
            Require(recognized.Text.Contains("CAPTURE", StringComparison.OrdinalIgnoreCase) && recognized.Text.Contains("12345", StringComparison.Ordinal), "The local OCR test text was not recognized.");
            string? opened = null;
            using var bridge = new NativeHandoffBridge(path => opened = path);
            var result = await bridge.OpenAsync(new CapturePayload(capture.PngBytes, recognized.Text, "모아 캡처 통합 테스트", capture.Width, capture.Height, DateTimeOffset.Now));
            Require(result.Success && result.FilePath == opened && File.Exists(opened), "The capture package was not handed to the test launcher.");
            using (var archive = ZipFile.OpenRead(opened!))
            {
                Require(archive.Entries.Count == 2 && archive.GetEntry("manifest.json") is not null && archive.GetEntry("image.png") is not null, "Invalid handoff ZIP entries.");
                using var manifest = JsonDocument.Parse(archive.GetEntry("manifest.json")!.Open());
                Require(manifest.RootElement.GetProperty("text").GetString() == recognized.Text, "OCR text was not retained in the package.");
            }
            string? automaticPath = null;
            using var automaticBridge = new NativeHandoffBridge(path => automaticPath = path);
            var delivery = new CaptureDelivery(recognizer, automaticBridge);
            await delivery.SendImageAsync(capture, "영역 캡처").WaitAsync(TimeSpan.FromSeconds(15));
            Require(automaticPath is not null && File.Exists(automaticPath) && FindRecovery() is null, "Successful capture did not open directly in the PWA.");
            automaticPath = null;
            await delivery.SendRecordingAsync(recording).WaitAsync(TimeSpan.FromSeconds(15));
            Require(automaticPath is not null && File.Exists(automaticPath) && FindRecovery() is null, "Successful recording did not open directly in the PWA.");
            using (var archive = ZipFile.OpenRead(automaticPath!))
            {
                Require(archive.Entries.Count == 2 && archive.GetEntry("video.mp4")?.Length == new FileInfo(recording.FilePath).Length, "The handoff did not include the MP4.");
                using var videoManifest = JsonDocument.Parse(archive.GetEntry("manifest.json")!.Open());
                Require(videoManifest.RootElement.GetProperty("schemaVersion").GetInt32() == 2
                    && videoManifest.RootElement.GetProperty("video").GetProperty("width").GetInt32() == recording.Width, "The MP4 manifest did not use the expected schema and dimensions.");
            }
            File.Delete(recording.FilePath);

            string? firstPath = null;
            int launchCount = 0;
            using var flakyBridge = new NativeHandoffBridge(path =>
            {
                if (++launchCount == 1)
                {
                    firstPath = path;
                    throw new System.ComponentModel.Win32Exception("No default app for the test capture.");
                }
                Require(path == firstPath, "Retry selected a different capture file.");
            });
            var recoveryDelivery = new CaptureDelivery(recognizer, flakyBridge);
            // ShowDialog runs a nested dispatcher loop, including the timer that acts on recovery.
            var recoveryHandled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            timer.Tick += (_, _) =>
            {
                if (FindRecovery() is not { } recovery)
                    return;
                timer.Stop();
                var reopen = FindButton(recovery, "다시 시도");
                if (reopen is null)
                {
                    recoveryHandled.SetException(new InvalidOperationException("The capture retry button was not found."));
                    recovery.Close();
                    return;
                }
                reopen.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                recoveryHandled.SetResult();
            };
            timer.Start();
            try
            {
                int stagedCount = Directory.GetFiles(AppPaths.GetHandoffDirectory(), "*.moacapture").Length;
                await recoveryDelivery.SendImageAsync(capture, "영역 캡처").WaitAsync(TimeSpan.FromSeconds(15));
                await recoveryHandled.Task.WaitAsync(TimeSpan.FromSeconds(2));
                Require(launchCount == 2 && FindRecovery() is null
                    && Directory.GetFiles(AppPaths.GetHandoffDirectory(), "*.moacapture").Length == stagedCount + 1, "Retry created a duplicate capture or left the recovery window open.");
            }
            finally { timer.Stop(); FindRecovery()?.Close(); }
            await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(new
            {
                passed = true,
                checks = new
                {
                    nativeCapture = true,
                    frozenOverlay = true,
                    physicalMonitorBounds = true,
                    negativeCoordinatesAndMixedDpi = true,
                    localOcr = true,
                    fileHandoff = true,
                    directHandoffWithoutPreview = true,
                    fullscreenCapture = true,
                    mp4RecordingAndHandoff = true,
                    matchingBrandAssets = true,
                    idempotentRetry = true,
                    downloadsAndDocumentsFallback = true,
                    protectedPathRejected = true,
                    explicitHandoffDirectory = true
                },
                monitorCount = snapshots.Count,
                width = capture.Width,
                height = capture.Height,
                ocrText = recognized.Text,
                captureFile = result.FilePath,
                defaultDownloadsFolder = CaptureFileStorage.GetKnownFolder(CaptureFileStorage.Downloads)
            }, new JsonSerializerOptions { WriteIndented = true }));
            return 0;
        }
        catch (Exception exception)
        {
            AppPaths.Log(exception);
            await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(new
            {
                passed = false,
                error = exception.ToString()
            }, new JsonSerializerOptions { WriteIndented = true }));
            return 1;
        }
        finally
        {
            session?.Cancel();
            fixture?.Close();
        }
    }

    private static void CheckHandoffDirectories()
    {
        string testRoot = Path.Combine(AppPaths.DataDirectory, "handoff-path-checks");
        string downloads = Path.Combine(testRoot, "Downloads");
        string documents = Path.Combine(testRoot, "Documents");
        string protectedPath = Path.Combine(testRoot, "LocalAppData");
        string expectedDownloads = Path.Combine(downloads, "Moa Captures");
        string expectedDocuments = Path.Combine(documents, "Moa Captures");
        var checkedPaths = new List<string>();

        string KnownFolder(Guid id) => id == CaptureFileStorage.Downloads ? downloads : documents;
        string selected = CaptureFileStorage.ResolveWritableDirectory(KnownFolder, checkedPaths.Add, protectedPath);
        Require(selected == expectedDownloads && checkedPaths.Count == 1, "Downloads was not the first handoff location.");

        checkedPaths.Clear();
        selected = CaptureFileStorage.ResolveWritableDirectory(KnownFolder, path =>
        {
            checkedPaths.Add(path);
            if (path == expectedDownloads)
                throw new UnauthorizedAccessException("Simulated unavailable Downloads folder.");
        }, protectedPath);
        Require(selected == expectedDocuments && checkedPaths.Count == 2, "Documents did not replace unwritable Downloads.");

        selected = CaptureFileStorage.ResolveWritableDirectory(id => id == CaptureFileStorage.Downloads
            ? throw new IOException("Simulated missing Downloads known folder.") : documents, _ => { }, protectedPath);
        Require(selected == expectedDocuments, "Missing Downloads did not use Documents.");

        checkedPaths.Clear();
        selected = CaptureFileStorage.ResolveWritableDirectory(id => id == CaptureFileStorage.Downloads
            ? Path.Combine(protectedPath, "redirected-downloads") : documents, checkedPaths.Add, protectedPath);
        Require(selected == expectedDocuments && checkedPaths.Count == 1
            && checkedPaths[0] == expectedDocuments, "A protected LocalAppData redirect was used for handoff.");

        bool rejected = false;
        try
        {
            CaptureFileStorage.ResolveWritableDirectory(KnownFolder,
                _ => throw new UnauthorizedAccessException("Simulated unwritable user folders."), protectedPath);
        }
        catch (CaptureStorageException) { rejected = true; }
        Require(rejected, "Unavailable user folders did not produce a visible storage error.");

        string expectedOverride = Path.Combine(AppPaths.DataDirectory, "handoff");
        Require(AppPaths.GetHandoffDirectory() == expectedOverride, "Explicit --data-dir no longer controls diagnostic handoff files.");
        string preservedFile = Path.Combine(expectedOverride, $"existing-{Guid.NewGuid():N}.keep");
        File.WriteAllText(preservedFile, "Keep existing capture data.");
        Require(AppPaths.GetHandoffDirectory() == expectedOverride
            && File.ReadAllText(preservedFile) == "Keep existing capture data.", "Existing handoff files were altered.");
        Require(Directory.GetFiles(expectedOverride, ".moa-write-test-*.tmp").Length == 0, "A write probe was not cleaned up.");
    }

    private static void CheckSyntheticCoordinates()
    {
        var left = new CaptureMonitor(IntPtr.Zero, new PhysicalRect(-200, 0, 200, 100), new PhysicalRect(-200, 0, 200, 100), 1, 1);
        var right = new CaptureMonitor(new IntPtr(1), new PhysicalRect(0, 0, 300, 150), new PhysicalRect(0, 0, 300, 150), 1.5, 1.5);
        var sources = new List<MonitorSnapshot> { new(left, Solid(200, 100, 255, 0, 0)), new(right, Solid(300, 150, 0, 0, 255)) };
        var crop = ScreenCapture.Crop(sources, new PhysicalRect(-50, 20, 100, 60));
        Require(crop.Width == 100 && crop.Height == 60, "Cross-monitor crop dimensions changed with DPI.");
        byte[] a = new byte[4], b = new byte[4];
        crop.Preview.CopyPixels(new Int32Rect(10, 10, 1, 1), a, 4, 0);
        crop.Preview.CopyPixels(new Int32Rect(90, 10, 1, 1), b, 4, 0);
        Require(a[2] == 255 && a[0] == 0 && b[0] == 255 && b[2] == 0, "Cross-monitor pixels are offset or rescaled.");
    }

    private static BitmapSource Solid(int width, int height, byte red, byte green, byte blue)
    {
        byte[] pixels = new byte[width * height * 4];
        for (int index = 0; index < pixels.Length; index += 4)
        {
            pixels[index] = blue;
            pixels[index + 1] = green;
            pixels[index + 2] = red;
            pixels[index + 3] = 255;
        }
        var bitmap = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgra32, null, pixels, width * 4);
        bitmap.Freeze();
        return bitmap;
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private static Button? FindButton(DependencyObject root, string caption)
    {
        if (root is Button button && button.Content is string content && content == caption)
            return button;
        foreach (object child in LogicalTreeHelper.GetChildren(root))
            if (child is DependencyObject dependency && FindButton(dependency, caption) is Button found)
                return found;
        return null;
    }

    private static CaptureResultWindow? FindRecovery() => Application.Current.Windows.OfType<CaptureResultWindow>().FirstOrDefault();
}
