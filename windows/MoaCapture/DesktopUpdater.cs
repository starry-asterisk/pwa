using System;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;
namespace MoaCapture;

public static class DesktopUpdater
{
    private const string RestartMessage = "새 버전을 받았습니다. 모아 캡처를 종료한 뒤 다시 실행하면 적용됩니다.";
    private static readonly object CheckLock = new();
    private static Task<string>? currentCheck;
    public static void ApplyPendingOnCleanStart()
    {
        try
        {
            var manager = CreateManager();
            if (manager.IsInstalled && manager.UpdatePendingRestart is not null)
                manager.ApplyUpdatesAndRestart(manager.UpdatePendingRestart);
        }
        catch (Exception exception) { AppPaths.Log(exception); }
    }
    public static Task<string> CheckAsync()
    {
        lock (CheckLock)
        {
            if (currentCheck is { IsCompleted: false })
                return currentCheck;
            return currentCheck = Task.Run(CheckCoreAsync);
        }
    }

    private static async Task<string> CheckCoreAsync()
    {
        try
        {
            var manager = CreateManager();
            if (!manager.IsInstalled)
                return "설치한 모아 캡처에서 자동 업데이트를 사용할 수 있습니다.";
            if (manager.UpdatePendingRestart is not null)
                return RestartMessage;
            var update = await manager.CheckForUpdatesAsync();
            if (update is null)
                return "최신 버전을 사용하고 있습니다.";
            await manager.DownloadUpdatesAsync(update);
            return RestartMessage;
        }
        catch (Exception exception) { AppPaths.Log(exception); return "업데이트를 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."; }
    }

    private static UpdateManager CreateManager() => new(
        new GithubSource("https://github.com/starry-asterisk/pwa", null, false),
        new UpdateOptions { ExplicitChannel = "win" });
}
