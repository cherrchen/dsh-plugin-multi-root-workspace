// A narrow privileged service: mirror the authenticated process identity and add
// only deny-only normal groups. It never opens files or launches commands.
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
        EnablePrivilege("SeDebugPrivilege");
        EnablePrivilege("SeImpersonatePrivilege");
        Task.Run((Action)Serve);
    }
    protected override void OnStop() {
        stopping = true;
        if (listener != null) listener.Dispose();
    }
    void Serve() {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
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
            if (fields.Length != 3 || fields[0] != "2" || !Regex.IsMatch(fields[1], @"^[0-9]{1,20}$"))
                throw new ArgumentException("Invalid request");
            string[] roots = fields[2].Split(',');
            if (roots.Length < 1 || roots.Length > 64) throw new ArgumentException("Invalid root count");
            foreach (var root in roots)
                if (!Regex.IsMatch(root, @"^S-1-4-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-3$"))
                    throw new ArgumentException("Invalid deny identity");
            IntPtr process = OpenProcess(0x1040, false, pid);
            if (process == IntPtr.Zero) throw new Win32Exception();
            IntPtr token = IntPtr.Zero, processToken = IntPtr.Zero, minted = IntPtr.Zero;
            try {
                // SeDebugPrivilege opens the process, not its token object. Acquire
                // only QUERY/QUERY_SOURCE while impersonating the authenticated
                // pipe caller, then revert before any privileged minting.
                pipe.RunAsClient(() => { Check(OpenProcessToken(process, 0x18, out processToken), "OpenProcessToken(client)"); });
                if (TokenSid(processToken) != sid || IsTokenRestricted(processToken))
                    throw new UnauthorizedAccessException("Caller process must be an unrestricted installation identity");
                Check(DuplicateHandle(process, new IntPtr(unchecked((long)UInt64.Parse(fields[1]))), GetCurrentProcess(), out token,
                    8, false, 0), "DuplicateHandle(token)");
                bool equal;
                NtCheck(NtCompareTokens(processToken, token, out equal), "NtCompareTokens");
                if (!equal) throw new UnauthorizedAccessException("Source is not the caller process token");
                minted = MintDenyToken(processToken, roots);
                IntPtr remote;
                // Only rights needed to derive and protect the launch token; no
                // group/privilege adjustment or owner changes.
                Check(DuplicateHandle(GetCurrentProcess(), minted, process, out remote,
                    0x6008B, false, 0), "DuplicateHandle(reply)"); // WRITE_DAC | READ_CONTROL | QUERY | DUPLICATE | ASSIGN_PRIMARY | ADJUST_DEFAULT
                try { Reply(pipe, "OK|" + unchecked((ulong)remote.ToInt64()) + "\n"); }
                catch {
                    IntPtr cleanup;
                    if (DuplicateHandle(process, remote, GetCurrentProcess(), out cleanup, 0, false, 1)) CloseHandle(cleanup);
                    throw;
                }
            } finally {
                if (minted != IntPtr.Zero) CloseHandle(minted);
                if (token != IntPtr.Zero) CloseHandle(token);
                if (processToken != IntPtr.Zero) CloseHandle(processToken);
                CloseHandle(process);
            }
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
    static IntPtr Query(IntPtr token, int kind) {
        int length;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out length);
        if (length < 0 || length > 1048576) throw new ArgumentException("Invalid token information size kind=" + kind + " length=" + length);
        // Empty claim/group channels can report zero bytes on the sizing call.
        // A real second query must still succeed; never infer absence from an error.
        int capacity = Math.Max(length, 16);
        var data = Marshal.AllocHGlobal(capacity);
        Marshal.Copy(new byte[capacity], 0, data, capacity);
        try { Check(GetTokenInformation(token, kind, data, capacity, out length), "GetTokenInformation(" + kind + ")"); return data; }
        catch { Marshal.FreeHGlobal(data); throw; }
    }
    static void RejectInheritedAttributes(IntPtr source) {
        int length;
        NtQuerySecurityAttributesToken(source, IntPtr.Zero, 0, IntPtr.Zero, 0, out length);
        if (length < 16 || length > 1048576) throw new ArgumentException("Invalid local attributes size");
        var data = Marshal.AllocHGlobal(length);
        try {
            NtCheck(NtQuerySecurityAttributesToken(source, IntPtr.Zero, 0, data, length, out length), "NtQuerySecurityAttributesToken(source)");
            uint count = unchecked((uint)Marshal.ReadInt32(data, 4));
            if (Marshal.ReadInt16(data) != 1 || count > 128) throw new ArgumentException("Invalid local attributes");
            var array = Marshal.ReadIntPtr(data, 8);
            for (int i = 0; i < count; i++) {
                // Native TOKEN_SECURITY_ATTRIBUTE_V1: UNICODE_STRING Name,
                // type/reserved, flags, count, values (40 bytes on 64-bit).
                if ((Marshal.ReadInt32(array, i * 40 + 20) & 1) == 0)
                    throw new UnauthorizedAccessException("Inheritable local security attributes unsupported");
            }
        } finally { Marshal.FreeHGlobal(data); }
    }
    static IntPtr MintDenyToken(IntPtr source, string[] roots) {
        EnablePrivilege("SeCreateTokenPrivilege");
        var memory = new System.Collections.Generic.List<IntPtr>();
        IntPtr token = IntPtr.Zero;
        try {
            Func<int, IntPtr> query = kind => { var p = Query(source, kind); memory.Add(p); return p; };
            // Fail closed for token types whose full authority cannot be mirrored here.
            if (Marshal.ReadInt32(query(29)) != 0 || Marshal.ReadInt32(query(21)) != 0)
                throw new UnauthorizedAccessException("Restricted or AppContainer source unsupported");
            // NtCreateTokenEx cannot silently discard enterprise/device claims.
            // This narrow broker accepts only sources without those channels.
            if (Marshal.ReadInt32(query(33), 4) != 0 || Marshal.ReadInt32(query(34), 4) != 0
                || Marshal.ReadInt32(query(37)) != 0)
                throw new UnauthorizedAccessException("Claim-bearing source unsupported");
            RejectInheritedAttributes(source);
            var user = query(1); var originalGroups = query(2); var privileges = query(3);
            var owner = query(4); var primary = query(5); var dacl = query(6); var tokenSource = query(7);
            var statistics = (TokenStatistics)Marshal.PtrToStructure(query(10), typeof(TokenStatistics));
            var session = query(12); var mandatory = query(27);
            int count = Marshal.ReadInt32(originalGroups), stride = Marshal.SizeOf(typeof(SidAttributes));
            if (count < 0 || count > 4096) throw new ArgumentException("Invalid group count");
            int offset = IntPtr.Size == 8 ? 8 : 4;
            var groups = Marshal.AllocHGlobal(offset + (count + roots.Length) * stride); memory.Add(groups);
            Marshal.WriteInt32(groups, count + roots.Length);
            for (int i = 0; i < count; i++) {
                var group = (SidAttributes)Marshal.PtrToStructure(IntPtr.Add(originalGroups, offset + i * stride), typeof(SidAttributes));
                Marshal.StructureToPtr(group, IntPtr.Add(groups, offset + i * stride), false);
            }
            for (int i = 0; i < roots.Length; i++) {
                var identity = new SecurityIdentifier(roots[i]); var bytes = new byte[identity.BinaryLength]; identity.GetBinaryForm(bytes, 0);
                var p = Marshal.AllocHGlobal(bytes.Length); memory.Add(p); Marshal.Copy(bytes, 0, p, bytes.Length);
                // NORMAL group, not a restricting SID. Cannot supply allow rights;
                // CreateRestrictedToken keeps it deny-only even when disabling it.
                Marshal.StructureToPtr(new SidAttributes { Sid = p, Attributes = 0x11 }, IntPtr.Add(groups, offset + (count + i) * stride), false);
            }
            var qos = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityQualityOfService))); memory.Add(qos);
            Marshal.StructureToPtr(new SecurityQualityOfService { Length = Marshal.SizeOf(typeof(SecurityQualityOfService)), ImpersonationLevel = 2, ContextTrackingMode = 1 }, qos, false);
            var attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)), SecurityQualityOfService = qos };
            NtCheck(NtCreateTokenEx(out token, 0xF01FF, ref attributes, 1,
                ref statistics.AuthenticationId, ref statistics.ExpirationTime, user, groups, privileges,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, mandatory, owner, primary, dacl, tokenSource), "NtCreateTokenEx");
            Check(SetTokenInformation(token, 12, session, 4), "SetTokenInformation(session)");
            var result = token; token = IntPtr.Zero; return result;
        } finally {
            if (token != IntPtr.Zero) CloseHandle(token);
            foreach (var p in memory) Marshal.FreeHGlobal(p);
        }
    }
    static void NtCheck(int code, string name) {
        if (code < 0) { int error = unchecked((int)RtlNtStatusToDosError(code)); throw new Win32Exception(error, name + " NTSTATUS=" + unchecked((uint)code).ToString("x") + " win32=" + error); }
    }
    static void Check(bool ok, string name) { if (!ok) { int error = Marshal.GetLastWin32Error(); throw new Win32Exception(error, name + " win32=" + error); } }
    static void EnablePrivilege(string name) {
        IntPtr token; Check(OpenProcessToken(GetCurrentProcess(), 0x28, out token), "OpenProcessToken(service)");
        try { Luid luid; Check(LookupPrivilegeValue(null, name, out luid), "LookupPrivilegeValue");
            var privileges = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
            Check(AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero), "AdjustTokenPrivileges");
            int error = Marshal.GetLastWin32Error(); if (error != 0) throw new Win32Exception(error, "EnablePrivilege(" + name + ") win32=" + error);
        } finally { CloseHandle(token); }
    }
    [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityQualityOfService { public int Length, ImpersonationLevel; public byte ContextTrackingMode, EffectiveOnly; }
    [StructLayout(LayoutKind.Sequential)] struct TokenStatistics { public Luid TokenId, AuthenticationId; public long ExpirationTime; public int Type, ImpersonationLevel; public uint DynamicCharged, DynamicAvailable, GroupCount, PrivilegeCount; public Luid ModifiedId; }
    [DllImport("ntdll.dll")] static extern int NtCreateTokenEx(out IntPtr token, uint access, ref ObjectAttributes attributes, int type,
        ref Luid authId, ref long expiration, IntPtr user, IntPtr groups, IntPtr privileges, IntPtr userClaims, IntPtr deviceClaims,
        IntPtr deviceGroups, IntPtr mandatory, IntPtr owner, IntPtr primary, IntPtr dacl, IntPtr source);
    [DllImport("ntdll.dll")] static extern int NtCompareTokens(IntPtr first, IntPtr second, [MarshalAs(UnmanagedType.U1)] out bool equal);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("ntdll.dll")] static extern int NtQuerySecurityAttributesToken(IntPtr token, IntPtr names, uint count, IntPtr data, int size, out int length);
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
