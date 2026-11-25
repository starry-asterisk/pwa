using System;
using System.IO;
using System.Text.Json;
namespace MoaCapture;

public static class AppPaths
{
    public static string DataDirectory { get; private set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MoaCaptureData");
    public static void Initialize(string[] args)
    {
        if (Array.IndexOf(args, "--self-test") >= 0 && Array.IndexOf(args, "--data-dir") < 0)
            throw new ArgumentException("Native self-test requires an explicit --data-dir.");
        for (int index = 0; index < args.Length - 1; index++)
            if (args[index] == "--data-dir")
                DataDirectory = Path.GetFullPath(args[index + 1]);
        Directory.CreateDirectory(DataDirectory);
    }
    public static void Log(Exception exception)
    {
        try
        {
            File.AppendAllText(Path.Combine(DataDirectory, "app.log"), $"{DateTimeOffset.Now:O} {exception}\n");
        }
        catch { }
    }
}
public sealed class CaptureSettings
{
    public int? EdgeX
    {
        get; set;
    }
    public int? EdgeY
    {
        get; set;
    }
    public static CaptureSettings Load()
    {
        try
        {
            return JsonSerializer.Deserialize<CaptureSettings>(File.ReadAllText(Path.Combine(AppPaths.DataDirectory, "settings.json"))) ?? new();
        }
        catch { return new(); }
    }
    public void Save()
    {
        string path = Path.Combine(AppPaths.DataDirectory, "settings.json");
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this));
        File.Move(temporary, path, true);
    }
}
