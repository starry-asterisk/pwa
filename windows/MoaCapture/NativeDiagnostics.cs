using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
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
            var topLeft = fixture.PointToScreen(new Point(12, 12));
            var bottomRight = fixture.PointToScreen(new Point(fixture.ActualWidth - 24, fixture.ActualHeight - 50));
            var rectangle = new PhysicalRect((int)topLeft.X, (int)topLeft.Y, (int)(bottomRight.X - topLeft.X), (int)(bottomRight.Y - topLeft.Y));
            var snapshots = ScreenCapture.FreezeDisplays();
            foreach (var snapshot in snapshots)
                Require(snapshot.Image.PixelWidth == snapshot.Monitor.Bounds.Width && snapshot.Image.PixelHeight == snapshot.Monitor.Bounds.Height, "Physical monitor capture dimensions differ.");
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
            var automaticOpen = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            using var automaticBridge = new NativeHandoffBridge(path => automaticOpen.TrySetResult(path));
            int reopenCount = 0;
            var automaticPreview = new CaptureResultWindow(capture, recognizer, automaticBridge, path =>
            {
                Require(automaticOpen.Task.IsCompleted && path == automaticOpen.Task.Result, "Retry selected a different capture file.");
                reopenCount++;
            });
            automaticPreview.Show();
            try
            {
                Task finished = await Task.WhenAny(automaticOpen.Task, Task.Delay(15_000));
                Require(finished == automaticOpen.Task && File.Exists(await automaticOpen.Task), "The result window did not automatically hand off the OCR capture.");
                await Dispatcher.Yield(DispatcherPriority.Background);
                int stagedCount = Directory.GetFiles(Path.Combine(AppPaths.DataDirectory, "handoff"), "*.moacapture").Length;
                var reopen = FindButton(automaticPreview, "모아에서 다시 열기") ?? throw new InvalidOperationException("The staged capture retry button was not found.");
                reopen.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Dispatcher.Yield(DispatcherPriority.Background);
                Require(reopenCount == 1 && Directory.GetFiles(Path.Combine(AppPaths.DataDirectory, "handoff"), "*.moacapture").Length == stagedCount, "Retry created a duplicate capture package.");
            }
            finally { automaticPreview.Close(); }
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
                    automaticResultHandoff = true,
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
}
