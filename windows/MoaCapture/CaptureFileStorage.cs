using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace MoaCapture;

internal sealed class CaptureStorageException : IOException
{
    public CaptureStorageException(Exception innerException)
        : base("캡처 파일을 저장하지 못했습니다. 다운로드 또는 문서 폴더의 접근 권한과 저장공간을 확인한 뒤 다시 시도해 주세요.", innerException)
    {
    }
}

internal static class CaptureFileStorage
{
    internal static readonly Guid Downloads = new("374DE290-123F-4565-9164-39C4925E467B");
    internal static readonly Guid Documents = new("FDD39AD0-238F-46AF-ADB4-6C85480369C7");

    public static string GetDirectory(string? explicitDataDirectory)
    {
        // Diagnostic runs remain fully contained within their explicit project directory.
        if (explicitDataDirectory is not null)
        {
            string directory = Path.GetFullPath(Path.Combine(explicitDataDirectory, "handoff"));
            EnsureWritableDirectory(directory);
            return directory;
        }

        // Chromium can block reading captured files from LocalAppData after a launch.
        // Keep settings/logs there, but place new captures in a user document folder.
        return ResolveWritableDirectory(GetKnownFolder, EnsureWritableDirectory,
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
    }

    internal static string ResolveWritableDirectory(Func<Guid, string> getKnownFolder,
        Action<string> ensureWritableDirectory, string localApplicationData)
    {
        var failures = new List<Exception>();
        foreach (Guid folder in new[] { Downloads, Documents })
        {
            try
            {
                string parent = getKnownFolder(folder);
                if (string.IsNullOrWhiteSpace(parent) || !Path.IsPathFullyQualified(parent))
                    throw new IOException("Windows에서 사용자 폴더 경로를 찾지 못했습니다.");

                string directory = Path.GetFullPath(Path.Combine(parent, "Moa Captures"));
                if (IsWithin(directory, localApplicationData))
                    throw new IOException("사용자 폴더가 브라우저에서 접근할 수 없는 AppData 경로를 가리킵니다.");

                ensureWritableDirectory(directory);
                return directory;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException
                or System.Security.SecurityException or ArgumentException or COMException)
            {
                failures.Add(error);
            }
        }

        throw new CaptureStorageException(new AggregateException(failures));
    }

    private static bool IsWithin(string path, string directory)
    {
        if (string.IsNullOrWhiteSpace(directory))
            return false;
        string parent = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
        return path.Equals(parent, StringComparison.OrdinalIgnoreCase)
            || path.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static void EnsureWritableDirectory(string directory)
    {
        Directory.CreateDirectory(directory);
        // Probe only a fresh temporary file; never alter or migrate existing captures.
        string probe = Path.Combine(directory, $".moa-write-test-{Guid.NewGuid():N}.tmp");
        using var stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 1, FileOptions.DeleteOnClose);
        stream.WriteByte(0);
    }

    internal static string GetKnownFolder(Guid folder)
    {
        IntPtr path = IntPtr.Zero;
        try
        {
            Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(in folder, 0, IntPtr.Zero, out path));
            return Marshal.PtrToStringUni(path) ?? throw new IOException("Windows 사용자 폴더 경로가 비어 있습니다.");
        }
        finally
        {
            if (path != IntPtr.Zero)
                Marshal.FreeCoTaskMem(path);
        }
    }

    [DllImport("shell32.dll", ExactSpelling = true)]
    private static extern int SHGetKnownFolderPath(in Guid folder, uint flags,
        IntPtr token, out IntPtr path);
}
