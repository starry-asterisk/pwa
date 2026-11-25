using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Tesseract;
namespace MoaCapture;

public sealed record LocalOcrResult(string Text, float Confidence);
public sealed class OcrService : IDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private TesseractEngine? engine;
    public async Task<LocalOcrResult> RecognizeAsync(byte[] png, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            return await Task.Run(() =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                string data = Path.Combine(AppContext.BaseDirectory, "Assets", "tessdata");
                if (!File.Exists(Path.Combine(data, "kor.traineddata")) || !File.Exists(Path.Combine(data, "eng.traineddata")))
                    throw new InvalidOperationException("텍스트 추출 파일을 찾지 못했습니다. 앱을 다시 설치해 주세요.");
                engine ??= new TesseractEngine(data, "kor+eng", EngineMode.LstmOnly);
                engine.SetVariable("preserve_interword_spaces", "1");
                using var image = Pix.LoadFromMemory(png);
                using var page = engine.Process(image, PageSegMode.Auto);
                string text = page.GetText().Replace("\r\n", "\n").Trim();
                cancellationToken.ThrowIfCancellationRequested();
                return new LocalOcrResult(text, page.GetMeanConfidence());
            }, cancellationToken);
        }
        catch (DllNotFoundException exception)
        {
            throw new InvalidOperationException("텍스트 추출 구성 요소를 실행하지 못했습니다. 앱 설치 프로그램으로 다시 설치해 주세요.", exception);
        }
        finally { gate.Release(); }
    }
    public void Dispose()
    {
        if (!gate.Wait(TimeSpan.FromSeconds(2)))
            return;
        try
        {
            engine?.Dispose();
            engine = null;
        }
        finally { gate.Release(); }
    }
}