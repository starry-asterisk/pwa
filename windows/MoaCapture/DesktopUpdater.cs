using System;
using System.Threading;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;
namespace MoaCapture;

public static class DesktopUpdater
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    public static void ApplyPendingOnCleanStart()
    {
        try
        {
            var manager = new UpdateManager(new GithubSource("https://github.com/starry-asterisk/pwa", null, false), new UpdateOptions { ExplicitChannel = "win" });
            if (manager.IsInstalled && manager.UpdatePendingRestart is not null)
                manager.ApplyUpdatesAndRestart(manager.UpdatePendingRestart);
        }
        catch (Exception exception) { AppPaths.Log(exception); }
    }
    public static async Task<string> CheckAsync()
    {
        if (!await Gate.WaitAsync(0))
            return "이미 업데이트를 확인하고 있습니다.";
        try
        {
            var manager = new UpdateManager(new GithubSource("https://github.com/starry-asterisk/pwa", null, false), new UpdateOptions { ExplicitChannel = "win" });
            if (!manager.IsInstalled)
                return "설치한 모아 캡처에서 자동 업데이트를 사용할 수 있습니다.";
            var update = await manager.CheckForUpdatesAsync();
            if (update is null)
                return "최신 버전을 사용하고 있습니다.";
            await manager.DownloadUpdatesAsync(update);
            return "새 버전을 받았습니다. 모아 캡처를 종료한 뒤 다시 실행하면 적용됩니다.";
        }
        catch (Exception exception) { AppPaths.Log(exception); return "업데이트를 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."; }
        finally { Gate.Release(); }
    }
}
