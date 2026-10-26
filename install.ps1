# OrangeSpeakEasy 的 Windows 安装脚本：检查环境、下载、校验、装进 OrangeSpeakEasy 的目录，然后启动。
#
#   irm https://github.com/jzh-1228/OrangeSpeakEasy/releases/latest/download/install.ps1 | iex
#
# 和 install.sh 是同一件事：程序、运行环境，以及之后的设置、key、历史和录音全在一个目录里，默认是 %USERPROFILE%\.orangespeakeasy，
# 可以装在别处（比如 D 盘）。装在默认位置以外时，装在哪记在定位文件 %LOCALAPPDATA%\OrangeSpeakEasy\location.json 里
# （src/storage/location.mjs），下次安装、安装程序打开 App 都照它找。
# 程序按版本放：versions\<版本>-<编号>\ 里是 app\ 和 runtime\，current 记着现在用哪个，bin\orangespeakeasy.cmd 照它找程序。
# 装新版本是解进一个新目录、试过能跑再把 current 指过去，不挪、不覆盖已有的任何文件（为什么见下面"安装"一节开头）。
# 这个脚本也随程序一起装进 app\ 里：orangespeakeasy update 拼好新版本后，用新版本自带的这一份把它换上（ORANGESPEAKEASY_INSTALL_FROM）；
# orangespeakeasy move 把整个目录拷到新位置后，用那里的这一份把系统里的入口和定位文件改指过去（ORANGESPEAKEASY_PREVIOUS_HOME）。
# 目录以外加的两样记在 bin\links 里，orangespeakeasy uninstall 照着删：
#   - 用户的 Path 里加上 <目录>\bin（新开的终端里敲 orangespeakeasy 就找得到）
#   - 开始菜单里一个"OrangeSpeakEasy"快捷方式
# 升级时另外把指着旧版本的改指到新版本：开机启动那一项，固定到任务栏、发送到桌面的快捷方式副本。
# 不需要 Node、npm、管理员权限。第一次安装、在 PowerShell 窗口里运行时，先说默认装在哪，回车就装在那里，也可以输入另一个文件夹。
# 已经装过的话再运行一次就是升级：程序换成新的，你的东西不动，装在哪照定位文件。
#
# 可以用环境变量调整（irm | iex 传不了参数，所以都走环境变量）：
#   ORANGESPEAKEASY_INSTALL_DIR   装在哪个文件夹下（装进它里面的 .orangespeakeasy，记进定位文件）。只用于第一次安装（安装程序问的就是它）；
#                           已经装在别处的，用 orangespeakeasy move 搬
#   ORANGESPEAKEASY_HOME          这一次用哪个目录，原样不改定位文件（开发、测试用；orangespeakeasy update、安装程序也这样告诉它装在哪）
#   ORANGESPEAKEASY_VERSION       装哪个版本，比如 v0.9.3（默认最新的；0.9.3 以前的放法不同，这个脚本不装）
#   ORANGESPEAKEASY_INSTALL_BASE  从哪下载：一个网址前缀，或者本机的一个目录（npm run release 打出来的 dist\release）
#   ORANGESPEAKEASY_NO_START=1    只装不启动
#   ORANGESPEAKEASY_INSTALL_FROM  不下载，装一棵已经准备好的树（里面是 app\ 和 runtime\）：orangespeakeasy update 拼在 versions 下的，
#                           原地用；安装程序（OrangeSpeakEasy-Setup-x64.exe）解在临时目录里的，拷进 versions 下一个新目录
#   ORANGESPEAKEASY_PREVIOUS_HOME 换家：ORANGESPEAKEASY_HOME 里已经是从这个旧目录整个拷过来的一份（orangespeakeasy move 拷的）。
#                           不下载、不换程序，试跑 current 指着的那个版本，把 Path、开始菜单、固定的快捷方式、
#                           开机启动、定位文件从旧目录改指到这里
#
# 写法要能在 Windows 自带的 PowerShell 5.1 上跑，这些坑都踩过（见 docs/development.md 的 Windows 一节）：
#   - 整段包在一个脚本块里，出错时不 exit：irm | iex 跑在用户自己的窗口里，exit 关掉的是他的窗口
#   - 不用 Expand-Archive、Get-FileHash：前者画进度条极慢，后者在从 PowerShell 7 里开的 5.1 里加载不到；都用 .NET
#   - 调外部程序时放宽 ErrorActionPreference：5.1 在 Stop 下会把它写到标准错误的第一行当成异常
#   - 用户的 Path 按原样读写（REG_EXPAND_SZ、不展开），不然里面的 %USERPROFILE% 会被写死

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  # 下载地址只认 TLS 1.2 以上；较早的 Windows 10 上 5.1 默认不开
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $RepoUrl = 'https://github.com/jzh-1228/OrangeSpeakEasy'
  $DownloadUrl = 'https://github.com/jzh-1228/OrangeSpeakEasy/releases/latest/download'
  $Archive = 'orangespeakeasy-win32-x64.zip'
  # Electron 44 要 Windows 10 1809（内部版本 17763）以上
  $MinBuild = 17763
  # 解开约 430 MB（下载的包约 170 MB，只在内存里）；升级时旧版本要等新的装好才删
  $NeededMB = 1200
  # 从这个版本起程序按版本放（versions\、current）。更早的版本不认这种放法：从开始菜单打开时把版本目录当成家目录，
  # 看不到 key 和历史，写下的东西下次升级时跟着版本目录一起删掉。所以不往这种放法里装更早的版本
  $MinVersion = [version]'0.9.3'
  # versions 下的目录名：<版本>-<8 位编号>。只认、只删长这样的（ORANGESPEAKEASY_HOME 指到了别处时，不碰那里本来的东西）
  $VersionNamePattern = '^\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?-[0-9a-f]{8}$'
  # 家目录最长多少个字符：包里最深的文件在 versions\<版本>-<编号>\ 下还有约 95 个字符，PowerShell 5.1 解包、拷贝
  # 和快捷方式都受 260 个字符的限制（src/move/ 用同一个数）
  $MaxHomeChars = 120

  function Ok($text) { Write-Host "  " -NoNewline; Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline; Write-Host " $text" }
  function Warn($text) { Write-Host "  ! " -ForegroundColor Yellow -NoNewline; Write-Host $text }
  function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }
  function Heading($text) { Write-Host ""; Write-Host "  $text" }
  # 说清楚哪里不行、怎么办，然后停下。到这一步为止没有换掉任何已经装好的东西
  function Fail($title) {
    $lines = @($args)
    throw [System.Management.Automation.RuntimeException]::new("ORANGESPEAKEASY_INSTALL_FAILED`n$title`n$($lines -join "`n")")
  }
  # 给人看的路径：家目录写成 ~
  function Pretty($path) { if ($path.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) { '~' + $path.Substring($HOME.Length) } else { $path } }

  # 跑一个外部程序，交出它的输出（标准错误一起）和退出码。临时放宽：5.1 会把标准错误当成异常；
  # 输出按 UTF-8 读（OrangeSpeakEasy 写的是 UTF-8，5.1 默认按系统编码读），读完把用户窗口的编码换回去
  function Invoke-Native([string]$file, [string[]]$arguments, [hashtable]$environment = @{}) {
    $saved = @{}
    foreach ($name in $environment.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $environment[$name]) }
    $previous = $ErrorActionPreference
    $encoding = [Console]::OutputEncoding
    $ErrorActionPreference = 'Continue'
    try {
      [Console]::OutputEncoding = [Text.Encoding]::UTF8
      $output = & $file @arguments 2>&1 | ForEach-Object { "$_" }
      return @{ Output = ($output -join "`n"); Code = $LASTEXITCODE }
    } finally {
      [Console]::OutputEncoding = $encoding
      $ErrorActionPreference = $previous
      foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
  }

  # ---------- 预检查 ----------

  function Test-System {
    $build = [Environment]::OSVersion.Version.Build
    if ($build -lt $MinBuild) { Fail "Windows (build $build) is too old" "OrangeSpeakEasy needs Windows 10 version 1809 or newer, or Windows 11." }
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    switch ($arch) {
      'AMD64' { Ok "Windows (build $build), x64" }
      # Windows on ARM 跑得了 x64 的程序（系统自带的转译），本机转写用不上显卡加速
      'ARM64' { Ok "Windows (build $build), ARM"; Note "OrangeSpeakEasy is built for x64; it runs here through Windows' x64 emulation." }
      default { Fail "Unsupported processor: $arch" "OrangeSpeakEasy is built for 64-bit Windows (x64)." }
    }
  }

  # 只让自己（和 SYSTEM）进得去：里面会有录音和 key。和 OrangeSpeakEasy 自己（src/storage/owner-only.mjs）做的一样
  function Protect-Home($dir) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $result = Invoke-Native 'icacls' @($dir, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F')
    if ($result.Code -ne 0) { Fail "Couldn't restrict access to $(Pretty $dir)" $result.Output }
  }

  # 定位文件说的家目录（没有这个文件时是空的）。读坏了就停：不悄悄装到默认位置去，那样数据还在原处、看着却像丢了
  function Read-Location {
    if (-not (Test-Path -LiteralPath $script:LocationFile)) { return '' }
    # 不叫 $home：PowerShell 的变量名不分大小写，那是只读的 $HOME
    $recorded = $null
    try { $recorded = ([IO.File]::ReadAllText($script:LocationFile, [Text.Encoding]::UTF8) | ConvertFrom-Json).home } catch { $recorded = $null }
    $valid = ($recorded -is [string]) -and ($recorded -match '^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+') -and ($recorded -notmatch '[\x00-\x1f]')
    if (-not $valid) {
      Fail "OrangeSpeakEasy's location file is invalid: $(Pretty $script:LocationFile)" "It should hold the full path of the OrangeSpeakEasy folder. Delete it to use the default place ($(Pretty $script:DefaultHome))."
    }
    return Get-FullHome $recorded
  }

  # 规范成完整写法（/ 换成 \、去掉 ..、末尾的 \）：写进 Path、快捷方式、定位文件的，和程序按自己位置算出来的是同一个字符串
  function Get-FullHome($path) {
    $full = [IO.Path]::GetFullPath($path)
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
    return $full
  }

  # 这个目录里有没有东西（装过、用过）
  function Test-HasContents($dir) {
    (Test-Path -LiteralPath $dir -PathType Container) -and @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue).Count -gt 0
  }

  # 这个目录 OrangeSpeakEasy 用过（重装系统前放在别的盘上的那种）：选到它时沿用里面的东西
  function Test-UsedBefore($dir) {
    foreach ($name in @('settings.json', 'data', 'models', 'versions')) {
      if (Test-Path -LiteralPath (Join-Path $dir $name)) { return $true }
    }
    return $false
  }

  # 选的文件夹能不能装（第一次安装时问到的、ORANGESPEAKEASY_INSTALL_DIR 给的）：能装交回 @{ Home; Folder }（Home 是文件夹里的
  # .orangespeakeasy，选的本身就叫 .orangespeakeasy 就是它），不能交回 @{ Problem = 为什么 }
  function Test-Place([string]$folder) {
    if ($folder -notmatch '^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+') { return @{ Problem = 'Use a full path, like D:\Apps' } }
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { return @{ Problem = "No such folder: $folder (create it first, or pick another one)" } }
    $folder = Get-FullHome $folder
    $target = if ((Split-Path -Leaf $folder) -ieq '.orangespeakeasy') { $folder } else { Join-Path $folder '.orangespeakeasy' }
    if ((Test-HasContents $target) -and -not (Test-UsedBefore $target)) { return @{ Problem = "$target already has other things in it; pick another folder" } }
    if ($target.Length -gt $MaxHomeChars) { return @{ Problem = "That path is too long ($($target.Length) characters, at most $MaxHomeChars); pick a shorter place" } }
    # 家目录要能设成只有自己能进（访问控制表）：FAT32、exFAT（U 盘、移动硬盘常见）没有这个。网络路径问不到格式，不拦
    $format = $null
    try { $format = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($target)).DriveFormat } catch { $format = $null }
    if ($format -and $format -notin @('NTFS', 'ReFS')) { return @{ Problem = "$folder is on a disk formatted as $format; OrangeSpeakEasy needs NTFS" } }
    # 写得进去（Program Files 这类要管理员权限的地方写不进）
    $probe = Join-Path $folder ".orangespeakeasy-probe-$PID"
    try { [IO.File]::Create($probe).Dispose(); [IO.File]::Delete($probe) } catch { return @{ Problem = "Can't write to $folder; pick a folder of your own, like D:\Apps" } }
    return @{ Home = $target; Folder = $folder }
  }

  # 选了装在哪个文件夹下（ORANGESPEAKEASY_INSTALL_DIR，安装程序问的就是它）：只用于第一次安装。别处已经有一份的话停下，
  # 不然会多出一个空的目录。已经装了的用 orangespeakeasy move 搬
  function Resolve-InstallDir($located) {
    $place = Test-Place $env:ORANGESPEAKEASY_INSTALL_DIR
    if ($place.Problem) { Fail "Can't install into ORANGESPEAKEASY_INSTALL_DIR: $($place.Problem)" }
    $target = $place.Home
    foreach ($other in @($located, $script:DefaultHome)) {
      if (-not $other -or $other -ieq $target -or -not (Test-HasContents $other)) { continue }
      Fail "OrangeSpeakEasy is already set up in $(Pretty $other)" "To keep using it there, run this again without ORANGESPEAKEASY_INSTALL_DIR." "To move it to $target, run: orangespeakeasy move `"$($place.Folder)`""
    }
    return $target
  }

  # 第一次安装、在 PowerShell 窗口里时问一句装在哪：回车是默认位置，也可以输入一个文件夹（资源管理器"复制为路径"带的引号去掉）。
  # 选了别处就和 ORANGESPEAKEASY_INSTALL_DIR 一样：装进它里面的 .orangespeakeasy、记进定位文件
  function Read-Place {
    Heading "Where to install"
    Note "OrangeSpeakEasy keeps everything in one folder: the program, on-device models (0.2-1.6 GB each),"
    Note "and your settings, history and recordings. You can move it later with: orangespeakeasy move"
    Write-Host "  Press Enter to use $(Pretty $script:DefaultHome), or type a folder (for example D:\Apps)"
    Write-Host "  to install into .orangespeakeasy inside it."
    while ($true) {
      $answer = "$(Read-Host '  Folder')".Trim().Trim('"').Trim()
      if (-not $answer) { return }
      if ($answer -eq '~') { $answer = $env:USERPROFILE } elseif ($answer -match '^~[\\/]') { $answer = Join-Path $env:USERPROFILE $answer.Substring(2) }
      $place = Test-Place $answer
      if ($place.Problem) { Warn $place.Problem; continue }
      if ($place.Home -ieq $script:DefaultHome) { return }
      $script:HomeDir = $place.Home; $script:HomeFrom = 'chosen'
      if (Test-UsedBefore $place.Home) { Note "Found OrangeSpeakEasy data there; it will be used as it is." }
      return
    }
  }

  function Test-Home {
    # 只拦新选的、还不存在的位置：已经装在那里的（0.11.0 起装进去的）照常升级，不因为这条规矩突然升不了
    if ($script:HomeDir.Length -gt $MaxHomeChars -and ($script:HomeFrom -eq 'chosen' -or -not (Test-Path -LiteralPath $script:HomeDir))) {
      Fail "Install path is too long: $($script:HomeDir)" "Pick a place at most $MaxHomeChars characters long and run again."
    }
    # 定位文件说装在一个现在不在的地方（移动硬盘没接、盘符被另一块盘占了）：不在那里新建一个空的，也不改装到默认位置
    if ($script:HomeFrom -eq 'location' -and -not (Test-Path -LiteralPath $script:HomeDir -PathType Container)) {
      Fail "Can't find the OrangeSpeakEasy folder: $($script:HomeDir)" "If it's on an external drive, connect the drive and run this again." "If you no longer use that place, delete $(Pretty $script:LocationFile) to install to the default one."
    }
    try { [IO.Directory]::CreateDirectory($script:HomeDir) | Out-Null } catch {
      Fail "Can't create $(Pretty $script:HomeDir)" "Check its permissions, or install somewhere else with ORANGESPEAKEASY_INSTALL_DIR." "($($_.Exception.Message))"
    }
    Protect-Home $script:HomeDir
    if ($script:PreviousHome) {
      # 换家：程序已经整个拷过来了，不再占新的地方
      Ok "Moving to $(Pretty $script:HomeDir)"
    } else {
      # 网络路径（\\server\share）问不到剩余空间，不拦
      $freeMB = $null
      try { $freeMB = [int]([IO.DriveInfo]::new([IO.Path]::GetPathRoot($script:HomeDir)).AvailableFreeSpace / 1MB) } catch { $freeMB = $null }
      if ($null -ne $freeMB -and $freeMB -lt $NeededMB) { Fail "Not enough disk space: $freeMB MB free" "About $NeededMB MB is needed. Free up some space and run again." }
      $free = if ($null -ne $freeMB) { " ($([int]($freeMB / 1024)) GB free)" } else { '' }
      Ok "Installing to $(Pretty $script:HomeDir)$free"
    }

    # 已经装着的是哪个版本：current 指着的那个；0.9.2 及以前没有 current，程序直接在 app 里。
    # current 读不出来或者是坏的（比如写到一半断了电），就当作没装：这次装好会重写它，所以再装一次就修好了
    $script:InstalledVersion = ''
    $manifest = Join-Path $script:HomeDir 'app\package.json'
    if (Test-Path -LiteralPath $script:CurrentFile) {
      $name = ''
      try { $name = [IO.File]::ReadAllText($script:CurrentFile).Trim() } catch { $name = '' }
      $manifest = if ($name -match $VersionNamePattern) { Join-Path $script:VersionsDir "$name\app\package.json" } else { $null }
      if ($name -match $VersionNamePattern) { $script:PreviousName = $name }
    }
    if ($manifest -and (Test-Path -LiteralPath $manifest)) {
      try { $script:InstalledVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath $manifest | ConvertFrom-Json).version } catch { $script:InstalledVersion = '' }
    }
    if ($script:InstalledVersion) { Ok "Found $($script:InstalledVersion): replacing it; settings, keys, history and recordings stay" }
  }

  # 同一个家目录同时只装一个：两个一起装（比如安装程序被双击了两次）会互相把对方的新版本当成旧的删掉。
  # 用一个按家目录取名的系统互斥量，不在磁盘上留锁文件；进程没了系统自己收回
  function Enter-Install {
    $key = [Text.Encoding]::UTF8.GetBytes($script:HomeDir.TrimEnd('\').ToLowerInvariant())
    $id = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($key) | Select-Object -First 8 | ForEach-Object { $_.ToString('x2') })
    $script:InstallLock = [Threading.Mutex]::new($false, "Local\orangespeakeasy-install-$id")
    # 上一个安装没放开就没了（被强行结束），互斥量算"被丢下"，可以接着用
    try { $script:LockHeld = $script:InstallLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $script:LockHeld = $true }
    if (-not $script:LockHeld) { Fail "Another OrangeSpeakEasy install is running" "Wait for it to finish. Run this again afterwards if you still need to." }
  }
  function Exit-Install {
    if ($script:LockHeld) { $script:InstallLock.ReleaseMutex() }
    if ($script:InstallLock) { $script:InstallLock.Dispose() }
    $script:InstallLock = $null; $script:LockHeld = $false
  }

  # 取下载地址上的一个文件，整个读进内存（一个 MemoryStream）：不落到磁盘上，就没有临时文件要删。
  # 下载地址可以是本机的一个目录（测试发布包、双击安装程序带着的那一份）。
  # 不用 Invoke-WebRequest：5.1 拿到响应后会把整个包再拷成字节数组、再按字符转成好几份字符串，约 200 MB 的包要占一两 GB 内存。
  # 这里照响应说的长度开好一块内存，边下边写进去，只占包那么大
  $script:LocalBase = $false
  function Get-Remote($name) {
    if ($script:LocalBase) {
      $source = Join-Path $script:Base $name
      if (-not (Test-Path -LiteralPath $source)) { throw "No such file: $source" }
      return [IO.MemoryStream]::new([IO.File]::ReadAllBytes($source))
    }
    $request = [Net.WebRequest]::Create("$($script:Base)/$name")
    # 20 秒连不上、或者下着下着一分钟没再收到数据，算失败；慢但一直在下的不限总时长
    $request.Timeout = 20000
    $request.ReadWriteTimeout = 60000
    $response = $request.GetResponse()
    try {
      $length = $response.ContentLength
      $buffer = if ($length -gt 0 -and $length -lt [int]::MaxValue) { [IO.MemoryStream]::new([int]$length) } else { [IO.MemoryStream]::new() }
      $body = $response.GetResponseStream()
      try { $body.CopyTo($buffer) } finally { $body.Dispose() }
    } finally { $response.Dispose() }
    $buffer.Position = 0
    return $buffer
  }
  function Get-RemoteText($name) { [Text.Encoding]::UTF8.GetString((Get-Remote $name).ToArray()) }

  # 定下装哪个版本：指定了就用指定的，没指定就问下载地址最新的是哪个（channel.json 里的 version）
  function Resolve-Version {
    $version = $env:ORANGESPEAKEASY_VERSION
    if ($version) {
      if (-not $version.StartsWith('v')) { $version = "v$version" }
    } else {
      try { $version = 'v' + [string](Get-RemoteText 'channel.json' | ConvertFrom-Json).version } catch {
        Fail "Couldn't find the latest version" "URL: $($script:Base)/channel.json" "Check your network and try again in a bit." "($($_.Exception.Message))"
      }
    }
    # 版本号要拼进下载地址：不像版本号的不往下走（比如问到的其实是一个报错的网页）
    if ($version -notmatch '^v\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$') {
      if ($env:ORANGESPEAKEASY_VERSION) { Fail "ORANGESPEAKEASY_VERSION doesn't look like a version: $($env:ORANGESPEAKEASY_VERSION)" "Write it like v0.9.0." }
      Fail "The download server returned a bad version number" "URL: $($script:Base)/channel.json" "Try again in a bit. If it keeps happening, please open an issue at $RepoUrl/issues."
    }
    if ([version]($version.Substring(1) -replace '[-+].*$', '') -lt $MinVersion) {
      Fail "This installer can't install $version" "Versions before v$MinVersion are laid out differently." "To go back to one, first run: orangespeakeasy uninstall --keep-data" "then run that version's setup: $DownloadUrl/$version/OrangeSpeakEasy-Setup-x64.exe"
    }
    $script:Version = $version
    Ok "Version $version"
  }

  # ---------- 安装 ----------
  #
  # 每个版本解进 versions 下自己的一个新目录，试过能跑，再把 current 指过去；不挪、不覆盖已有的任何文件。
  # 以前是解到临时目录再挪进 app\、runtime\，有两样东西让"挪"靠不住：
  #   - 刚解出来、刚跑过的文件，杀毒软件（还有索引、备份这类）正在一个个扫，扫的时候开着它又不许别人改名，
  #     挪就报"另一个进程正在使用此文件"（issue #5，真机上占住一个刚解出来的文件就能原样复现）。不挪就碰不上
  #   - 正在跑的 Electron（比如正在跑 orangespeakeasy update 的那一份）占着它所在的目录。新版本另放一个目录，旧的原地不动
  # 换下来的旧版本没人用了再删（Remove-Old）；删不掉不影响装好的这一份

  function Get-Package {
    # 包下载进内存，在内存里校验、解开：磁盘上不落临时文件。刚落地的文件杀毒软件要扫，扫的时候删不掉，会留下垃圾
    try {
      $package = Get-Remote "$($script:Version)/$Archive"
      $expected = ((Get-RemoteText "$($script:Version)/$Archive.sha256").Trim() -split '\s+')[0].ToLowerInvariant()
    } catch {
      Fail "Couldn't download the package" "URL: $($script:Base)/$($script:Version)/$Archive" "Check your network. If you set ORANGESPEAKEASY_VERSION, make sure that version exists." "($($_.Exception.Message))"
    }
    Ok "Downloaded"

    $actual = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($package) | ForEach-Object { $_.ToString('x2') })
    if (-not $expected -or $expected -ne $actual) {
      Fail "Checksum mismatch: the download differs from the release" "It was probably damaged on the way. Run it again." "Expected $expected" "Got      $actual"
    }
    Ok "Checksum OK"

    New-VersionDir $script:Version.Substring(1)
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    try {
      $package.Position = 0
      $archive = [IO.Compression.ZipArchive]::new($package)
      try { [IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $script:VersionDir) } finally { $archive.Dispose() }
    } catch { Fail "Couldn't unpack the package" "Run it again." "($($_.Exception.Message))" }
    Test-NewCopy 'Unpacked'
  }

  # 名字是版本号加这次的编号：重装同一个版本也是一个新目录，碰不到正在用的那一份。
  # 建出来了才记下它（出错时要删的就是它）：万一撞上已有的目录，New-Item 报错，不会把那个删了
  function New-VersionDir([string]$version) {
    $name = "$version-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    # 不用 New-Item -Path：路径里的 [ ] 会被当成通配符
    [IO.Directory]::CreateDirectory($script:VersionsDir) | Out-Null
    $dir = Join-Path $script:VersionsDir $name
    if (Test-Path -LiteralPath $dir) { throw "$dir already exists" }
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $script:VersionName = $name
    $script:VersionDir = Join-Path $script:VersionsDir $name
  }

  # 从一棵已经准备好的树装（ORANGESPEAKEASY_INSTALL_FROM）：orangespeakeasy update 拼在 versions 下一个新目录里的，原地用，不挪；
  # 别处的（安装程序解在临时目录里的）拷进 versions 下一个新目录。拷而不挪：刚解出来的文件杀毒软件正扫着，挪不动
  function Use-Tree {
    $from = [IO.Path]::GetFullPath($env:ORANGESPEAKEASY_INSTALL_FROM).TrimEnd('\')
    if (-not (Test-Path -LiteralPath (Join-Path $from 'app\bin\orangespeakeasy.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $from 'runtime\electron.exe'))) {
      Fail "The prepared copy is incomplete: $from" "Please open an issue at $RepoUrl/issues."
    }
    $name = Split-Path -Leaf $from
    if ((Split-Path -Parent $from) -ieq $script:VersionsDir -and $name -match $VersionNamePattern) {
      $script:VersionName = $name
      $script:VersionDir = $from
      $script:InPlace = $true
    } else {
      $version = ''
      try { $version = [string](Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $from 'app\package.json') | ConvertFrom-Json).version } catch { $version = '' }
      if ($version -notmatch '^\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$') { Fail "The prepared copy has no valid version: $from" "Please open an issue at $RepoUrl/issues." }
      New-VersionDir $version
      # -LiteralPath：临时目录的路径里可能有 [ ]（用户名里带的），-Path 会把它们当通配符
      try { Get-ChildItem -LiteralPath $from -Force | Copy-Item -Destination $script:VersionDir -Recurse -Force } catch {
        Fail "Couldn't copy the new version into $(Pretty $script:VersionsDir)" "Check the free space and run it again." "($($_.Exception.Message))"
      }
    }
    Test-NewCopy 'Prepared'
  }

  # 换家：用拷到新目录里、current 指着的那个版本，原地用。出错时绝不删它：换回去（对旧目录再换一次家）时它就是装着的那一份
  function Use-Copied {
    $name = ''
    try { $name = [IO.File]::ReadAllText($script:CurrentFile).Trim() } catch { $name = '' }
    if ($name -notmatch $VersionNamePattern -or -not (Test-Path -LiteralPath (Join-Path $script:VersionsDir "$name\app\bin\orangespeakeasy.mjs"))) {
      Fail "$(Pretty $script:HomeDir) has no copy of OrangeSpeakEasy to move to"
    }
    $script:VersionName = $name
    $script:VersionDir = Join-Path $script:VersionsDir $name
    $script:InPlace = $true
    $script:KeepVersionDir = $true
    Test-NewCopy 'Copied'
  }

  # 切过去之前先在原地跑一下：这台机器上跑不起来的话现在就知道，装着的那一份照常用。
  # 换家时跑的是拷过去的那一份：新位置的盘不让执行、权限不对的话，在这里就发现
  function Test-NewCopy([string]$verb) {
    $script:NewElectron = Join-Path $script:VersionDir 'runtime\electron.exe'
    $script:NewApp = Join-Path $script:VersionDir 'app'
    if (-not (Test-Path -LiteralPath (Join-Path $script:NewApp 'bin\orangespeakeasy.mjs')) -or -not (Test-Path -LiteralPath $script:NewElectron)) {
      Fail "The package is incomplete" "That's a problem with the release. Please open an issue at $RepoUrl/issues."
    }
    $result = Invoke-NewCopy @('--version')
    if ($result.Code -ne 0) { Fail "The new copy of OrangeSpeakEasy won't run on this PC" $result.Output "Please open an issue at $RepoUrl/issues with your Windows version." }
    $script:NewVersion = $result.Output.Trim()
    Ok "$verb OrangeSpeakEasy $($script:NewVersion)"
  }

  # 用刚下到的那一份程序跑一条命令。让它说英文：下面要靠它说的话判断停没停
  function Invoke-NewCopy([string[]]$arguments) {
    Invoke-Native $script:NewElectron (@((Join-Path $script:NewApp 'bin\orangespeakeasy.mjs')) + $arguments) @{
      ORANGESPEAKEASY_HOME = $script:HomeDir; ELECTRON_RUN_AS_NODE = '1'; ORANGESPEAKEASY_LANGUAGE = 'en'
    }
  }

  # 启动脚本：照 current 找程序，只用相对它自己的路径（路径里有中文也不用管 cmd 按什么编码读），整个目录搬到别处照样能用。
  # 家目录总是它自己所在的那个，不沿用外面传进来的 ORANGESPEAKEASY_HOME：程序和数据永远是同一个目录里的，搬家后残留的旧变量也带不偏。
  # 内容不随版本变，平常不用改写。从旧版本升上来时要改写，而那时它可能正跑着（orangespeakeasy update 就是它起的）：cmd 等程序退出后，
  # 从原来读到的那个字节位置接着读这个文件。所以新内容不能比旧的长，读到的就是文件末尾。以后改这几行也守着这条：
  # 不比发出去过的任何一版长（test/install/install-ps1.test.mjs 查）
  $LauncherText = @(
    '@echo off',
    'setlocal',
    'for %%I in ("%~dp0..") do set "ORANGESPEAKEASY_HOME=%%~fI"',
    'set /p ORANGESPEAKEASY_CURRENT=<"%~dp0..\current"',
    'set ELECTRON_RUN_AS_NODE=1',
    '"%~dp0..\versions\%ORANGESPEAKEASY_CURRENT%\runtime\electron.exe" "%~dp0..\versions\%ORANGESPEAKEASY_CURRENT%\app\bin\orangespeakeasy.mjs" %*'
  ) -join "`r`n"

  # 切到新版本：停掉正在跑的（它跑的是旧版本），把 current 指过去，再写启动脚本。只写这两个小文件，不挪、不删任何东西
  function Use-Version {
    $result = Invoke-NewCopy @('stop')
    if ($result.Code -ne 0) { Fail "Couldn't stop the running OrangeSpeakEasy" $result.Output "Quit it first, then install again." }
    if ($result.Output -match 'OrangeSpeakEasy stopped\.|force-quit') { Ok "Stopped the running OrangeSpeakEasy"; $script:Stopped = $true }

    try { [IO.File]::WriteAllText($script:CurrentFile, $script:VersionName, [Text.Encoding]::ASCII) } catch {
      $restart = if ($script:Stopped) { "OrangeSpeakEasy was stopped; run orangespeakeasy to start it again." } else { "" }
      Fail "Couldn't switch to the new version" "Another program has $(Pretty $script:CurrentFile) open. Run again in a moment. $restart" "($($_.Exception.Message))"
    }
    $script:Switched = $true

    $binDir = Join-Path $script:HomeDir 'bin'
    [IO.Directory]::CreateDirectory($binDir) | Out-Null
    $script:Launcher = Join-Path $binDir 'orangespeakeasy.cmd'
    if (-not (Test-Path -LiteralPath $script:Launcher) -or [IO.File]::ReadAllText($script:Launcher) -ne "$LauncherText`r`n") {
      [IO.File]::WriteAllText($script:Launcher, "$LauncherText`r`n", [Text.Encoding]::ASCII)
    }
    if ($script:PreviousHome) { Ok "Moved to $(Pretty $script:HomeDir)" } else { Ok "Installed to $(Pretty $script:HomeDir)" }
  }

  # 现在删不掉的目录交给一个隐藏的 PowerShell 慢慢删，这个窗口不用等：给了进程就先等它们退出，然后每隔 3 秒试一次，试一分钟
  # （刚解出来、刚跑过的文件杀毒软件要扫一阵，扫完才删得掉）。还剩下的，下次安装时再删。目录走环境变量传过去，脚本里不拼路径
  function Remove-Later($ids, $dirs) {
    $ids = @($ids | Sort-Object -Unique)
    $cleanup = @(
      $(if ($ids.Count -gt 0) { "Wait-Process -Id $($ids -join ',') -ErrorAction SilentlyContinue" } else { '' }),
      '$dirs = @($env:ORANGESPEAKEASY_REMOVE.Split([char]10) | Where-Object { $_ })',
      'for ($i = 0; $i -lt 20 -and $dirs.Count -gt 0; $i++) {',
      '  if ($i -gt 0) { Start-Sleep -Seconds 3 } else { Start-Sleep -Milliseconds 800 }',
      '  foreach ($dir in $dirs) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }',
      '  $dirs = @($dirs | Where-Object { Test-Path -LiteralPath $_ })',
      '}'
    ) -join "`n"
    $env:ORANGESPEAKEASY_REMOVE = $dirs -join "`n"
    try {
      Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-NonInteractive', '-EncodedCommand', ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanup)))
    } finally { Remove-Item Env:ORANGESPEAKEASY_REMOVE }
  }

  # orangespeakeasy update 拼新版本时拿着 run\update.lock（里面是它的进程号，src/update/state.mjs），拼在 versions 下一个新目录里。
  # 它自己调这个脚本装它拼的那一份时（Use-Tree 原地用）不算别的；锁里的进程没了、或者拿了两小时以上（进程号早被别的程序用上了）也不算
  function Test-OtherUpdate {
    if ($script:InPlace) { return $false }
    $lock = Join-Path $script:HomeDir 'run\update.lock'
    try {
      $age = (Get-Date) - (Get-Item -LiteralPath $lock -Force -ErrorAction Stop).LastWriteTime
      $holder = [IO.File]::ReadAllText($lock).Trim()
    } catch { return $false }
    # 刚建好、还没写进进程号：那边正要写
    if ($holder -notmatch '^\d+$') { return $age.TotalSeconds -lt 10 }
    if ($age.TotalHours -ge 2) { return $false }
    return [bool](Get-Process -Id ([int]$holder) -ErrorAction SilentlyContinue)
  }

  # 换下来的：versions 里别的版本、0.9.2 及以前直接放在家目录里的 app 和 runtime（连同那时换下来的 *.old.*、
  # 装到一半留下的下载临时目录 .install.*）。没有程序在用的现在删；有程序在用的（比如正在跑 orangespeakeasy update 的那个旧版本）
  # 和现在删不掉的，交给 Remove-Later
  function Remove-Old {
    $old = @(Get-ChildItem -LiteralPath $script:HomeDir -Directory -Force | Where-Object { $_.Name -match '^(app|runtime)(\.old\..+)?$|^\.install\.' })
    $versions = @(Get-ChildItem -LiteralPath $script:VersionsDir -Directory -Force | Where-Object { $_.Name -match $VersionNamePattern -and $_.Name -ne $script:VersionName })
    # 别的 orangespeakeasy update 正在 versions 下拼新版本：只删换下来的那一份，别的可能是它拼了一半的，留给下次装时再删
    if (Test-OtherUpdate) { $versions = @($versions | Where-Object { $_.Name -eq $script:PreviousName }) }
    $old += $versions
    if ($old.Count -eq 0) { return }
    # 路径只读一次、存下来：5.1 里进程的 Path 每读一次都现算（$this.Mainmodule.FileName），
    # 进程在两次读之间退出（比如刚停掉的旧版本还在收尾），再读就是空的（issue #11）
    $running = @(Get-Process | ForEach-Object { $path = $_.Path; if ($path) { [pscustomobject]@{ Id = $_.Id; Path = $path } } })
    $later = @(); $waitFor = @(); $left = @()
    foreach ($dir in $old) {
      $prefix = $dir.FullName.TrimEnd('\') + '\'
      $users = @($running | Where-Object { $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
      if ($users.Count -gt 0) { $later += $dir.FullName; $waitFor += $users.Id; continue }
      Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $dir.FullName) { $left += $dir.FullName }
    }
    if ($later.Count + $left.Count -eq 0) { return }
    Remove-Later $waitFor ($later + $left)
    if ($later.Count -gt 0) { Note "The previous version is still running; it will be removed once it exits." }
    if ($left.Count -gt 0) { Note "Another program still has files open in $(($left | ForEach-Object { Pretty $_ }) -join ', '); they'll be removed once it lets go." }
  }

  # 记下在家目录以外动了什么，卸载时照着删（src/cli/commands/uninstall.mjs）。按 UTF-8 读写，不经 Get-Content 那一套：
  # 路径里的 [ ] 会被当成通配符
  function Get-Links {
    $file = Join-Path $script:HomeDir 'bin\links'
    if (-not (Test-Path -LiteralPath $file)) { return @() }
    return @([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) -split "`r?`n" | Where-Object { $_ })
  }
  function Set-Links($lines) {
    $text = if (@($lines).Count -gt 0) { (@($lines) -join "`r`n") + "`r`n" } else { '' }
    [IO.File]::WriteAllText((Join-Path $script:HomeDir 'bin\links'), $text, [Text.UTF8Encoding]::new($false))
  }
  function Add-Link($line) {
    $lines = Get-Links
    if ($lines -notcontains $line) { Set-Links (@($lines) + $line) }
  }

  # 用户的 Path 里加上 bin。按原样读写：读的时候不展开 %USERPROFILE% 这种写法，写回去还是可展开的那一种。
  # 换家时先去掉指着旧目录 bin 的那一项（bin\links 里的记录一起去掉），再加新的
  function Add-ToPath {
    $binDir = Join-Path $script:HomeDir 'bin'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = @($raw -split ';' | Where-Object { $_ })
      if ($script:PreviousHome) {
        $oldBin = (Join-Path $script:PreviousHome 'bin').TrimEnd('\')
        $isOld = { param($entry) [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -ieq $oldBin }
        $gone = @($entries | Where-Object { & $isOld $_ })
        if ($gone.Count -gt 0) {
          $entries = @($entries | Where-Object { -not (& $isOld $_) })
          $key.SetValue('Path', ($entries -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
          [Environment]::SetEnvironmentVariable('ORANGESPEAKEASY_PATH_CHANGED', '1', 'User')
          [Environment]::SetEnvironmentVariable('ORANGESPEAKEASY_PATH_CHANGED', $null, 'User')
          Ok "Removed $(Pretty $oldBin) from your Path"
        }
        Set-Links @(Get-Links | Where-Object { -not ($_ -like 'path *' -and (& $isOld $_.Substring(5))) })
      }
      $present = $entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $binDir.TrimEnd('\') }
      # 默认的位置写成 %USERPROFILE%\.orangespeakeasy\bin：换了用户名、挪了用户目录也对
      $entry = $binDir
      if ($binDir -ieq (Join-Path $env:USERPROFILE '.orangespeakeasy\bin')) { $entry = '%USERPROFILE%\.orangespeakeasy\bin' }
      if (-not $present) {
        $key.SetValue('Path', (($entries + $entry) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # 借设一个环境变量让系统广播一次"环境变了"：之后新开的终端才认新的 Path
        [Environment]::SetEnvironmentVariable('ORANGESPEAKEASY_PATH_CHANGED', '1', 'User')
        [Environment]::SetEnvironmentVariable('ORANGESPEAKEASY_PATH_CHANGED', $null, 'User')
        Ok "Added $(Pretty $binDir) to your Path"
      } else {
        $entry = $present | Select-Object -First 1
        Ok "$(Pretty $binDir) is on your Path"
      }
      Add-Link "path $entry"
    } finally { $key.Dispose() }
    # 这个窗口里也马上能用
    if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
  }

  # 快捷方式指到新版本：直接起 Electron、把程序目录交给它（和 orangespeakeasy 命令起的是同一个，用同一套 key 和设置）
  function Set-Shortcut($shortcut) {
    $shortcut.TargetPath = $script:NewElectron
    $shortcut.Arguments = '"' + $script:NewApp + '"'
    $shortcut.WorkingDirectory = $script:HomeDir
    $shortcut.IconLocation = (Join-Path $script:NewApp 'assets\icon.ico') + ',0'
    $shortcut.Save()
  }

  function Add-Shortcut {
    $programs = [Environment]::GetFolderPath('Programs')
    $link = Join-Path $programs 'OrangeSpeakEasy.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
    $shortcut.Description = 'OrangeSpeakEasy: press a hotkey, speak, and polished text is pasted in'
    Set-Shortcut $shortcut
    Add-Link "shortcut $link"
    Ok "Start menu: OrangeSpeakEasy"
  }

  # 认哪些家目录里的程序是"我们的"：这个家目录；换家时还有旧的那个（指着它的都要改指过来）
  function Get-HomePrefixes {
    @($script:HomeDir, $script:PreviousHome) | Where-Object { $_ } | ForEach-Object { "$($_.TrimEnd('\'))\" }
  }
  function Test-InOurHomes([string]$path) {
    foreach ($prefix in Get-HomePrefixes) { if ($path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
    return $false
  }

  # 固定到任务栏、发送到桌面的是开始菜单那个快捷方式的副本，还指着换下来的版本，旧版本删掉后就打不开了。
  # 指着这个家目录（换家时还有旧目录）里的 Electron（versions 下的，或者 0.9.2 及以前的 runtime 里的）的，改指到新版本。
  # Squirrel 那一类按版本放程序的安装程序也这么修固定的图标
  function Update-ShortcutCopies {
    $places = @(
      @{ Dir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned'; Recurse = $true },
      @{ Dir = [Environment]::GetFolderPath('Desktop'); Recurse = $false }
    )
    $shell = New-Object -ComObject WScript.Shell
    $updated = 0
    foreach ($place in $places) {
      if (-not $place.Dir -or -not (Test-Path -LiteralPath $place.Dir)) { continue }
      foreach ($file in @(Get-ChildItem -LiteralPath $place.Dir -Filter '*.lnk' -File -Recurse:$place.Recurse -Force -ErrorAction SilentlyContinue)) {
        try {
          $shortcut = $shell.CreateShortcut($file.FullName)
          $target = $shortcut.TargetPath
          if (-not (Test-InOurHomes $target) -or -not $target.EndsWith('\runtime\electron.exe', [StringComparison]::OrdinalIgnoreCase)) { continue }
          if ($target -ieq $script:NewElectron) { continue }
          Set-Shortcut $shortcut
          $updated++
        } catch { Note "Couldn't update the shortcut $(Pretty $file.FullName): $($_.Exception.Message)" }
      }
    }
    if ($updated -gt 0) { Ok "Pinned shortcuts: OrangeSpeakEasy $($script:NewVersion)" }
  }

  # App 设置里开了开机启动的话，Run 里那一项指着旧版本的程序：改指到新版本，写法和 Electron 一样（程序、参数各加引号）。
  # Electron 读回来认开没开只比程序路径；任务管理器里停用与否另记在 StartupApproved 里，这里不动。
  # 只认程序在这个家目录（换家时还有旧目录）里的
  function Update-LoginItem {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $value = (Get-ItemProperty -Path $key -Name 'OrangeSpeakEasy' -ErrorAction SilentlyContinue).OrangeSpeakEasy
    if (-not $value) { return }
    $program = if ($value.StartsWith('"')) { $value.Substring(1).Split('"')[0] } else { $value.Split(' ')[0] }
    if (-not (Test-InOurHomes $program)) { return }
    Set-ItemProperty -Path $key -Name 'OrangeSpeakEasy' -Value ('"{0}" "{1}"' -f $script:NewElectron, $script:NewApp)
    Ok "Start at login: OrangeSpeakEasy $($script:NewVersion)"
  }

  # 记下 OrangeSpeakEasy 装在哪（定位文件）：只在明确选了位置时（ORANGESPEAKEASY_INSTALL_DIR、orangespeakeasy move 换家）。
  # 在默认位置就不要定位文件（有就删掉）；在别处就写（UTF-8 不带 BOM，先写到旁边、落了盘再换上）。写不了就照实报错：
  # 不然安装程序打开 App、下次安装都找不到它
  function Update-Location {
    try {
      if ($script:HomeDir -ieq $script:DefaultHome) {
        if (Test-Path -LiteralPath $script:LocationFile) { [IO.File]::Delete($script:LocationFile) }
        return
      }
      [IO.Directory]::CreateDirectory((Split-Path -Parent $script:LocationFile)) | Out-Null
      $temporary = "$($script:LocationFile).$PID.tmp"
      $json = "{`r`n  `"home`": $(ConvertTo-Json $script:HomeDir)`r`n}`r`n"
      $stream = [IO.File]::Open($temporary, [IO.FileMode]::Create, [IO.FileAccess]::Write)
      try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
      } finally { $stream.Dispose() }
      # 不留备份：第三个参数要真的 null，PowerShell 把 $null 当成空字符串传给 .NET，Replace 就报"路径是空的"
      if (Test-Path -LiteralPath $script:LocationFile) { [IO.File]::Replace($temporary, $script:LocationFile, [NullString]::Value) } else { [IO.File]::Move($temporary, $script:LocationFile) }
      Ok "Recorded where OrangeSpeakEasy is: $(Pretty $script:LocationFile)"
    } catch {
      Fail "Couldn't write $(Pretty $script:LocationFile)" "OrangeSpeakEasy needs it to find $($script:HomeDir). Check that folder's permissions." "($($_.Exception.Message))"
    }
  }

  # ---------- 入口 ----------

  try {
    # irm | iex 时这些记在用户窗口的全局作用域里：同一个窗口再跑一次，不能接着用上一次的
    $script:VersionDir = $null; $script:Stopped = $false; $script:Switched = $false; $script:InstallLock = $null; $script:LockHeld = $false
    $script:PreviousName = ''; $script:InPlace = $false; $script:KeepVersionDir = $false; $script:PreviousHome = $null
    $script:Base = if ($env:ORANGESPEAKEASY_INSTALL_BASE) { $env:ORANGESPEAKEASY_INSTALL_BASE.TrimEnd('/', '\') } else { $DownloadUrl }
    # 本机的一个目录也可以当下载地址
    $script:LocalBase = $script:Base -notmatch '^[a-z]+://'

    Write-Host ""
    Write-Host "  OrangeSpeakEasy installer"
    # 和 src/storage/location.mjs 的 locationFileOf 是同一个位置（test/storage/location-everywhere.test.mjs 核对）
    $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
    $script:LocationFile = Join-Path $local 'OrangeSpeakEasy\location.json'
    $script:DefaultHome = Join-Path $env:USERPROFILE '.orangespeakeasy'
    # 装到哪：这一次指定了目录（ORANGESPEAKEASY_HOME）就用它；第一次安装选了文件夹（ORANGESPEAKEASY_INSTALL_DIR）就装进它里面；
    # 否则照定位文件（装在别处、搬过的在那里），都没有是默认位置
    if ($env:ORANGESPEAKEASY_HOME -and $env:ORANGESPEAKEASY_INSTALL_DIR) { Fail "Set ORANGESPEAKEASY_INSTALL_DIR or ORANGESPEAKEASY_HOME, not both" }
    if ($env:ORANGESPEAKEASY_HOME) {
      if ($env:ORANGESPEAKEASY_HOME -notmatch '^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+') { Fail "ORANGESPEAKEASY_HOME must be a full path like D:\OrangeSpeakEasy, not $($env:ORANGESPEAKEASY_HOME)" }
      $script:HomeDir = Get-FullHome $env:ORANGESPEAKEASY_HOME; $script:HomeFrom = 'env'
    } else {
      $located = Read-Location
      if ($env:ORANGESPEAKEASY_INSTALL_DIR) {
        $script:HomeDir = Resolve-InstallDir $located; $script:HomeFrom = 'chosen'
      } elseif ($located) {
        $script:HomeDir = $located; $script:HomeFrom = 'location'
      } else {
        $script:HomeDir = $script:DefaultHome; $script:HomeFrom = 'default'
      }
    }
    if ($env:ORANGESPEAKEASY_PREVIOUS_HOME) {
      if ($script:HomeFrom -ne 'env' -or $env:ORANGESPEAKEASY_INSTALL_FROM) {
        Fail "ORANGESPEAKEASY_PREVIOUS_HOME goes with ORANGESPEAKEASY_HOME (where OrangeSpeakEasy was copied to), not with ORANGESPEAKEASY_INSTALL_FROM"
      }
      $script:PreviousHome = Get-FullHome $env:ORANGESPEAKEASY_PREVIOUS_HOME
    }
    # 第一次安装（没有定位文件、默认位置还空着）、在 PowerShell 窗口里运行（不是脚本、安装程序调的）：先问一句装在哪
    $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and $Host.Name -eq 'ConsoleHost'
    if ($script:HomeFrom -eq 'default' -and $interactive -and -not $env:ORANGESPEAKEASY_INSTALL_FROM -and -not (Test-HasContents $script:HomeDir)) {
      Read-Place
    }
    # 不用 Join-Path：定位文件说的盘没接上时它直接报"找不到驱动器"，走不到 Test-Home 里"接上移动硬盘"的那句
    $script:VersionsDir = [IO.Path]::Combine($script:HomeDir, 'versions')
    $script:CurrentFile = [IO.Path]::Combine($script:HomeDir, 'current')
    Enter-Install

    Heading "Checks"
    Test-System
    # 先定版本再建目录：版本不对、问不到最新的，磁盘上什么都没动。从准备好的树装、换家时版本写在树里，不用问
    if (-not $env:ORANGESPEAKEASY_INSTALL_FROM -and -not $script:PreviousHome) { Resolve-Version }
    Test-Home

    Heading "Install"
    if ($script:PreviousHome) { Use-Copied } elseif ($env:ORANGESPEAKEASY_INSTALL_FROM) { Use-Tree } else { Get-Package }
    Use-Version
    Add-ToPath
    Add-Shortcut
    Update-ShortcutCopies
    Update-LoginItem
    Remove-Old
    # 明确选了位置的才动定位文件；ORANGESPEAKEASY_HOME 只管这一次（开发、测试装进临时目录，不能把正式的也指过去）
    if ($script:PreviousHome -or $script:HomeFrom -eq 'chosen') { Update-Location }
    # 装完了：下面启动的 orangespeakeasy 可能一直开着（问 key、前台跑），不占着锁
    Exit-Install

    Write-Host ""
    if ($script:PreviousHome) {
      Write-Host "  Moved OrangeSpeakEasy $($script:NewVersion) to $(Pretty $script:HomeDir)"
      Write-Host ""
      return
    } elseif ($script:InstalledVersion -and $script:InstalledVersion -ne $script:NewVersion) {
      Write-Host "  Upgraded: $($script:InstalledVersion) -> $($script:NewVersion)"
    } else {
      Write-Host "  Installed OrangeSpeakEasy $($script:NewVersion)"
    }
    Note "To remove it: orangespeakeasy uninstall deletes all of $(Pretty $script:HomeDir)."

    if ($env:ORANGESPEAKEASY_NO_START -ne '1' -and [Environment]::UserInteractive) {
      Write-Host ""
      & $script:Launcher
    } else {
      Write-Host ""
      Write-Host "  Run orangespeakeasy in a new terminal to start, or open OrangeSpeakEasy from the Start menu."
      Write-Host ""
    }
  } catch {
    $failure = $_
    # 还没切过去的话，解了一半（或者跑不起来）的新版本没人会用，删掉；现在删不掉的交给 Remove-Later。
    # 换家时用的是目录里本来就有的那一份，绝不删：换回去时它就是装着的那一份
    if (-not $script:Switched -and -not $script:KeepVersionDir -and $script:VersionDir -and (Test-Path -LiteralPath $script:VersionDir)) {
      Remove-Item -LiteralPath $script:VersionDir -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $script:VersionDir) {
        try { Remove-Later @() @($script:VersionDir) } catch { Note "Couldn't remove $(Pretty $script:VersionDir); it's safe to delete it yourself." }
      }
    }
    $message = $failure.Exception.Message
    if ($message.StartsWith('ORANGESPEAKEASY_INSTALL_FAILED')) {
      $lines = $message.Split("`n") | Select-Object -Skip 1 | Where-Object { $_ }
      Write-Host ""
      Write-Host "  x " -ForegroundColor Red -NoNewline
      Write-Host ($lines | Select-Object -First 1)
      $lines | Select-Object -Skip 1 | ForEach-Object { Write-Host "    $_" }
      Write-Host ""
      if (-not $script:Switched) { Write-Host "  Nothing was installed; what you had is untouched." }
    } else {
      Write-Host ""
      Write-Host "  x Something went wrong: $message" -ForegroundColor Red
      Write-Host "    $($failure.InvocationInfo.PositionMessage)"
      Write-Host "    Please open an issue at $RepoUrl/issues with the text above."
    }
    # 给调用的人（orangespeakeasy update）一个非零的结果，但不 exit：那会关掉用户的窗口
    $global:LASTEXITCODE = 1
  } finally {
    Exit-Install
  }
}
