# usb-send.ps1 — envia un .bin RAW directo a la interfaz USB de la impresora
# (GUID_DEVINTERFACE_USBPRINT), sin spooler. Uso: usb-send.ps1 archivo.bin [filtroVidPid]
param([string]$File = 'test-usb.bin', [string]$Match = 'vid_0416&pid_5011')
$src = @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class UsbRaw {
  [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)] static extern int CM_Get_Device_Interface_List_SizeW(out int len, ref Guid g, string devId, int flags);
  [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)] static extern int CM_Get_Device_Interface_ListW(ref Guid g, string devId, char[] buf, int len, int flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string n, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(SafeFileHandle h, byte[] b, int n, out int w, IntPtr o);
  public static string[] List() {
    Guid g = new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2"); int len;
    int r = CM_Get_Device_Interface_List_SizeW(out len, ref g, null, 0); if (r != 0) throw new Exception("CM size cr=" + r);
    char[] buf = new char[len]; r = CM_Get_Device_Interface_ListW(ref g, null, buf, len, 0); if (r != 0) throw new Exception("CM list cr=" + r);
    return new string(buf).Split(new char[]{'\0'}, StringSplitOptions.RemoveEmptyEntries);
  }
  public static int Send(string path, byte[] data) {
    SafeFileHandle h = CreateFileW(path, 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h.IsInvalid) throw new Exception("CreateFile error=" + Marshal.GetLastWin32Error());
    int total = 0;
    try {
      while (total < data.Length) {
        int chunk = Math.Min(4096, data.Length - total); byte[] part = new byte[chunk];
        Array.Copy(data, total, part, 0, chunk); int w;
        if (!WriteFile(h, part, chunk, out w, IntPtr.Zero)) throw new Exception("WriteFile error=" + Marshal.GetLastWin32Error());
        total += w;
      }
    } finally { h.Close(); }
    return total;
  }
}
'@
Add-Type -TypeDefinition $src
$all = [UsbRaw]::List()
"Interfaces USBPRINT presentes:"; $all | ForEach-Object { "  $_" }
$dev = $all | Where-Object { $_ -match [regex]::Escape($Match) } | Select-Object -First 1
if (-not $dev) { throw "No se encontro impresora USB que coincida con '$Match'" }
$data = [IO.File]::ReadAllBytes((Resolve-Path $File))
"Enviando $($data.Length) bytes a $dev"
$n = [UsbRaw]::Send($dev, $data)
"OK: $n bytes escritos por USB"
