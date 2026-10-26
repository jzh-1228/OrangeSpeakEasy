#!/bin/sh
# 截 Windows 开发机的整个主屏（在桌面会话里截，窗口边框、任务栏、悬浮条都在），拉回本机：
#
#   scripts/dev/win-screenshot.sh <本机的 .png 路径>
#
# 调试端口（CDP）只截得到网页里面；窗口的标题栏、系统画的按钮、通知区域的图标要这样看。
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
[ $# -eq 1 ] || { echo "用法：$0 <本机的 .png 路径>" >&2; exit 2; }
# shellcheck source=/dev/null
. "$root/.machine.env"
key="$(printf '%s' "$WIN_SSH_KEY" | sed "s|^~|$HOME|")"
WAIT=30 "$here/win-desktop.sh" - >/dev/null <<'PS'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# 物理像素：不声明的话按缩放换算过，截出来的是一部分
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[Dpi]::SetProcessDPIAware() | Out-Null
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save("$HOME\orangespeakeasy-dev\desktop\screen.png", [System.Drawing.Imaging.ImageFormat]::Png)
PS
scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$key" "$WIN_SSH_TARGET:orangespeakeasy-dev/desktop/screen.png" "$1"
echo "$1"
