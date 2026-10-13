// A narrow SYSTEM service: add one mandatory deny attribute to a caller-owned
// restricted token. It never opens files, changes ACLs, or launches commands.
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

public sealed class RootDenyBroker : ServiceBase {
    readonly string sid, pipeName;
    volatile bool stopping;
    NamedPipeServerStream listener;
    readonly SemaphoreSlim slots = new SemaphoreSlim(8);
    RootDenyBroker(string sid, string name) {
        this.sid = new SecurityIdentifier(sid).Value;
        pipeName = name;
        ServiceName = name;
        CanStop = true;
    }
    public static void Main(string[] args) {
        if (args.Length != 2 || !Regex.IsMatch(args[1], @"^DshMultiRootBroker-[a-f0-9]{16}$"))
            throw new ArgumentException("Expected installation SID and pipe name");
        ServiceBase.Run(new RootDenyBroker(args[0], args[1]));
    }
    protected override void OnStart(string[] args) {
        EnablePrivilege("SeTcbPrivilege");
        Task.Run((Action)Serve);
    }
    protected override void OnStop() {
        stopping = true;
        if (listener != null) listener.Dispose();
    }
    void Serve() {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier("S-1-5-18"), PipeAccessRights.FullControl, AccessControlType.Allow));
        // The runner reads the kernel attribute back; a spoofed ACK cannot authorize a launch.
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier("S-1-5-2"), PipeAccessRights.FullControl, AccessControlType.Deny));
        while (!stopping) {
            NamedPipeServerStream pipe = null;
            try {
                slots.Wait();
                pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous, 4096, 4096, security);
                listener = pipe;
                pipe.WaitForConnection();
                var connected = pipe;
                pipe = null;
                Task.Run(() => { try { Handle(connected); } finally { connected.Dispose(); slots.Release(); } });
            } catch { if (pipe != null) pipe.Dispose(); slots.Release(); if (stopping) return; Thread.Sleep(100); }
        }
    }
    void Handle(NamedPipeServerStream pipe) {
        try {
            // A pipe impersonation context exists only after its first read.
            // Reading a bounded request performs no privileged operation.
            var read = Task.Run(() => ReadRequest(pipe));
            if (!read.Wait(5000)) throw new System.TimeoutException("Request timeout");
            // Authenticate the pipe token, not a SID or PID supplied in data.
            string caller = null;
            pipe.RunAsClient(() => { caller = WindowsIdentity.GetCurrent().User.Value; });
            if (caller != sid) throw new UnauthorizedAccessException("Caller SID mismatch");
            uint pid;
            Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid), "GetNamedPipeClientProcessId");
            string[] fields = read.Result.Split('|');
            if (fields.Length != 3 || fields[0] != "1" || !Regex.IsMatch(fields[1], @"^[0-9]{1,20}$"))
                throw new ArgumentException("Invalid request");
            string[] roots = fields[2].Split(',');
            if (roots.Length < 1 || roots.Length > 64) throw new ArgumentException("Invalid root count");
            foreach (var root in roots)
                if (!Regex.IsMatch(root, @"^S-1-4-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-3$"))
                    throw new ArgumentException("Invalid deny identity");
            IntPtr process = OpenProcess(0x1040, false, pid); // QUERY_LIMITED_INFORMATION | DUP_HANDLE
            if (process == IntPtr.Zero) throw new Win32Exception();
            IntPtr token = IntPtr.Zero, processToken = IntPtr.Zero;
            try {
                Check(OpenProcessToken(process, 8, out processToken), "OpenProcessToken(client)");
                if (TokenSid(processToken) != sid) throw new UnauthorizedAccessException("Process SID mismatch");
                Check(DuplicateHandle(process, new IntPtr(unchecked((long)UInt64.Parse(fields[1]))), GetCurrentProcess(), out token,
                    0x88, false, 0), "DuplicateHandle(token)"); // QUERY | ADJUST_DEFAULT, never SAME_ACCESS
                if (TokenSid(token) != sid || !IsTokenRestricted(token)) throw new UnauthorizedAccessException("Not a caller-owned restricted token");
                AddAttribute(token, roots);
            } finally {
                if (token != IntPtr.Zero) CloseHandle(token);
                if (processToken != IntPtr.Zero) CloseHandle(processToken);
                CloseHandle(process);
            }
            Reply(pipe, "OK\n");
        } catch (Exception e) { try { Reply(pipe, "ERROR:" + e.GetType().Name + ":" + e.Message.Replace('\n', ' ').Replace('\r', ' ') + "\n"); } catch {} }
    }
    static string ReadRequest(Stream stream) {
        var data = new MemoryStream();
        for (int n = 0; n < 8192; n++) {
            int value = stream.ReadByte();
            if (value < 0) throw new IOException("Disconnected");
            if (value == 10) return Encoding.ASCII.GetString(data.ToArray());
            if (value < 32 || value > 126) throw new ArgumentException("Invalid byte");
            data.WriteByte((byte)value);
        }
        throw new ArgumentException("Request too large");
    }
    static void Reply(Stream stream, string value) { var bytes = Encoding.UTF8.GetBytes(value); stream.Write(bytes, 0, bytes.Length); stream.Flush(); }
    static string TokenSid(IntPtr token) {
        int length;
        GetTokenInformation(token, 1, IntPtr.Zero, 0, out length);
        if (length < IntPtr.Size || length > 65536) throw new ArgumentException("Invalid token");
        IntPtr data = Marshal.AllocHGlobal(length);
        try { Check(GetTokenInformation(token, 1, data, length, out length), "GetTokenInformation(user)"); return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; }
        finally { Marshal.FreeHGlobal(data); }
    }
    static void AddAttribute(IntPtr token, string[] roots) {
        var values = new UnicodeString[roots.Length];
        // Diagnostic variants: identical values under different flag sets, so a
        // single run can show which flag admits an attribute to the working
        // list the ACE evaluator reads.
        var variants = new[] {
            new { Name = "DshMultiRootDeniedRoots",  Flags = 0x20u },          // MANDATORY (current)
            new { Name = "DshMultiRootDeniedRootsD", Flags = 0x60u },          // + DEFAULT
            new { Name = "DshMultiRootDeniedRootsF", Flags = 0x64u },          // + DEFAULT + USE_FOR_DENY_ONLY
        };
        var names = new IntPtr[variants.Length];
        IntPtr array = IntPtr.Zero, attributeBlock = IntPtr.Zero, info = IntPtr.Zero, operation = IntPtr.Zero;
        try {
            for (int i = 0; i < roots.Length; i++) values[i] = Unicode(roots[i], Marshal.StringToHGlobalUni(roots[i]));
            array = Marshal.AllocHGlobal(values.Length * Marshal.SizeOf(typeof(UnicodeString)));
            for (int i = 0; i < values.Length; i++) Marshal.StructureToPtr(values[i], IntPtr.Add(array, i * Marshal.SizeOf(typeof(UnicodeString))), false);
            attributeBlock = Marshal.AllocHGlobal(variants.Length * Marshal.SizeOf(typeof(AttributeV1)));
            for (int i = 0; i < variants.Length; i++) {
                names[i] = Marshal.StringToHGlobalUni(variants[i].Name);
                var attribute = new AttributeV1 { Name = Unicode(variants[i].Name, names[i]), ValueType = 3, Flags = variants[i].Flags, Count = (uint)values.Length, Values = array };
                Marshal.StructureToPtr(attribute, IntPtr.Add(attributeBlock, i * Marshal.SizeOf(typeof(AttributeV1))), false);
            }
            info = Allocate(new AttributesInfo { Version = 1, Count = (uint)variants.Length, Attributes = attributeBlock });
            operation = Marshal.AllocHGlobal(4); Marshal.WriteInt32(operation, 2); // ADD only; never REPLACE/DELETE
            var input = new AttributesOperation { Attributes = info, Operations = operation };
            IntPtr data = Allocate(input);
            try { Check(SetTokenInformation(token, 39, data, Marshal.SizeOf(typeof(AttributesOperation))), "SetTokenInformation(TokenSecurityAttributes)"); }
            finally { Marshal.FreeHGlobal(data); }
        } finally {
            foreach (var value in values) if (value.Buffer != IntPtr.Zero) Marshal.FreeHGlobal(value.Buffer);
            foreach (var memory in names) if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
            foreach (var memory in new[] { array, attributeBlock, info, operation }) if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
        }
    }
    static UnicodeString Unicode(string value, IntPtr memory) { return new UnicodeString { Length = checked((ushort)(value.Length * 2)), MaximumLength = checked((ushort)(value.Length * 2 + 2)), Buffer = memory }; }
    static IntPtr Allocate<T>(T value) { var memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T))); Marshal.StructureToPtr(value, memory, false); return memory; }
    static void Check(bool ok, string name) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), name); }
    static void EnablePrivilege(string name) {
        IntPtr token; Check(OpenProcessToken(GetCurrentProcess(), 0x28, out token), "OpenProcessToken(service)");
        try { Luid luid; Check(LookupPrivilegeValue(null, name, out luid), "LookupPrivilegeValue");
            var privileges = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
            Check(AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero), "AdjustTokenPrivileges");
            int error = Marshal.GetLastWin32Error(); if (error != 0) throw new Win32Exception(error);
        } finally { CloseHandle(token); }
    }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct AttributeV1 { public UnicodeString Name; public ushort ValueType, Reserved; public uint Flags, Count; public IntPtr Values; }
    [StructLayout(LayoutKind.Sequential)] struct AttributesInfo { public ushort Version, Reserved; public uint Count; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct AttributesOperation { public IntPtr Attributes, Operations; }
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int length);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr data, int size);
    [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref TokenPrivileges privileges, int size, IntPtr previous, IntPtr returned);
}
