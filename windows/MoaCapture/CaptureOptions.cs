using System.Collections.Generic;

namespace MoaCapture;

public enum CaptureMode
{
    Region,
    Desktop,
    Window,
    Recording
}

internal static class CaptureOptions
{
    public static IReadOnlyList<(CaptureMode Mode, string Label)> Modes { get; } =
    [
        (CaptureMode.Region, "영역 캡처"),
        (CaptureMode.Desktop, "전체 화면 캡처"),
        (CaptureMode.Window, "창 캡처"),
        (CaptureMode.Recording, "화면 녹화")
    ];
}
