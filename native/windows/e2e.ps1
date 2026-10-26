# Windows 小帮手的真机检查：在桌面会话里起 key-helper.exe，用 bind 下发热键，用 SendInput 模拟按键和点击，
# 看它报的事件对不对，再往记事本里贴一段字、读回来对一遍。要在有人登录的桌面上跑（scripts/dev/win-desktop.sh - < 这个文件）。
# 会弹出一个记事本窗口、往里贴字，跑完自己关掉；剪贴板里原来的东西跑完还在。
# 读回记事本里的字靠全选、复制（Ctrl 组合键不经过输入法）；不模拟敲字母：中文系统默认开着拼音，字母会进候选框。
# 热键只用右 Ctrl、F13、esc：单按它们哪个应用都不会有反应；不碰 Win（会开开始菜单）。Alt 只在记事本里查菜单栏时按：
# 那几下要的就是看它叫不叫出菜单栏。
# 按键分三种模拟法各来一遍（docs/hotkey-research.md 4.2）：只给扫描码（KEYEVENTF_SCANCODE，最像真键盘）、
# 只给 vk（别的工具常这么发，扫描码是 0）、两个都给。
# 录键（record）、查组合有没有被占（probe）、info 也各查一遍：录键只按右 Ctrl、F13，录到的键整段吞掉，前台应用收不到。
# 录键里有一段要等 30 秒（查到点自己停），整个脚本要多跑半分钟：win-desktop.sh 默认只等 60 秒，
# 跑的时候写 WAIT=120 scripts/dev/win-desktop.sh - < 这个文件。
# 菜单栏叫没叫出来看 UI Automation 报的焦点：Win11 的记事本选中菜单栏时焦点在"文件"那个菜单项上（10-22 实测）。
# 划词翻译要的两样也在这里查：selection（记事本里全选、什么都没选；有 Edge 的话再开一个只有一段正文、一个输入框的本地网页，
# 用临时的用户目录、InPrivate 窗口，跑完关掉删掉），capture 带 outside（块外的点击报 outside 并放行、块里的照旧吞）。
# 左键放没放行看 GetAsyncKeyState：钩子吞掉的按下系统不记，和键盘一样。
# 模拟复制那条兜底路：记事本和 Edge 都支持 UIA 走不到它，另开一个自己画字的窗口（CopyWindow：UIA 里只是个 Pane，
# 没有 TextPattern，只认 Ctrl+C 往剪贴板里放一段字），一分钟后自己关，跑完也会关掉。它也能慢一步才写剪贴板，
# 查晚到的复制会不会被还原。终端里没选中时不该发 Ctrl+C（会中断正在跑的程序）：开一个经典控制台跑 ping -t，
# 按一次 selection，看 ping 还在不在，跑完关掉。
# 没查的：Office 这类应用、开始菜单（Win 键）。
$ErrorActionPreference = 'Stop'
$repo = "$HOME\orangespeakeasy-dev\repo"

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Fake {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public KEYBDINPUT k; [FieldOffset(0)] public MOUSEINPUT m; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  // 窗口在屏幕上的框：不经过 UIA（问 UIA 会让 Chromium 先把无障碍树建起来）
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  // 系统认为这个键按着没有。低级钩子吞掉的按下系统不记（所有钩子都放行了才更新），拿它看录到的键吞没吞
  public static bool KeyDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  // 钩子报的是物理像素；不声明的话这个进程看到的屏幕尺寸是按缩放换算过的，两边对不上
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  // mode：scan 只给扫描码（KEYEVENTF_SCANCODE，系统自己换出 vk）；vk 只给 vk（扫描码 0）；both 两个都给（系统照 vk 走）。
  // 扩展键（右 Ctrl、Delete）带 KEYEVENTF_EXTENDEDKEY，钩子才报 LLKHF_EXTENDED
  public static void Key(ushort vk, ushort scan, bool extended, bool down, string mode) {
    var input = new INPUT { type = 1 };
    uint flags = (extended ? 1u : 0u) | (down ? 0u : 2u);
    if (mode == "scan") { flags |= 8u; vk = 0; }
    if (mode == "vk") scan = 0;
    input.u.k = new KEYBDINPUT { vk = vk, scan = scan, flags = flags };
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
  // 小帮手的输出由一条后台线程按行读进队列：PowerShell 的 OutputDataReceived 事件回调在一阵连发里会乱序
  // （升级时紧挨着的"打断""按下"两行实测颠倒过），这里要的是先来后到
  public static System.Collections.Concurrent.ConcurrentQueue<string> ReadLines(System.IO.StreamReader reader) {
    var queue = new System.Collections.Concurrent.ConcurrentQueue<string>();
    var thread = new System.Threading.Thread(() => { string line; while ((line = reader.ReadLine()) != null) if (line.Length > 0) queue.Enqueue(line); });
    thread.IsBackground = true;
    thread.Start();
    return queue;
  }
  // 屏幕物理像素 → SendInput 的绝对坐标（0..65535），按主屏
  public static void Click(int x, int y, bool down) {
    var input = new INPUT { type = 0 };
    int dx = x * 65535 / (GetSystemMetrics(0) - 1), dy = y * 65535 / (GetSystemMetrics(1) - 1);
    input.u.m = new MOUSEINPUT { dx = dx, dy = dy, flags = 0x8001u | (down ? 0x2u : 0x4u) };
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

# 模拟复制兜底用的窗口：控件自己画字，UIA 里没有 TextPattern、ValuePattern；按 Ctrl+C 把 Payload 放进剪贴板。
# 跑在自己的 STA 线程上（剪贴板、窗口消息都要），所有回调在 C# 里自己接住异常，不弹出错框
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
public class CopyOnly : Control {
  public string Payload = "";
  // 大于 0 时按了 Ctrl+C 过这么多毫秒才写剪贴板（像远程桌面、正忙的应用）
  public static int Delay = 0;
  public CopyOnly() { SetStyle(ControlStyles.Selectable, true); TabStop = true; }
  protected override bool IsInputKey(Keys key) { return true; }
  protected override void OnPaint(PaintEventArgs e) { try { e.Graphics.DrawString(Payload, Font, Brushes.Black, 8, 8); } catch { } }
  protected override void OnKeyDown(KeyEventArgs e) {
    try {
      if (!(e.Control && e.KeyCode == Keys.C)) return;
      if (Delay <= 0) { Clipboard.SetText(Payload); return; }
      var late = new System.Windows.Forms.Timer { Interval = Delay };
      late.Tick += (s, a) => { try { late.Stop(); Clipboard.SetText(Payload); } catch { } };
      late.Start();
    } catch { }
  }
}
public static class CopyWindow {
  static Form form;
  public static IntPtr Handle = IntPtr.Zero;
  public static void Open(string title, string payload) {
    var ready = new ManualResetEvent(false);
    var thread = new Thread(() => {
      try {
        form = new Form { Text = title, Width = 640, Height = 200, StartPosition = FormStartPosition.CenterScreen, TopMost = true };
        var control = new CopyOnly { Payload = payload, Dock = DockStyle.Fill };
        form.Controls.Add(control);
        form.Shown += (s, e) => { try { control.Focus(); Handle = form.Handle; } catch { } ready.Set(); };
        var timer = new System.Windows.Forms.Timer { Interval = 60000 };
        timer.Tick += (s, e) => { try { form.Close(); } catch { } };
        timer.Start();
        Application.Run(form);
      } catch { }
      ready.Set();
    });
    thread.SetApartmentState(ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();
    ready.WaitOne(10000);
  }
  public static void Close() {
    try { if (form != null && !form.IsDisposed) form.Invoke((Action)(() => form.Close())); } catch { }
  }
}
'@

[Fake]::SetProcessDPIAware() | Out-Null
$results = [System.Collections.Generic.List[string]]::new()
function Check($name, $ok, $detail) {
  $results.Add(("{0} {1}{2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $(if ($detail) { " — $detail" } else { '' })))
}

function Start-Helper {
  $info = [System.Diagnostics.ProcessStartInfo]::new("$repo\build\key-helper.exe")
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $process = [System.Diagnostics.Process]::Start($info)
  [pscustomobject]@{ Process = $process; Queue = [Fake]::ReadLines($process.StandardOutput) }
}

# 等下一条事件（JSON 解好），等不到是 $null
function Next-Event($helper, $ms = 1500) {
  $deadline = (Get-Date).AddMilliseconds($ms)
  $line = $null
  while ((Get-Date) -lt $deadline) {
    if ($helper.Queue.TryDequeue([ref]$line)) { return $line | ConvertFrom-Json }
    Start-Sleep -Milliseconds 20
  }
  return $null
}
function Drain($helper) { $line = $null; while ($helper.Queue.TryDequeue([ref]$line)) {} }
# 按 UTF-8 写：5.1 的 StandardInput 用的是系统编码（中文系统是 GBK），父进程（Node）写的是 UTF-8
function Send($helper, $object) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($object | ConvertTo-Json -Compress -Depth 5) + "`n")
  $helper.Process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $helper.Process.StandardInput.BaseStream.Flush()
}

# 每个键：vk、扫描码、是不是扩展键
$RCtrl = 0xA3, 0x1D, $true; $Esc = 0x1B, 0x01, $false; $KeyA = 0x41, 0x1E, $false; $KeyC = 0x43, 0x2E, $false
$Ctrl = 0x11, 0x1D, $false; $Delete = 0x2E, 0x53, $true; $F13 = 0x7C, 0x64, $false; $F14 = 0x7D, 0x65, $false
$LAlt = 0xA4, 0x38, $false; $RAlt = 0xA5, 0x38, $true; $Space = 0x20, 0x39, $false; $End = 0x23, 0x4F, $true
# 不分左右的 VK_CONTROL 加扩展位：有的工具这样模拟右 Ctrl，小帮手要自己分出是右边
$GenericRCtrl = 0x11, 0x1D, $true
function Press($key, $down, $mode = 'both') { [Fake]::Key($key[0], $key[1], $key[2], $down, $mode) }
# 录键报的集合是不是这几个：mods、keys 都要有，空的也是 []
function Is-Recording($e, $mods, $keys) {
  $e.event -eq 'recording' -and $e.on -eq $true -and $null -ne $e.mods -and $null -ne $e.keys -and
    (@($e.mods) -join ',') -eq ($mods -join ',') -and (@($e.keys) -join ',') -eq ($keys -join ',')
}
function Show($events) { ($events | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ' ' }

$saved = Get-Clipboard -Raw
$helper = Start-Helper
try {
  $ready = Next-Event $helper 3000
  Check '启动报 ready，钩子装上了' ($ready.event -eq 'ready' -and $ready.listen -and $ready.capture) ($ready | ConvertTo-Json -Compress)
  # 锁屏解锁、睡眠唤醒、前台窗口三样通知登记不上会报 error（前台恰好是管理员窗口时会报 elevated_foreground）
  $extra = Next-Event $helper 500
  Check '系统通知都登记上了，没报别的' ($null -eq $extra) ($extra | ConvertTo-Json -Compress)

  # 热键由父进程下发：右 Ctrl 当听写，右 Ctrl+F13（扫描码 0x64）当另一个动作，esc（扫描码 1）当截着时的取消
  Send $helper @{ cmd = 'bind'; bindings = @(
      @{ id = 'dictate#0'; mods = @(0xA3); when = 'always' },
      @{ id = 'x#0'; mods = @(0xA3); key = 0x64; when = 'always' },
      @{ id = 'cancel#0'; mods = @(); key = 1; when = 'capturing' }) }
  $bound = Next-Event $helper
  Check 'bind 都装上了' ($bound.event -eq 'bound' -and $null -ne $bound.rejected -and @($bound.rejected).Count -eq 0) ($bound | ConvertTo-Json -Compress)

  # 热键按下、松开；按住时系统的自动重复不另报
  Press $RCtrl $true 'scan'; Start-Sleep -Milliseconds 50; Press $RCtrl $true 'scan'
  $down = Next-Event $helper
  Press $RCtrl $false 'scan'
  $up = Next-Event $helper
  Check '热键按下、松开各报一次' ($down.event -eq 'binding' -and $down.id -eq 'dictate#0' -and $down.down -eq $true -and $up.event -eq 'binding' -and $up.id -eq 'dictate#0' -and $up.down -eq $false) "$($down | ConvertTo-Json -Compress) $($up | ConvertTo-Json -Compress)"
  Check '自动重复不另报' ($null -eq (Next-Event $helper 300))

  # 右 Ctrl 按着再按 F13：升级成 x#0（先报打断带 to，再报 x#0 按下），松开右 Ctrl 报 x#0 松开。三种模拟法各一遍
  foreach ($mode in 'scan', 'vk', 'both') {
    Press $RCtrl $true $mode; $first = Next-Event $helper
    Press $F13 $true $mode; $upgrade = Next-Event $helper; $chord = Next-Event $helper
    Press $F13 $false $mode; Press $RCtrl $false $mode; $chordUp = Next-Event $helper
    $seen = @($first, $upgrade, $chord, $chordUp) | ForEach-Object { $_ | ConvertTo-Json -Compress }
    Check "右 Ctrl+F13 升级（$mode）" ($first.id -eq 'dictate#0' -and $first.down -eq $true -and $upgrade.event -eq 'interrupted' -and $upgrade.to -eq 'x#0' -and $chord.id -eq 'x#0' -and $chord.down -eq $true -and $chordUp.id -eq 'x#0' -and $chordUp.down -eq $false) ($seen -join ' ')
    Check "F13 的松开不另报（$mode）" ($null -eq (Next-Event $helper 300))
  }

  # 不分左右的 VK_CONTROL 加扩展位：认成右 Ctrl
  Press $GenericRCtrl $true 'vk'; $down = Next-Event $helper
  Press $GenericRCtrl $false 'vk'; $up = Next-Event $helper
  Check '不分左右的 VK_CONTROL 加扩展位认成右 Ctrl' ($down.id -eq 'dictate#0' -and $down.down -eq $true -and $up.id -eq 'dictate#0' -and $up.down -eq $false) "$($down | ConvertTo-Json -Compress) $($up | ConvertTo-Json -Compress)"

  # 按住热键再按别的键：报一次 interrupted，不说是哪个键；被打断的松开不报
  Press $RCtrl $true 'scan'; $null = Next-Event $helper
  # 别的键用 F14：右 Ctrl+A 会在前台应用里全选
  Press $F14 $true 'scan'; Press $F14 $false 'scan'; Press $F14 $true 'scan'; Press $F14 $false 'scan'
  $other = Next-Event $helper
  Press $RCtrl $false 'scan'
  Check '组合键报一次 interrupted' ($other.event -eq 'interrupted' -and $other.id -eq 'dictate#0' -and @($other.PSObject.Properties).Count -eq 2) ($other | ConvertTo-Json -Compress)
  Check '被打断以后松开不报' ($null -eq (Next-Event $helper 300))
  Drain $helper

  # 录键（docs/hotkey-research.md 5.6）。热键还是上面那三个：录键期间右 Ctrl、右 Ctrl+F13 都不该认。
  # 对照：没在录时右 Ctrl 不吞（修饰键从来不吞），系统看得到它按下；看不到的话，下面"吞掉了"那条也不作数
  Press $RCtrl $true 'scan'; $null = Next-Event $helper; Start-Sleep -Milliseconds 100
  $seenOutside = [Fake]::KeyDown(0xA3)
  Press $RCtrl $false 'scan'; $null = Next-Event $helper
  Check '对照：没在录时右 Ctrl 按下，系统看得到' $seenOutside ''

  Send $helper @{ cmd = 'record'; on = $true }
  $entered = Next-Event $helper
  Check '进入录键报一次空的集合' (Is-Recording $entered @() @()) (Show $entered)
  Press $RCtrl $true 'scan'; $s1 = Next-Event $helper
  Start-Sleep -Milliseconds 100; $seenInside = [Fake]::KeyDown(0xA3)
  Press $F13 $true 'scan'; $s2 = Next-Event $helper
  Press $F13 $true 'scan'   # 自动重复：不改集合，不另报
  Press $F13 $false 'scan'; $s3 = Next-Event $helper
  Press $RCtrl $false 'scan'; $s4 = Next-Event $helper
  Check '按右 Ctrl+F13 集合变两次、松开再变两次，热键不认' ((Is-Recording $s1 @(0xA3) @()) -and (Is-Recording $s2 @(0xA3) @(0x64)) -and (Is-Recording $s3 @(0xA3) @()) -and (Is-Recording $s4 @() @())) (Show @($s1, $s2, $s3, $s4))
  Check '录到的右 Ctrl 吞掉了，系统没看到它按下' (-not $seenInside) ''
  $extra = Next-Event $helper 300
  Check '录键期间没有多报（自动重复不报）' ($null -eq $extra) (Show $extra)

  Send $helper @{ cmd = 'record'; on = $false }
  $left = Next-Event $helper
  Check '离开录键报 on:false' ($left.event -eq 'recording' -and $left.on -eq $false -and @($left.PSObject.Properties).Count -eq 2) (Show $left)
  Press $RCtrl $true 'scan'; $down = Next-Event $helper
  Press $RCtrl $false 'scan'; $up = Next-Event $helper
  Check '离开以后热键照常认' ($down.id -eq 'dictate#0' -and $down.down -eq $true -and $up.id -eq 'dictate#0' -and $up.down -eq $false) (Show @($down, $up))

  # 离开时还按着的键：之后的松开照样吞、不报；松开以后热键照常认
  Send $helper @{ cmd = 'record'; on = $true }; $null = Next-Event $helper
  Press $RCtrl $true 'scan'; $null = Next-Event $helper
  Send $helper @{ cmd = 'record'; on = $false }; $left = Next-Event $helper
  Press $RCtrl $false 'scan'
  $extra = Next-Event $helper 300
  Check '离开时还按着的右 Ctrl，松开不报' ($left.event -eq 'recording' -and $left.on -eq $false -and $null -eq $extra) (Show @($left, $extra))
  Press $RCtrl $true 'scan'; $down = Next-Event $helper
  Press $RCtrl $false 'scan'; $up = Next-Event $helper
  Check '它松开以后热键照常认' ($down.id -eq 'dictate#0' -and $down.down -eq $true -and $up.id -eq 'dictate#0' -and $up.down -eq $false) (Show @($down, $up))

  # 已经在录时再让录：从头录，再报一次空的集合；之前按着的 F13 松开不改集合、不报
  Send $helper @{ cmd = 'record'; on = $true }; $null = Next-Event $helper
  Press $F13 $true 'scan'; $null = Next-Event $helper
  Send $helper @{ cmd = 'record'; on = $true }; $again = Next-Event $helper
  Press $F13 $false 'scan'
  $extra = Next-Event $helper 300
  Check '再让录：报一次空的集合，之前按着的松开不报' ((Is-Recording $again @() @()) -and $null -eq $extra) (Show @($again, $extra))
  # 从再让录那一下起 30 秒没人说停：先报 error，再报 on:false，之后热键照常认
  $timeout = Next-Event $helper 32000; $left = Next-Event $helper
  Check '录了 30 秒自己停：先报 error 再报 on:false' ($timeout.event -eq 'error' -and $left.event -eq 'recording' -and $left.on -eq $false) (Show @($timeout, $left))
  Press $RCtrl $true 'scan'; $down = Next-Event $helper
  Press $RCtrl $false 'scan'; $up = Next-Event $helper
  Check '自己停了以后热键照常认' ($down.id -eq 'dictate#0' -and $down.down -eq $true -and $up.id -eq 'dictate#0' -and $up.down -eq $false) (Show @($down, $up))

  # probe（docs/hotkey-research.md 5.5）：只试登记、马上注销，不按任何键
  Send $helper @{ cmd = 'probe'; id = 1; mods = @(0xA3); key = 0x64 }
  $probed = Next-Event $helper
  Check 'probe 右 Ctrl+F13 没被占' ($probed.event -eq 'probed' -and $probed.id -eq 1 -and $probed.conflict -eq $false -and @($probed.PSObject.Properties).Count -eq 3) (Show $probed)
  # Win+R（R 的扫描码 0x13）：系统自己的组合报不报冲突，照实记下，不算过或不过
  Send $helper @{ cmd = 'probe'; id = 2; mods = @(0x5B); key = 0x13 }
  $results.Add("INFO probe Win+R：$(Show @((Next-Event $helper), (Next-Event $helper 300)))")
  Send $helper @{ cmd = 'probe'; id = 3; mods = @(0xA3) }
  $probed = Next-Event $helper
  Check 'probe 只有修饰键的，直接回没被占' ($probed.event -eq 'probed' -and $probed.id -eq 3 -and $probed.conflict -eq $false) (Show $probed)
  Send $helper @{ cmd = 'probe'; id = 4; mods = 'x'; key = 0x64 }
  $probed = Next-Event $helper; $why = Next-Event $helper
  Check 'probe 形状不对：照样回 probed，另报 error' ($probed.event -eq 'probed' -and $probed.id -eq 4 -and $probed.conflict -eq $false -and $why.event -eq 'error') (Show @($probed, $why))
  Send $helper @{ cmd = 'probe'; mods = @(0xA3); key = 0x64 }
  $why = Next-Event $helper; $extra = Next-Event $helper 300
  Check 'probe 没有 id：只报 error' ($why.event -eq 'error' -and $null -eq $extra) (Show @($why, $extra))
  Send $helper @{ cmd = 'info' }
  $info = Next-Event $helper
  Check 'info 只回 event' ($info.event -eq 'info' -and @($info.PSObject.Properties).Count -eq 1) (Show $info)
  Drain $helper

  # 截住 esc 和一块区域里的点击
  $width = [Fake]::GetSystemMetrics(0); $height = [Fake]::GetSystemMetrics(1)
  $x = [int]($width / 2); $y = [int]($height - 60)
  $results.Add("INFO 主屏 ${width}x${height}（物理像素），点在 ($x, $y)")
  Send $helper @{ cmd = 'capture'; regions = @(@{ id = 'done'; x = $x - 20; y = $y - 20; width = 40; height = 40 }) }
  Start-Sleep -Milliseconds 200
  Press $Esc $true 'scan'; Press $Esc $false 'scan'
  $cancelDown = Next-Event $helper
  $cancelUp = Next-Event $helper
  Check '截着时按 esc 报取消的按下、松开' ($cancelDown.event -eq 'binding' -and $cancelDown.id -eq 'cancel#0' -and $cancelDown.down -eq $true -and $cancelUp.event -eq 'binding' -and $cancelUp.id -eq 'cancel#0' -and $cancelUp.down -eq $false) "$($cancelDown | ConvertTo-Json -Compress) $($cancelUp | ConvertTo-Json -Compress)"
  [Fake]::Click($x, $y, $true); Start-Sleep -Milliseconds 50; [Fake]::Click($x, $y, $false)
  $click = Next-Event $helper
  Check '截着时点那一块报 click' ($click.event -eq 'click' -and $click.id -eq 'done') ($click | ConvertTo-Json -Compress)
  Send $helper @{ cmd = 'release' }
  Start-Sleep -Milliseconds 200
  Press $Esc $true 'scan'; Press $Esc $false 'scan'
  [Fake]::Click($x, $y, $true); [Fake]::Click($x, $y, $false)
  Check '不截了之后 esc 和点击都不报' ($null -eq (Next-Event $helper 400))

  # 往记事本里贴一段字：中英混排、带换行和表情
  $text = "OrangeSpeakEasy 真机检查：你好，world。`r`n第二行 🎙"
  # Win11 的记事本：起来的那个进程会把活交给另一个进程再退出，按名字找最新开的、有窗口的那个
  $startedAt = Get-Date
  Start-Process notepad
  $window = 0
  for ($i = 0; $i -lt 30 -and $window -eq 0; $i++) {
    Start-Sleep -Milliseconds 200
    $notepad = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
    if ($notepad) { $window = $notepad.MainWindowHandle }
  }
  Check '记事本开起来了' ($window -ne 0) ''
  Start-Sleep -Milliseconds 800
  [Fake]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Milliseconds 500
  # Win11 的记事本会把上次没存的内容恢复出来：先清空
  Press $Ctrl $true; Press $KeyA $true; Press $KeyA $false; Press $Ctrl $false
  Press $Delete $true; Press $Delete $false
  Start-Sleep -Milliseconds 300

  # 菜单栏（docs/hotkey-research.md 4.2 的掩码）：Alt 按着时我们触发了绑定、吞了空格，前台应用不该当成单按了一下 Alt。
  # 掩码排到 Alt 按下前面和不插一样，记事本照样选中菜单栏：语音输入、语音翻译的默认键 10-22 在这里栽过。
  # 左 Alt 没绑，是对照：它该选中菜单栏，不然后两项查不出东西。空格没吞住的话弹的是窗口菜单，焦点也在菜单项上
  Send $helper @{ cmd = 'bind'; bindings = @(
      @{ id = 'dictate#0'; mods = @(0xA5); when = 'always' },
      @{ id = 'x#0'; mods = @(0xA5); key = 0x39; when = 'always' }) }
  $null = Next-Event $helper
  $menuCases = [ordered]@{
    '对照：左 Alt 单按（没绑）选中了菜单栏' = @($true, { Press $LAlt $true 'scan'; Start-Sleep -Milliseconds 80; Press $LAlt $false 'scan' })
    '右 Alt 单按触发绑定，菜单栏没被选中' = @($false, { Press $RAlt $true 'scan'; Start-Sleep -Milliseconds 80; Press $RAlt $false 'scan' })
    '右 Alt 再补空格升级，菜单栏、窗口菜单都没出来' = @($false, {
        Press $RAlt $true 'scan'; Start-Sleep -Milliseconds 120; Press $Space $true 'scan'; Press $Space $false 'scan'
        Start-Sleep -Milliseconds 30; Press $RAlt $false 'scan' })
  }
  foreach ($name in $menuCases.Keys) {
    [Fake]::SetForegroundWindow($window) | Out-Null
    Start-Sleep -Milliseconds 300
    & $menuCases[$name][1]
    Start-Sleep -Milliseconds 500
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement.Current
    $onMenu = $focused.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem
    Check $name ($onMenu -eq $menuCases[$name][0]) "焦点在 $($focused.ControlType.ProgrammaticName) '$($focused.Name)'"
    # 选中了菜单栏就退出来；没截着，esc 照常到记事本
    Press $Esc $true 'scan'; Press $Esc $false 'scan'
    Start-Sleep -Milliseconds 300
    Drain $helper
  }
  Set-Clipboard -Value '贴之前用户复制的字'
  Send $helper @{ cmd = 'paste'; id = 1; text = $text }
  $pasted = Next-Event $helper 3000
  Check '贴完报 pasted ok' ($pasted.event -eq 'pasted' -and $pasted.id -eq 1 -and $pasted.ok) ($pasted | ConvertTo-Json -Compress)
  Check '贴完剪贴板还是原来的' ((Get-Clipboard -Raw) -eq '贴之前用户复制的字') (Get-Clipboard -Raw)
  # 全选、复制，读回记事本里的字
  Press $Ctrl $true; Press $KeyA $true; Press $KeyA $false; Press $KeyC $true; Press $KeyC $false; Press $Ctrl $false
  Start-Sleep -Milliseconds 400
  $inNotepad = Get-Clipboard -Raw
  Check '记事本里是贴进去的那段字' ($inNotepad -eq $text) ($inNotepad)

  # 划词翻译取选区（selection）。记事本里全选：UIA 拿到那段字，位置在记事本窗口里。换行各家写法不一，比之前统一成 \n
  $lines = { param($value) ("$value" -replace "`r`n", "`n") -replace "`r", "`n" }
  $box = [System.Windows.Automation.AutomationElement]::FromHandle($window).Current.BoundingRectangle
  [Fake]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Milliseconds 300
  Press $Ctrl $true; Press $KeyA $true; Press $KeyA $false; Press $Ctrl $false
  Start-Sleep -Milliseconds 300
  Drain $helper
  Send $helper @{ cmd = 'selection'; id = 11 }
  $sel = Next-Event $helper 4000
  Check '记事本全选：selection 拿到那段字（UIA）' ($sel.event -eq 'selection' -and $sel.id -eq 11 -and (& $lines $sel.text) -eq (& $lines $text) -and $sel.via -eq 'uia') (Show $sel)
  Check '回执里不报能不能改（10-23 砍掉了替换）' ($null -eq $sel.editable) ''
  $inside = $null -ne $sel.rect -and $sel.rect.width -gt 0 -and $sel.rect.x -ge $box.Left - 1 -and $sel.rect.y -ge $box.Top - 1 -and
    ($sel.rect.x + $sel.rect.width) -le $box.Right + 1 -and ($sel.rect.y + $sel.rect.height) -le $box.Bottom + 1
  Check '选区位置在记事本窗口里' $inside "选区 $(Show $sel.rect)，窗口 $box"
  # 什么都没选：记事本有 TextPattern、选区是空的，就是没选中，不再模拟复制（via 还是 uia）；剪贴板原样不动
  Press $Ctrl $true; Press $End $true; Press $End $false; Press $Ctrl $false
  Start-Sleep -Milliseconds 300
  Set-Clipboard -Value '取选区之前的剪贴板'
  Send $helper @{ cmd = 'selection'; id = 12 }
  $sel = Next-Event $helper 4000
  Check '什么都没选：text 空的、reason none，没模拟复制' ($sel.event -eq 'selection' -and $sel.id -eq 12 -and $sel.text -eq '' -and $sel.reason -eq 'none' -and $sel.via -eq 'uia' -and $null -eq $sel.rect) (Show $sel)
  Check '取选区以后剪贴板还是原来的' ((Get-Clipboard -Raw) -eq '取选区之前的剪贴板') (Get-Clipboard -Raw)
  Check 'selection 只回一条，没报 error' ($null -eq (Next-Event $helper 300)) ''

  # 划词卡片那种截法（capture 带 outside）：块外的左键按下报 outside、照常放行；块里的照旧吞、照旧报。点在记事本正文上，碰不到别的
  $cx = [int](($box.Left + $box.Right) / 2); $cy = [int](($box.Top + $box.Bottom) / 2)
  Send $helper @{ cmd = 'capture'; outside = $true; regions = @(@{ id = 'copy'; x = $cx + 100; y = $cy - 20; width = 40; height = 40 }) }
  Start-Sleep -Milliseconds 200
  [Fake]::Click($cx, $cy, $true); Start-Sleep -Milliseconds 50; $passed = [Fake]::KeyDown(0x01); [Fake]::Click($cx, $cy, $false)
  $outside = Next-Event $helper; $extra = Next-Event $helper 300
  Check '截着带 outside：块外按下报一次 outside' ($outside.event -eq 'click' -and $outside.id -eq 'outside' -and $null -eq $extra) (Show @($outside, $extra))
  Check '块外那一下照常放行（系统看得到左键按下）' $passed ''
  [Fake]::Click($cx + 120, $cy, $true); Start-Sleep -Milliseconds 50; $passed = [Fake]::KeyDown(0x01); [Fake]::Click($cx + 120, $cy, $false)
  $click = Next-Event $helper
  Check '块里照旧报 click、被吞（系统没看到左键按下）' ($click.event -eq 'click' -and $click.id -eq 'copy' -and -not $passed) (Show $click)
  Send $helper @{ cmd = 'release' }
  Start-Sleep -Milliseconds 200
  [Fake]::Click($cx, $cy, $true); [Fake]::Click($cx, $cy, $false)
  Check '不截了之后块外点击不报' ($null -eq (Next-Event $helper 400)) ''

  # 模拟复制兜底：UIA 拿不到（没有 TextPattern），发 Ctrl+C 从剪贴板拿，拿完剪贴板还原；拿不到位置
  $payload = 'Copied by the fallback 复制兜底'
  [CopyWindow]::Open('OrangeSpeakEasy copy fallback', $payload)
  Check '复制兜底的窗口开起来了' ([CopyWindow]::Handle -ne [IntPtr]::Zero) ''
  if ([CopyWindow]::Handle -ne [IntPtr]::Zero) {
    [Fake]::SetForegroundWindow([CopyWindow]::Handle) | Out-Null
    Start-Sleep -Milliseconds 400
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $results.Add("INFO 复制兜底窗口的焦点：$($focused.Current.ControlType.ProgrammaticName)，TextPattern $([bool]($focused.GetSupportedPatterns() | Where-Object { $_.ProgrammaticName -like 'TextPattern*' }))")
    Set-Clipboard -Value '取选区之前的剪贴板'
    Drain $helper
    Send $helper @{ cmd = 'selection'; id = 31 }
    $sel = Next-Event $helper 4000
    Check '没有 TextPattern 的地方：模拟复制拿到字' ($sel.event -eq 'selection' -and $sel.id -eq 31 -and $sel.text -eq $payload -and $sel.via -eq 'copy' -and $null -eq $sel.reason) (Show $sel)
    Check '模拟复制拿到的：不带位置' ($null -eq $sel.rect) ''
    Check '模拟复制以后剪贴板还原了' ((Get-Clipboard -Raw) -eq '取选区之前的剪贴板') (Get-Clipboard -Raw)
    Check '模拟复制那次没报 error' ($null -eq (Next-Event $helper 300)) ''
    # 应用慢了：过了 400ms 才写剪贴板。先回没选中，晚到的那份写进来以后剪贴板还原成原来的
    [CopyOnly]::Delay = 800
    Set-Clipboard -Value '取选区之前的剪贴板'
    Drain $helper
    Send $helper @{ cmd = 'selection'; id = 32 }
    $sel = Next-Event $helper 4000
    Check '复制慢了：先回没选中' ($sel.event -eq 'selection' -and $sel.id -eq 32 -and $sel.text -eq '' -and $sel.reason -eq 'none' -and $sel.via -eq 'copy') (Show $sel)
    Start-Sleep -Milliseconds 1500
    Check '晚到的复制写进来以后，剪贴板还原成原来的' ((Get-Clipboard -Raw) -eq '取选区之前的剪贴板') (Get-Clipboard -Raw)
    [CopyOnly]::Delay = 0
  }
  [CopyWindow]::Close()

  # 终端里没选中：不发 Ctrl+C（发了就是中断正在跑的 ping）。conhost.exe 直接开经典控制台，不管默认终端是不是 Windows Terminal
  $consoleStarted = Get-Date
  $console = Start-Process conhost.exe -ArgumentList 'ping -t 127.0.0.1' -PassThru
  $consoleWindow = [IntPtr]::Zero
  for ($i = 0; $i -lt 25 -and $consoleWindow -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 200
    $console.Refresh()
    $consoleWindow = $console.MainWindowHandle
  }
  $ping = Get-Process PING -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $consoleStarted } | Select-Object -First 1
  Check '经典控制台开起来了、ping 在跑' ($consoleWindow -ne [IntPtr]::Zero -and $null -ne $ping) ''
  if ($consoleWindow -ne [IntPtr]::Zero -and $ping) {
    [Fake]::SetForegroundWindow($consoleWindow) | Out-Null
    Start-Sleep -Milliseconds 500
    Drain $helper
    Send $helper @{ cmd = 'selection'; id = 41 }
    $sel = Next-Event $helper 4000
    Check '终端里没选中：回没选中' ($sel.event -eq 'selection' -and $sel.id -eq 41 -and $sel.text -eq '' -and $sel.reason -eq 'none') (Show $sel)
    Start-Sleep -Milliseconds 800
    Check '终端里跑着的 ping 没被中断' (-not $ping.HasExited) ''
  }
  if ($ping) { Stop-Process -Id $ping.Id -Force -ErrorAction SilentlyContinue }
  if ($console -and -not $console.HasExited) { Stop-Process -Id $console.Id -Force -ErrorAction SilentlyContinue }

  # 网页（有 Edge 才查）：正文和输入框里选中的字都拿得到，输入框的位置在窗口里。头一次按的时候 Edge 还没建无障碍树，
  # 也要拿得到（有 TextPattern、选区为空时不再模拟复制，要是第一次问到的是空的，这里就会漏）。临时的用户目录，不碰他的 Edge 资料
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $edge) {
    $results.Add('INFO 没有 Edge，网页正文、输入框那几条没查')
  } else {
    $edgeProfile = "$env:TEMP\orangespeakeasy-e2e-edge"
    $page = "$env:TEMP\orangespeakeasy-e2e-selection.html"
    $paragraph = 'The model keeps the audio on your device.'
    $typed = 'Typed words here'
    Set-Content -Path $page -Encoding UTF8 -Value "<!doctype html><meta charset=`"utf-8`"><title>OrangeSpeakEasy selection</title><body style=`"font:28px sans-serif;margin:40px`"><p>$paragraph</p><textarea rows=`"2`" cols=`"24`">$typed</textarea></body>"
    # InPrivate：新的用户目录会被 Edge 拿系统登录的微软账号自动登录，弹"同步浏览数据"的框抢焦点（10-22 实测），InPrivate 不登录
    Start-Process $edge -ArgumentList "--user-data-dir=`"$edgeProfile`"", '--no-first-run', '--no-default-browser-check', '--inprivate', '--new-window', "file:///$($page -replace '\\', '/')"
    $edgeWindow = 0
    for ($i = 0; $i -lt 50 -and $edgeWindow -eq 0; $i++) {
      Start-Sleep -Milliseconds 200
      $found = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'OrangeSpeakEasy selection*' } | Select-Object -First 1
      if ($found) { $edgeWindow = $found.MainWindowHandle }
    }
    Check 'Edge 打开了本地网页' ($edgeWindow -ne 0) ''
    if ($edgeWindow -ne 0) {
      [Fake]::SetForegroundWindow($edgeWindow) | Out-Null
      # 第一次按：先不问 UIA，点窗口中间、全选，直接要 selection
      Start-Sleep -Milliseconds 1500
      $frame = New-Object Fake+RECT
      [Fake]::GetWindowRect($edgeWindow, [ref]$frame) | Out-Null
      $mx = [int](($frame.Left + $frame.Right) / 2); $my = [int](($frame.Top + $frame.Bottom) / 2)
      [Fake]::Click($mx, $my, $true); [Fake]::Click($mx, $my, $false)
      Start-Sleep -Milliseconds 200
      Press $Ctrl $true; Press $KeyA $true; Press $KeyA $false; Press $Ctrl $false
      Start-Sleep -Milliseconds 300
      Drain $helper
      Send $helper @{ cmd = 'selection'; id = 20 }
      $sel = Next-Event $helper 4000
      Check '网页头一次按：也拿到正文' ($sel.event -eq 'selection' -and $sel.id -eq 20 -and "$($sel.text)".Contains($paragraph)) (Show $sel)
      Drain $helper
      $edgeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($edgeWindow)
      # Chromium 有 UIA 客户端来问才建无障碍树，头几次可能找不到：多等几轮
      # 只认有位置的（没排版好的、看不见的元素 BoundingRectangle 是空的）
      $find = { param($type, $match)
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
        for ($i = 0; $i -lt 25; $i++) {
          $hit = $edgeRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) |
            Where-Object { -not $_.Current.BoundingRectangle.IsEmpty -and (& $match $_) } | Select-Object -First 1
          if ($hit) { return $hit }
          Start-Sleep -Milliseconds 200
        }
        $null }
      $text = & $find ([System.Windows.Automation.ControlType]::Text) { param($e) $e.Current.Name -eq $paragraph }
      # textarea 没有名字，按框里的字认（ValuePattern）
      $edit = & $find ([System.Windows.Automation.ControlType]::Edit) { param($e)
        $value = $null
        $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value) -and $value.Current.Value -eq $typed }
      Check '网页里找到正文和输入框' ($null -ne $text -and $null -ne $edit) ''
      if ($text -and $edit) {
        $edgeBox = $edgeRoot.Current.BoundingRectangle
        $at = $text.Current.BoundingRectangle
        # 点一下正文（不聚焦任何东西），全选的是整页
        [Fake]::Click([int]($at.Left + 10), [int](($at.Top + $at.Bottom) / 2), $true); [Fake]::Click([int]($at.Left + 10), [int](($at.Top + $at.Bottom) / 2), $false)
        Start-Sleep -Milliseconds 200
        Press $Ctrl $true; Press $KeyA $true; Press $KeyA $false; Press $Ctrl $false
        Start-Sleep -Milliseconds 300
        Drain $helper
        Send $helper @{ cmd = 'selection'; id = 21 }
        $sel = Next-Event $helper 4000
        Check '网页正文：selection 拿到正文' ($sel.event -eq 'selection' -and $sel.id -eq 21 -and "$($sel.text)".Contains($paragraph)) (Show $sel)
        $at = $edit.Current.BoundingRectangle
        [Fake]::Click([int](($at.Left + $at.Right) / 2), [int](($at.Top + $at.Bottom) / 2), $true); [Fake]::Click([int](($at.Left + $at.Right) / 2), [int](($at.Top + $at.Bottom) / 2), $false)
        Start-Sleep -Milliseconds 200
        Press $Ctrl $true; Press $KeyA $true; Press $KeyA $false; Press $Ctrl $false
        Start-Sleep -Milliseconds 300
        Drain $helper
        Send $helper @{ cmd = 'selection'; id = 22 }
        $sel = Next-Event $helper 4000
        $inside = $null -ne $sel.rect -and $sel.rect.x -ge $edgeBox.Left - 1 -and $sel.rect.y -ge $edgeBox.Top - 1 -and
          ($sel.rect.x + $sel.rect.width) -le $edgeBox.Right + 1 -and ($sel.rect.y + $sel.rect.height) -le $edgeBox.Bottom + 1
        Check '网页输入框：selection 拿到框里的字、位置在窗口里' ($sel.event -eq 'selection' -and $sel.id -eq 22 -and $sel.text -eq $typed -and $inside) "$(Show $sel)，窗口 $edgeBox"
      }
    }
  }

} finally {
  $helper.Process.StandardInput.Close()
  if (-not $helper.Process.WaitForExit(2000)) { $helper.Process.Kill() }
  Check '关掉标准输入后自己退出' ($helper.Process.HasExited) ''
  # 只关这次开的（不碰用户自己开着的记事本）
  if ($startedAt) { Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $startedAt } | Stop-Process -Force -ErrorAction SilentlyContinue }
  [CopyWindow]::Close()
  # 这次开的 Edge（认临时用户目录）关掉，网页和用户目录删掉
  if ($edgeProfile) {
    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and "$($_.CommandLine)".Contains('orangespeakeasy-e2e-edge') } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Remove-Item -Recurse -Force $edgeProfile, $page -ErrorAction SilentlyContinue
  }
  if ($null -ne $saved) { Set-Clipboard -Value $saved }
}
$results
$checks = @($results | Where-Object { $_ -notlike 'INFO*' })
"{0}/{1} 通过" -f @($checks | Where-Object { $_ -like 'PASS*' }).Count, $checks.Count
