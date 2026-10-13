// Installer-only LSA policy adapter. This code never runs in the broker or
// accepts rights chosen by a client. Only the dedicated service SID is valid.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;

public static class DshBrokerRights {
    static readonly string[] Required = { "SeServiceLogonRight", "SeCreateTokenPrivilege", "SeTcbPrivilege", "SeDebugPrivilege", "SeImpersonatePrivilege" };
    public static string[] Install(string serviceSid) { return Change(serviceSid, null); }
    public static void Remove(string serviceSid, string[] added) { Change(serviceSid, added); }
    static string[] Change(string serviceSid, string[] remove) {
        if (!Regex.IsMatch(serviceSid, @"^S-1-5-80-(?:[0-9]+-){4}[0-9]+$")) throw new ArgumentException("Expected dedicated service SID");
        var identity = new SecurityIdentifier(serviceSid); var sid = new byte[identity.BinaryLength]; identity.GetBinaryForm(sid, 0);
        var attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)) };
        IntPtr policy; Check(LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x810, out policy), "LsaOpenPolicy");
        try {
            var current = new HashSet<string>(StringComparer.Ordinal);
            IntPtr list; uint count;
            uint status = LsaEnumerateAccountRights(policy, sid, out list, out count);
            if (status != 0xC0000034) {
                Check(status, "LsaEnumerateAccountRights");
                try {
                    if (count > 128) throw new ArgumentException("Invalid rights count");
                    for (int i = 0; i < count; i++) {
                        var item = (UnicodeString)Marshal.PtrToStructure(IntPtr.Add(list, i * Marshal.SizeOf(typeof(UnicodeString))), typeof(UnicodeString));
                        current.Add(Marshal.PtrToStringUni(item.Buffer, item.Length / 2));
                    }
                } finally { LsaFreeMemory(list); }
            }
            var changes = new List<string>();
            foreach (var right in remove ?? Required) {
                if (Array.IndexOf(Required, right) < 0) throw new ArgumentException("Unexpected broker right");
                if (remove == null ? !current.Contains(right) : current.Contains(right)) changes.Add(right);
            }
            if (changes.Count == 0) return changes.ToArray();
            var values = new UnicodeString[changes.Count];
            try {
                for (int i = 0; i < values.Length; i++) values[i] = new UnicodeString { Length = checked((ushort)(changes[i].Length * 2)), MaximumLength = checked((ushort)(changes[i].Length * 2 + 2)), Buffer = Marshal.StringToHGlobalUni(changes[i]) };
                Check(remove == null ? LsaAddAccountRights(policy, sid, values, (uint)values.Length)
                    : LsaRemoveAccountRights(policy, sid, false, values, (uint)values.Length), "Broker account rights");
            } finally { foreach (var value in values) if (value.Buffer != IntPtr.Zero) Marshal.FreeHGlobal(value.Buffer); }
            return changes.ToArray();
        } finally { LsaClose(policy); }
    }
    static void Check(uint code, string name) { if (code != 0) throw new Win32Exception((int)LsaNtStatusToWinError(code), name); }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref ObjectAttributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out uint count);
    [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, UnicodeString[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool all, UnicodeString[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
    [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr memory);
    [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
}
