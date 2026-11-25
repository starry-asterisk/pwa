using System;
namespace MoaCapture;
public sealed record CapturePayload(byte[] PngBytes, string Text, string Title, int PixelWidth, int PixelHeight, DateTimeOffset CapturedAt);