using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace MoaCapture;

public sealed record ScreenRecording(string FilePath, TimeSpan Duration, int Width, int Height);

public sealed class ScreenRecorder
{
    public static readonly TimeSpan MaximumDuration = TimeSpan.FromSeconds(60);
    public const int MaximumFileBytes = 20 * 1024 * 1024;
    private const int FrameRate = 15;
    private const int TargetBitRate = 1_500_000;
    private const int MinimumDimension = 48;
    private static readonly TimeSpan FrameInterval = TimeSpan.FromTicks(TimeSpan.TicksPerSecond / FrameRate);

    private readonly object gate = new();
    private readonly ManualResetEventSlim stopSignal = new();
    private bool finished;
    private bool cancelled;

    public Task<ScreenRecording> Completion { get; }

    private ScreenRecorder(PhysicalRect region, string outputDirectory)
    {
        Completion = Task.Factory.StartNew(() => Record(region, outputDirectory), CancellationToken.None,
            TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    public static ScreenRecorder Start(PhysicalRect physicalRegion, string outputDirectory)
    {
        if (physicalRegion.Width < MinimumDimension || physicalRegion.Height < MinimumDimension)
            throw new InvalidOperationException("가로와 세로가 48픽셀 이상인 영역을 선택해 주세요.");

        return new ScreenRecorder(physicalRegion, Path.GetFullPath(outputDirectory));
    }

    public Task<ScreenRecording> StopAsync()
    {
        lock (gate)
        {
            if (!finished)
                stopSignal.Set();
        }
        return Completion;
    }

    public void Cancel()
    {
        lock (gate)
        {
            if (!finished)
            {
                cancelled = true;
                stopSignal.Set();
            }
        }
    }

    private ScreenRecording Record(PhysicalRect region, string directory)
    {
        string path = Path.Combine(directory, $".recording-{Guid.NewGuid():N}.mp4");
        bool keepFile = false;
        try
        {
            Directory.CreateDirectory(directory);
            double scale = Math.Min(1d, Math.Min(1280d / region.Width, 720d / region.Height));
            int width = Math.Max(MinimumDimension, (int)(region.Width * scale) & ~1);
            int height = Math.Max(MinimumDimension, (int)(region.Height * scale) & ~1);
            TimeSpan recordedDuration = WriteFrames(path, region, width, height);
            long length = new FileInfo(path).Length;
            if (length == 0 || length > MaximumFileBytes)
                throw new IOException("녹화 파일이 비어 있거나 20MB를 넘습니다. 녹화 영역이나 시간을 줄여 주세요.");

            lock (gate)
            {
                ThrowIfCancelled();
                finished = true;
                keepFile = true;
            }
            return new ScreenRecording(path, recordedDuration, width, height);
        }
        finally
        {
            lock (gate)
            {
                finished = true;
                stopSignal.Dispose();
            }

            if (!keepFile)
            {
                try { File.Delete(path); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { AppPaths.Log(error); }
            }
        }
    }

    private TimeSpan WriteFrames(string path, PhysicalRect region, int width, int height)
    {
        using var frame = new DesktopVideoFrame(region, width, height);
        using var writer = new Mp4VideoWriter(path, width, height, FrameRate, TargetBitRate);
        var clock = Stopwatch.StartNew();
        long endOfLastFrame = 0;
        int framesWritten = 0;
        while (true)
        {
            ThrowIfCancelled();
            long time = framesWritten == 0 ? 0 : Math.Max(clock.Elapsed.Ticks, endOfLastFrame);
            long duration = Math.Min(FrameInterval.Ticks, MaximumDuration.Ticks - time);
            if (duration <= 0)
                break;

            writer.WriteFrame(frame.CaptureNv12(), time, duration);
            endOfLastFrame = time + duration;
            framesWritten++;

            // Leave room for pending encoder output and the MP4 index written at finalization.
            if (framesWritten % FrameRate == 0 && new FileInfo(path).Length >= MaximumFileBytes * 3 / 4)
                break;

            TimeSpan remaining = TimeSpan.FromTicks(endOfLastFrame) - clock.Elapsed;
            if (stopSignal.Wait(remaining > TimeSpan.Zero ? remaining : TimeSpan.Zero))
                break;
        }
        ThrowIfCancelled();
        writer.Complete();
        return TimeSpan.FromTicks(endOfLastFrame);
    }

    private void ThrowIfCancelled()
    {
        lock (gate)
        {
            if (cancelled)
                throw new OperationCanceledException("화면 녹화를 취소했습니다.");
        }
    }
}
