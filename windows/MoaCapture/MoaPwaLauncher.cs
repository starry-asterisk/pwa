using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MoaCapture;

internal static class MoaPwaLauncher
{
    private const string AppUrl = "https://starry-asterisk.github.io/pwa/";
    // Chromium derives this component from Moa's production manifest ID. Browser and profile prefixes/suffixes can vary.
    private const string AppIdComponent = "_crx_eipgafpodbhfcehbjghigdohjd";
    private const int Restore = 9;
    private const ushort VariantWideString = 31;
    private static readonly PropertyKey AppUserModelId = new()
    {
        FormatId = new("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3"), PropertyId = 5
    };

    public static void Open()
    {
        var existing = FindOpenWindow();
        if (IsWindow(existing))
        {
            if (IsIconic(existing))
                _ = ShowWindowAsync(existing, Restore);
            if (SetForegroundWindow(existing))
                return;
            if (IsWindow(existing))
            {
                _ = FlashWindow(existing, true);
                return;
            }
        }

        if (!TryLaunchInstalledApp())
            Process.Start(new ProcessStartInfo(AppUrl) { UseShellExecute = true });
    }

    internal static nint FindOpenWindow()
    {
        nint match = 0;
        _ = EnumWindows((window, _) =>
        {
            if (IsWindowVisible(window) && ReadAppId(window) is { } id && IsMoaAppId(id))
            {
                match = window;
                return false;
            }
            return true;
        }, 0);
        return match;
    }

    internal static bool IsMoaAppId(string candidate) => Array.Exists(candidate.Split('.'),
        part => string.Equals(part, AppIdComponent, StringComparison.OrdinalIgnoreCase));

    private static bool TryLaunchInstalledApp()
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType is null)
                return false;
            dynamic? shell = Activator.CreateInstance(shellType);
            dynamic? apps = shell?.NameSpace("shell:AppsFolder");
            if (apps is null)
                return false;

            foreach (dynamic item in apps.Items())
            {
                if (item.Path is string registeredId && IsMoaAppId(registeredId))
                {
                    item.InvokeVerb();
                    return true;
                }
            }
        }
        catch (Exception error) when (error is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
            AppPaths.Log(error);
        }
        return false;
    }

    private static string? ReadAppId(nint window)
    {
        Guid interfaceId = typeof(IPropertyStore).GUID;
        if (SHGetPropertyStoreForWindow(window, in interfaceId, out var store) < 0 || store is null)
            return null;

        var value = new PropertyValue();
        try
        {
            return store.GetValue(in AppUserModelId, out value) >= 0 && value.Type == VariantWideString
                ? Marshal.PtrToStringUni(value.Pointer) : null;
        }
        finally
        {
            _ = PropVariantClear(ref value);
            _ = Marshal.ReleaseComObject(store);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
    }

    // Native PROPVARIANT is 24 bytes on the Windows x64 target.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropertyValue
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public nint Pointer;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(in PropertyKey key, out PropertyValue value);
    }

    [DllImport("shell32.dll", ExactSpelling = true)]
    private static extern int SHGetPropertyStoreForWindow(nint window, in Guid interfaceId, out IPropertyStore? store);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int PropVariantClear(ref PropertyValue value);

    [return: MarshalAs(UnmanagedType.Bool)]
    private delegate bool WindowVisitor(nint window, nint param);

    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(WindowVisitor callback, nint param);

    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(nint window);

    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint window);

    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindowAsync(nint window, int command);

    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint window);

    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlashWindow(nint window, [MarshalAs(UnmanagedType.Bool)] bool invert);
}
