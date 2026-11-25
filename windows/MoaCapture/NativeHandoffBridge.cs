using System;
using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MoaCapture;

public sealed record HandoffResult(bool Success, string Message)
{
    public string? FilePath { get; init; }
}

/// <summary>
/// File handling is deliberately one way: ShellExecute confirms an open request,
/// not that the PWA saved a note. Keep the capture file as a visible fallback.
/// No HTTP listener, browser credentials, clipboard mutation, or payload URL is used.
/// </summary>
public sealed class NativeHandoffBridge : IDisposable
{
    private const int MaximumImageBytes = 25 * 1024 * 1024;
    private const int MaximumVideoBytes = 20 * 1024 * 1024;
    private const int MaximumManifestBytes = 2 * 1024 * 1024;
    private const int MaximumTextCharacters = 100_000;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };
    private readonly Action<string> requestOpen;
    private bool disposed;

    public NativeHandoffBridge(Action<string>? requestOpen = null)
    {
        this.requestOpen = requestOpen ?? (path => { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); });
    }

    public async Task<HandoffResult> OpenAsync(CapturePayload payload, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        ArgumentNullException.ThrowIfNull(payload);
        Validate(payload);
        cancellationToken.ThrowIfCancellationRequested();

        // Take a snapshot so a reused capture buffer cannot alter an in-flight package.
        var image = (byte[])payload.PngBytes.Clone();
        var id = Guid.NewGuid().ToString("D");
        var manifest = JsonSerializer.SerializeToUtf8Bytes(new
        {
            format = "moa-capture",
            schemaVersion = 1,
            id,
            createdAt = payload.CapturedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            title = payload.Title.Length <= 200 ? payload.Title : payload.Title[..200],
            text = payload.Text,
            image = new
            {
                path = "image.png",
                name = "capture.png",
                mime = "image/png",
                size = image.Length,
                width = payload.PixelWidth,
                height = payload.PixelHeight
            }
        }, JsonOptions);
        return await StageAndOpenAsync(id, manifest, "image.png", (stream, token) => stream.WriteAsync(image, token), cancellationToken);
    }

    public async Task<HandoffResult> OpenRecordingAsync(ScreenRecording recording, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        cancellationToken.ThrowIfCancellationRequested();
        await using var video = new FileStream(recording.FilePath, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous);
        byte[] header = new byte[12];
        if (video.Length < 20 || video.Length > MaximumVideoBytes || recording.Width is < 2 or > 1920 || recording.Height is < 2 or > 1080)
            throw new InvalidOperationException("전달할 녹화 파일의 크기나 해상도가 올바르지 않습니다.");
        await video.ReadExactlyAsync(header, cancellationToken);
        if (!header.AsSpan(4, 4).SequenceEqual("ftyp"u8))
            throw new InvalidOperationException("MP4 녹화 파일만 전달할 수 있습니다.");
        video.Position = 0;
        var id = Guid.NewGuid().ToString("D");
        var capturedAt = DateTimeOffset.Now;
        var manifest = JsonSerializer.SerializeToUtf8Bytes(new
        {
            format = "moa-capture",
            schemaVersion = 2,
            id,
            createdAt = capturedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            title = $"화면 녹화 {capturedAt:M월 d일 HH:mm}",
            text = "",
            video = new
            {
                path = "video.mp4",
                name = "recording.mp4",
                mime = "video/mp4",
                size = video.Length,
                width = recording.Width,
                height = recording.Height
            }
        }, JsonOptions);
        return await StageAndOpenAsync(id, manifest, "video.mp4", (stream, token) => new ValueTask(video.CopyToAsync(stream, token)), cancellationToken);
    }

    private async Task<HandoffResult> StageAndOpenAsync(string id, byte[] manifest, string mediaPath,
        Func<Stream, CancellationToken, ValueTask> writeMedia, CancellationToken cancellationToken)
    {
        if (manifest.Length > MaximumManifestBytes) throw new InvalidOperationException("캡처한 텍스트가 너무 큽니다.");
        var directory = AppPaths.GetHandoffDirectory();
        var filePath = Path.Combine(directory, $"{id}.moacapture");
        var writingPath = filePath + ".writing";
        try
        {
            await using (var stream = new FileStream(writingPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.Asynchronous))
            {
                using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
                {
                    await using (var metadata = archive.CreateEntry("manifest.json", CompressionLevel.NoCompression).Open())
                        await metadata.WriteAsync(manifest, cancellationToken);
                    await using (var media = archive.CreateEntry(mediaPath, CompressionLevel.NoCompression).Open())
                        await writeMedia(media, cancellationToken);
                }
                await stream.FlushAsync(cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            ObjectDisposedException.ThrowIf(disposed, this);
            File.Move(writingPath, filePath);
        }
        catch
        {
            TryDeleteIncomplete(writingPath);
            throw;
        }

        return OpenStoredFile(filePath);
    }

    public HandoffResult OpenStoredFile(string filePath)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!File.Exists(filePath))
            return new HandoffResult(false, "캡처 파일을 찾지 못했습니다. 파일 위치를 확인해 주세요.") { FilePath = filePath };
        try
        {
            // Use the user's OS association. Never select a browser profile,
            // register ourselves as this extension's owner, or bypass its chooser.
            requestOpen(filePath);
            return new HandoffResult(true, "모아에서 캡처 파일 열기를 요청했습니다. 앱에서 메모가 저장됐는지 확인해 주세요.") { FilePath = filePath };
        }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException)
        {
            return new HandoffResult(false, "캡처 파일을 보관했습니다. 설치한 모아를 .moacapture 파일의 연결 앱으로 선택하거나, 모아의 캡처 파일 열기로 가져와 주세요.") { FilePath = filePath };
        }
    }

    private static void Validate(CapturePayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload.PngBytes);
        ArgumentNullException.ThrowIfNull(payload.Text);
        ArgumentNullException.ThrowIfNull(payload.Title);
        if (payload.Text.Length > MaximumTextCharacters) throw new InvalidOperationException("캡처한 텍스트는 10만 자 이하만 전달할 수 있습니다. 선택 범위를 줄여 다시 시도해 주세요.");
        var image = payload.PngBytes;
        ReadOnlySpan<byte> signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (image.Length < 33 || image.Length > MaximumImageBytes || !image.AsSpan(0, 8).SequenceEqual(signature)
            || !image.AsSpan(12, 4).SequenceEqual("IHDR"u8))
            throw new InvalidOperationException("25MB 이하의 PNG 캡처 이미지만 전달할 수 있습니다.");
        var width = BinaryPrimitives.ReadUInt32BigEndian(image.AsSpan(16, 4));
        var height = BinaryPrimitives.ReadUInt32BigEndian(image.AsSpan(20, 4));
        if (width == 0 || height == 0 || width > 16_383 || height > 16_383 || (ulong)width * height > 40_000_000
            || width != payload.PixelWidth || height != payload.PixelHeight)
            throw new InvalidOperationException("캡처 이미지의 해상도가 올바르지 않습니다.");
    }

    private static void TryDeleteIncomplete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    public void Dispose() => disposed = true;
}
