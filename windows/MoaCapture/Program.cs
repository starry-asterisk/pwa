using System;
using System.Threading;
using System.Windows;
using Velopack;
namespace MoaCapture;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        // Velopack handles install/update lifecycle arguments before app initialization.
        VelopackApp.Build().SetAutoApplyOnStartup(false).Run();
        NativeMethods.SetProcessDpiAwarenessContext(new IntPtr(-4));
        AppPaths.Initialize(args);
        using var mutex = new Mutex(true, "Local\\MoaCapture", out bool firstInstance);
        bool diagnostics = Array.IndexOf(args, "--self-test") >= 0;
        if (!firstInstance && !diagnostics)
        {
            MessageBox.Show("모아 캡처가 이미 실행 중입니다. 화면 가장자리의 모아 버튼을 눌러 주세요.", "모아 캡처", MessageBoxButton.OK, MessageBoxImage.Information);
            return 0;
        }
        if (!diagnostics)
            DesktopUpdater.ApplyPendingOnCleanStart();
        try
        {
            var app = new CaptureApplication(args);
            return app.Run();
        }
        catch (Exception exception)
        {
            AppPaths.Log(exception);
            MessageBox.Show("모아 캡처를 시작하지 못했습니다. 앱을 다시 실행해 주세요.", "모아 캡처", MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }
    }
}
