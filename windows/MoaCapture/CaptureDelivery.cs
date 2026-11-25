using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Win32;

namespace MoaCapture;

internal sealed class CaptureDelivery(OcrService recognizer, NativeHandoffBridge bridge)
{
    public async Task SendImageAsync(CapturedImage image, string title)
    {
        string text = "";
        try
        {
            text = (await recognizer.RecognizeAsync(image.PngBytes)).Text;
            if (text.Length > 100_000)
                text = text[..100_000];
        }
        catch (Exception error) { AppPaths.Log(error); }

        var capturedAt = DateTimeOffset.Now;
        var payload = new CapturePayload(image.PngBytes, text, $"{title} {capturedAt:M월 d일 HH:mm}", image.Width, image.Height, capturedAt);
        await DeliverAsync(() => bridge.OpenAsync(payload), "PNG 이미지|*.png", ".png",
            path => File.WriteAllBytes(path, image.PngBytes));
    }

    public Task SendRecordingAsync(ScreenRecording recording) => DeliverAsync(() => bridge.OpenRecordingAsync(recording),
        "MP4 동영상|*.mp4", ".mp4", path => File.Copy(recording.FilePath, path, overwrite: true));

    private async Task DeliverAsync(Func<Task<HandoffResult>> stage, string filter, string extension, Action<string> save)
    {
        string? stagedPath = null;

        async Task<HandoffResult> OpenAsync()
        {
            try
            {
                var result = stagedPath is null ? await stage() : bridge.OpenStoredFile(stagedPath);
                stagedPath = result.FilePath;
                return result;
            }
            catch (Exception error)
            {
                AppPaths.Log(error);
                string message = error is CaptureStorageException ? error.Message : "캡처 파일을 준비하지 못했습니다. 저장공간을 확인한 뒤 다시 시도해 주세요.";
                return new HandoffResult(false, message) { FilePath = stagedPath };
            }
        }

        var result = await OpenAsync();
        if (result.Success)
            return;

        var recovery = new CaptureResultWindow(result, OpenAsync, owner =>
        {
            var dialog = new SaveFileDialog
            {
                FileName = $"moa-capture-{DateTime.Now:yyyyMMdd-HHmmss}{extension}",
                Filter = filter, DefaultExt = extension, AddExtension = true
            };
            if (dialog.ShowDialog(owner) != true)
                return;
            try { save(dialog.FileName); }
            catch (Exception error)
            {
                AppPaths.Log(error);
                MessageBox.Show(owner, "파일을 저장하지 못했습니다. 폴더의 권한과 저장공간을 확인해 주세요.", Brand.Name, MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        });
        recovery.ShowDialog();
    }
}
