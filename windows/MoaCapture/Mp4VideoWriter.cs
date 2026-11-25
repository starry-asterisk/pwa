using System;
using System.Runtime.InteropServices;

namespace MoaCapture;

internal sealed class Mp4VideoWriter : IDisposable
{
    // Media type attributes and subtypes from the Windows SDK's mfapi.h.
    private static readonly Guid MajorType = new("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    private static readonly Guid SubType = new("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    private static readonly Guid FrameSize = new("1652c33d-d6b2-4012-b834-72030849a37d");
    private static readonly Guid FrameRate = new("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
    private static readonly Guid PixelAspectRatio = new("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
    private static readonly Guid InterlaceMode = new("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    private static readonly Guid AverageBitRate = new("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
    private static readonly Guid DefaultStride = new("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
    private static readonly Guid YuvMatrix = new("3e23d450-2c75-4d25-a00e-b91670d12327");
    private static readonly Guid NominalRange = new("c21b8ee5-b956-4071-8daf-325edf5cab11");
    private static readonly Guid VideoProfile = new("ad76a80b-2d5c-4e0b-b375-64e520137036");
    private static readonly Guid Video = new("73646976-0000-0010-8000-00aa00389b71");
    private static readonly Guid H264 = new("34363248-0000-0010-8000-00aa00389b71");
    private static readonly Guid Nv12 = new("3231564e-0000-0010-8000-00aa00389b71");
    private const uint MediaFoundationVersion = 0x00020070;
    private const uint Progressive = 2;
    private const uint Bt601 = 2;
    private const uint LimitedRange = 2;
    private const uint H264BaselineProfile = 66;

    // Vtable slots count the three inherited IUnknown methods first. IMFSample
    // also inherits the 30 IMFAttributes methods before its own methods.
    private const int AddStreamSlot = 3, SetInputMediaTypeSlot = 4, BeginWritingSlot = 5,
        WriteSampleSlot = 6, FinalizeSinkSlot = 11;
    private const int BufferLockSlot = 3, BufferUnlockSlot = 4, SetCurrentLengthSlot = 6;
    private const int SetSampleTimeSlot = 36, SetSampleDurationSlot = 38, AddBufferSlot = 42;
    private const int SetUInt32Slot = 21, SetUInt64Slot = 22, SetGuidSlot = 24;

    private readonly uint streamIndex;
    private IntPtr writer;
    private bool comStarted, mediaFoundationStarted;

    public Mp4VideoWriter(string path, int width, int height, int frameRate, int bitRate)
    {
        try
        {
            Check(CoInitializeEx(IntPtr.Zero, 0)); // Multithreaded COM on the dedicated recorder thread.
            comStarted = true;
            Check(MFStartup(MediaFoundationVersion, 0));
            mediaFoundationStarted = true;
            Check(MFCreateSinkWriterFromURL(path, IntPtr.Zero, IntPtr.Zero, out writer));

            IntPtr output = IntPtr.Zero, input = IntPtr.Zero;
            try
            {
                Check(MFCreateMediaType(out output));
                ConfigureVideoType(output, H264, width, height, frameRate);
                SetUInt32(output, AverageBitRate, (uint)bitRate);
                SetUInt32(output, VideoProfile, H264BaselineProfile);
                Check(Bind<AddStream>(writer, AddStreamSlot)(writer, output, out streamIndex));

                Check(MFCreateMediaType(out input));
                ConfigureVideoType(input, Nv12, width, height, frameRate);
                SetUInt32(input, DefaultStride, (uint)width);
                Check(Bind<SetInputMediaType>(writer, SetInputMediaTypeSlot)(writer, streamIndex, input, IntPtr.Zero));
                Check(Bind<NoArguments>(writer, BeginWritingSlot)(writer));
            }
            finally
            {
                Release(input);
                Release(output);
            }
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or COMException)
        {
            Dispose();
            throw new InvalidOperationException("Windows에서 MP4 녹화에 필요한 Media Foundation 인코더를 시작하지 못했습니다.", error);
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public void WriteFrame(byte[] frame, long time, long duration)
    {
        IntPtr buffer = IntPtr.Zero, sample = IntPtr.Zero;
        try
        {
            Check(MFCreateMemoryBuffer((uint)frame.Length, out buffer));
            Check(Bind<LockBuffer>(buffer, BufferLockSlot)(buffer, out IntPtr bytes, IntPtr.Zero, IntPtr.Zero));
            try { Marshal.Copy(frame, 0, bytes, frame.Length); }
            finally { Check(Bind<NoArguments>(buffer, BufferUnlockSlot)(buffer)); }
            Check(Bind<SetLength>(buffer, SetCurrentLengthSlot)(buffer, (uint)frame.Length));

            Check(MFCreateSample(out sample));
            Check(Bind<SetTime>(sample, SetSampleTimeSlot)(sample, time));
            Check(Bind<SetTime>(sample, SetSampleDurationSlot)(sample, duration));
            Check(Bind<AddBuffer>(sample, AddBufferSlot)(sample, buffer));
            Check(Bind<WriteSample>(writer, WriteSampleSlot)(writer, streamIndex, sample));
        }
        finally
        {
            Release(sample);
            Release(buffer);
        }
    }

    public void Complete() => Check(Bind<NoArguments>(writer, FinalizeSinkSlot)(writer));

    public void Dispose()
    {
        Release(writer);
        writer = IntPtr.Zero;
        if (mediaFoundationStarted)
        {
            MFShutdown();
            mediaFoundationStarted = false;
        }
        if (comStarted)
        {
            CoUninitialize();
            comStarted = false;
        }
    }

    private static void ConfigureVideoType(IntPtr type, Guid subType, int width, int height, int frameRate)
    {
        Check(Bind<SetGuid>(type, SetGuidSlot)(type, in MajorType, in Video));
        Check(Bind<SetGuid>(type, SetGuidSlot)(type, in SubType, in subType));
        SetPair(type, FrameSize, (uint)width, (uint)height);
        SetPair(type, FrameRate, (uint)frameRate, 1);
        SetPair(type, PixelAspectRatio, 1, 1);
        SetUInt32(type, InterlaceMode, Progressive);
        SetUInt32(type, YuvMatrix, Bt601);
        SetUInt32(type, NominalRange, LimitedRange);
    }

    private static void SetUInt32(IntPtr type, Guid attribute, uint value) =>
        Check(Bind<SetUInt32Attribute>(type, SetUInt32Slot)(type, in attribute, value));

    private static void SetPair(IntPtr type, Guid attribute, uint high, uint low) =>
        Check(Bind<SetUInt64Attribute>(type, SetUInt64Slot)(type, in attribute, ((ulong)high << 32) | low));

    private static T Bind<T>(IntPtr instance, int slot) where T : Delegate =>
        Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size));

    private static void Check(int result)
    {
        if (result < 0)
            Marshal.ThrowExceptionForHR(result, new IntPtr(-1));
    }

    private static void Release(IntPtr instance)
    {
        if (instance != IntPtr.Zero)
            Marshal.Release(instance);
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int AddStream(IntPtr self, IntPtr targetType, out uint index);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetInputMediaType(IntPtr self, uint streamIndex, IntPtr inputType, IntPtr attributes);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int WriteSample(IntPtr self, uint streamIndex, IntPtr sample);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int NoArguments(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int LockBuffer(IntPtr self, out IntPtr bytes, IntPtr maxLength, IntPtr currentLength);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetLength(IntPtr self, uint length);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetTime(IntPtr self, long time);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int AddBuffer(IntPtr self, IntPtr buffer);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetGuid(IntPtr self, in Guid key, in Guid value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetUInt32Attribute(IntPtr self, in Guid key, uint value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetUInt64Attribute(IntPtr self, in Guid key, ulong value);

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();
    [DllImport("mfplat.dll")]
    private static extern int MFStartup(uint version, uint flags);
    [DllImport("mfplat.dll")]
    private static extern int MFShutdown();
    [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MFCreateSinkWriterFromURL(string url, IntPtr stream, IntPtr attributes, out IntPtr sink);
    [DllImport("mfplat.dll")]
    private static extern int MFCreateMediaType(out IntPtr type);
    [DllImport("mfplat.dll")]
    private static extern int MFCreateSample(out IntPtr sample);
    [DllImport("mfplat.dll")]
    private static extern int MFCreateMemoryBuffer(uint length, out IntPtr buffer);
}
