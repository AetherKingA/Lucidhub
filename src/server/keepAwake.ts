import { type ChildProcess, spawn } from "node:child_process";

/**
 * Stops Windows from sleeping while the server runs. A hidden PowerShell process asks Windows to keep
 * the system awake (the same request video players make) and exits when the server exits, which
 * releases the request. The display can still turn off. Does nothing on other platforms.
 */
export function keepAwake(): ChildProcess | null {
  if (process.platform !== "win32") return null;
  const script = `
    $t = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace W -PassThru
    $null = $t::SetThreadExecutionState([uint32]"0x80000001")
    Wait-Process -Id ${process.pid}
  `;
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => console.warn("[power] Could not prevent sleep; keep the PC awake manually."));
    return child;
  } catch {
    return null;
  }
}
