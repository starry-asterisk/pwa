using System;
using System.Threading;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;

namespace MoaCapture;

internal sealed record UpdateCheckResult(string Message, bool CanRestart = false);

internal sealed class UpdateCheck
{
    private int downloadProgress = -1;
    public int DownloadProgress => Volatile.Read(ref downloadProgress);
    public Task<UpdateCheckResult> Completion { get; }

    public UpdateCheck(Func<Action<int>, Task<UpdateCheckResult>> operation)
    {
        Completion = Task.Run(() => operation(percent =>
            Volatile.Write(ref downloadProgress, Math.Clamp(percent, 0, 99))));
    }
}

internal static class DesktopUpdater
{
    private static readonly UpdateCheckResult Ready = new("다운로드가 완료됐어요. 다시 시작하면 새 버전이 적용됩니다.", CanRestart: true);
    private static readonly object CheckLock = new();
    private static UpdateCheck? currentCheck;

    public static void ApplyPendingOnCleanStart()
    {
        try
        {
            var manager = CreateManager();
            if (manager.IsInstalled && manager.UpdatePendingRestart is { } pending)
                manager.ApplyUpdatesAndRestart(pending);
        }
        catch (Exception exception) { AppPaths.Log(exception); }
    }

    public static UpdateCheck BeginCheck()
    {
        lock (CheckLock)
        {
            if (currentCheck is { Completion.IsCompleted: false })
                return currentCheck;
            return currentCheck = new UpdateCheck(CheckCoreAsync);
        }
    }

    private static async Task<UpdateCheckResult> CheckCoreAsync(Action<int> downloadProgress)
    {
        bool downloading = false;
        try
        {
            var manager = CreateManager();
            if (!manager.IsInstalled)
                return new("설치한 모아 캡처에서 자동 업데이트를 사용할 수 있습니다.");
            if (manager.UpdatePendingRestart is not null)
                return Ready;
            var update = await manager.CheckForUpdatesAsync();
            if (update is null)
                return new("최신 버전을 사용하고 있습니다.");

            downloading = true;
            downloadProgress(0);
            await manager.DownloadUpdatesAsync(update, downloadProgress);
            return manager.UpdatePendingRestart is not null
                ? Ready
                : new("다운로드한 업데이트를 찾지 못했어요. 업데이트를 다시 확인해 주세요.");
        }
        catch (Exception exception)
        {
            AppPaths.Log(exception);
            return downloading
                ? new("업데이트를 다운로드하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.")
                : new("업데이트를 확인하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
        }
    }

    public static UpdateCheckResult? ScheduleRestart()
    {
        try
        {
            var manager = CreateManager();
            if (!manager.IsInstalled || manager.UpdatePendingRestart is not { } pending)
                return new("다운로드한 업데이트를 찾지 못했어요. 업데이트를 다시 확인해 주세요.");

            manager.WaitExitThenApplyUpdates(pending, restart: true);
            return null;
        }
        catch (Exception exception)
        {
            AppPaths.Log(exception);
            return new("업데이트를 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.", CanRestart: true);
        }
    }

    private static UpdateManager CreateManager() => new(
        new GithubSource("https://github.com/starry-asterisk/pwa", null, false),
        new UpdateOptions { ExplicitChannel = "win" });
}
