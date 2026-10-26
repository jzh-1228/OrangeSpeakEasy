#!/bin/bash
# OrangeSpeakEasy 的安装脚本：检查环境、下载、校验、装进 OrangeSpeakEasy 的目录，然后启动。
#
#   curl -fsSL https://github.com/jzh-1228/OrangeSpeakEasy/releases/latest/download/install.sh | bash
#
# 所有东西都装在一个目录里（程序、运行环境，以及之后的设置、key、历史和录音），默认是 ~/.orangespeakeasy，可以装在别处。
# 目录以外只建一个指向命令的链接；装在默认位置以外时，另有一个记着目录在哪的定位文件
# ~/Library/Application Support/com.juzihai.orangespeakeasy/location.json（src/storage/location.mjs：从"应用程序"打开的 App、
# 下次安装都靠它找到目录）。不需要 Node、npm、Xcode，也不需要 sudo。
# 第一次安装、在终端里运行时，先说默认装在哪，回车就装在那里，也可以输入（或从访达拖进来）另一个文件夹。
# 已经装过的话再运行一次就是升级：程序换成新的，你的东西不动，装在哪照定位文件。卸载用 orangespeakeasy uninstall。
# 0.11.0 及以前装的（启动脚本里写死了路径）升级时一样处理：启动脚本换成新的。
# 这个脚本也随程序一起装进 app/ 里：orangespeakeasy update 拼好新版本后，用新版本自带的这一份把它换上（ORANGESPEAKEASY_INSTALL_FROM）；
# orangespeakeasy move 把整个目录拷到新位置后，用那里的这一份把命令的链接和定位文件改指过去（ORANGESPEAKEASY_PREVIOUS_HOME）。
#
# 可以用环境变量调整：
#   ORANGESPEAKEASY_INSTALL_DIR   装在哪个文件夹下（装进它里面的 .orangespeakeasy，记进定位文件）。只用于第一次安装；
#                           已经装在别处的，用 orangespeakeasy move 搬
#   ORANGESPEAKEASY_HOME          这一次用哪个目录，原样不改定位文件（开发、测试用；orangespeakeasy update 也这样告诉新版本装在哪）
#   ORANGESPEAKEASY_VERSION       装哪个版本，比如 v0.11.0（默认最新的；0.11.0 以前的包是 tar.gz，这个脚本不装；
#                           0.12.0 以前的只认默认位置，装在别处时不装）
#   ORANGESPEAKEASY_INSTALL_BASE  从哪下载：一个网址前缀，或者本机的一个目录（npm run release 打出来的 dist/release）
#   ORANGESPEAKEASY_BIN_DIR       命令的链接建在哪个目录（默认 ~/.local/bin）
#   ORANGESPEAKEASY_INSTALL_FROM  不下载，装一棵已经准备好的树（里面是 app/ 和 runtime/）：orangespeakeasy update 拼在家目录里
#                           .update- 开头的目录里，只认那里的
#   ORANGESPEAKEASY_PREVIOUS_HOME 换家：ORANGESPEAKEASY_HOME 里已经是从这个旧目录整个拷过来的一份（orangespeakeasy move 拷的）。
#                           不下载、不换程序，只试跑、重写启动脚本，把指着旧目录的命令链接、定位文件改指到这里
# 加 --no-start 只装不启动：curl … | bash -s -- --no-start
#
# 写法要能在 macOS 自带的 bash 3.2 上跑。全部逻辑都在函数里、最后一行才调用：
# 从管道里读脚本时，万一只下到一半，不会执行半截。

set -euo pipefail

REPO_URL="https://github.com/jzh-1228/OrangeSpeakEasy"
# 发布包放在这里。根上是这个脚本和 channel.json（最新的版本号在它的 version 里），每个版本的包在各自的目录里：
# <版本号>/orangespeakeasy-darwin-<芯片>.tar.xz 和同名的 .sha256（摆法见 src/update/layout.mjs）
DOWNLOAD_URL="https://github.com/jzh-1228/OrangeSpeakEasy/releases/latest/download"
# 能用的几家模型（名字和地址成对），整理文字要连其中一家。和 src/server/providers/index.mjs 里登记的一致
MODEL_HOSTS=("Gemini" "generativelanguage.googleapis.com" "OpenAI" "api.openai.com" "Bailian" "dashscope.aliyuncs.com")
MIN_MACOS_MAJOR=12
# 从这个版本起包是 tar.xz（摆法见 src/update/layout.mjs）；更早的只有 tar.gz，这个脚本不装它们。
# 0.10.0 及以前的 orangespeakeasy update 会下这个脚本、指定装 v0.10.1：到这里说清楚怎么办，而不是报"连不上"
MIN_VERSION="0.11.0"
# 从这个版本起才认得装在默认位置以外（定位文件），见 check_version_place
MIN_PLACE_VERSION="0.12.0"
# 下载的包约 95 MB，解开约 390 MB；升级时旧的要等新的放好才删
NEEDED_MB=1000
# macOS 上 Unix 套接字的路径最长 103 个字节，控制通道在 <目录>/run/control.sock
MAX_HOME_BYTES=86
# 读定位文件（JSON）：bash 读不了 JSON，交给系统自带的 osascript（JavaScript），每个版本的 macOS 都有。
# 不是 JSON、没有 home 这一项的交回空的，由 read_location 认作坏了
READ_LOCATION_JS='function run(argv) {
  ObjC.import("Foundation");
  const text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  if (text.isNil()) throw new Error("unreadable");
  try {
    const home = JSON.parse(text.js.replace(/^\uFEFF/, "")).home;
    return typeof home === "string" ? home : "";
  } catch (error) {
    return "";
  }
}'

TMP_DIR=""
# 新版本换上了没有：之后才出错的（只剩记下装在哪），不能再说"什么都没装"
SWAPPED=0
# 家目录是不是这一次建的：没装成时只删自己建的。本来就在的空目录（比如 App 第一次打开时选好、写进定位文件的）删了，
# App 和下次安装都会说找不到它
CREATED_HOME=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' BOLD=$'\033[1m' DIM=$'\033[2m' RESET=$'\033[0m'
else
  GREEN="" YELLOW="" RED="" BOLD="" DIM="" RESET=""
fi

heading() { printf '\n  %s%s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
# 说清楚哪里不行、怎么办，然后退出。新版本换上之前出错的什么都没动；换上之后才出错的照实说装好了什么。
# 换家是 orangespeakeasy move 调的，它接着会换回去：不说"装在新目录里、再运行一次"
fail() {
  printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2
  shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
  if [ "$SWAPPED" = 1 ] && [ -n "${PREVIOUS_HOME:-}" ]; then
    printf "\n  Switching OrangeSpeakEasy to %s didn't finish.\n" "$(pretty "$HOME_DIR")" >&2
  elif [ "$SWAPPED" = 1 ]; then
    printf '\n  OrangeSpeakEasy %s is in %s; fix the above and run this again.\n' "$NEW_VERSION" "$(pretty "$HOME_DIR")" >&2
  else
    printf '\n  Nothing was installed; what you had is untouched.\n' >&2
  fi
  exit 1
}

# 给人看的路径：家目录写成 ~
pretty() { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }
# 给人照抄去敲的路径：只有寻常字符时同 pretty，否则整个放进单引号（里面的 ' 写成 '\''），带空格的照抄也是一个参数。
# 用 sed 换引号：${var//…} 里引号、反斜杠怎么算，各版本的 bash 不一样
shell_path() {
  case "$1" in
    *[!A-Za-z0-9_./-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) pretty "$1" ;;
  esac
}
# 目录的真实路径（经过的符号链接都解开）；现在不在的原样交回
real_dir() { (CDPATH="" cd -- "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
# 默认位置，写成真实路径（和规范过的 HOME_DIR 比）
default_home() { printf '%s/.orangespeakeasy' "$(real_dir "$HOME")"; }
# 把一段文字写成 JSON 的字符串：路径里的 \ 和 " 转义。控制字符在 check_home 就挡掉了
json_string() {
  local text=$1
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  printf '"%s"' "$text"
}
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }
cleanup() {
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
  # 什么都没装成的话，不留下这一次建的空目录（里面有东西时这一句删不掉它，正好）
  [ "$CREATED_HOME" = 0 ] || rmdir "${HOME_DIR:-}" 2>/dev/null || true
}

# ---------- 预检查 ----------

check_system() {
  [ "$(uname -s)" = "Darwin" ] ||
    fail "OrangeSpeakEasy only supports macOS for now" "Listening for the hotkey and pasting rely on macOS system APIs. This machine runs $(uname -s)."

  [ "$(id -u)" -ne 0 ] ||
    fail "Don't run this with sudo or as root" "OrangeSpeakEasy installs into your home folder and doesn't need admin rights. Run it again without sudo."

  local version major
  version="$(sw_vers -productVersion)"
  major="${version%%.*}"
  [ "$major" -ge "$MIN_MACOS_MAJOR" ] 2>/dev/null ||
    fail "macOS $version is too old" "OrangeSpeakEasy needs macOS $MIN_MACOS_MAJOR or newer."
  ok "macOS $version"

  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    x86_64)
      # Apple 芯片上从 Rosetta 转译的终端里运行时，报的是 x86_64
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then ARCH="arm64"; else ARCH="x64"; fi
      ;;
    *) fail "Unknown chip: $(uname -m)" "OrangeSpeakEasy is built for Apple silicon (arm64) and Intel (x86_64)." ;;
  esac
  if [ "$ARCH" = "arm64" ]; then ok "Apple silicon"; else ok "Intel"; fi

  local tool missing=""
  for tool in curl tar shasum mktemp awk sed df; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  [ -z "$missing" ] || fail "Missing built-in tools:$missing" "They come with macOS. Check whether your PATH was changed."
  ok "System tools found"
}

# 定位文件说的家目录（没有这个文件时是空的），放进 LOCATION_HOME。读坏了就停：不悄悄装到默认位置去，
# 那样数据还在原处、看着却像丢了。不在子 shell 里调：fail 要能让整个脚本停下
read_location() {
  LOCATION_HOME=""
  [ -e "$LOCATION_FILE" ] || return 0
  local home
  home="$(osascript -l JavaScript -e "$READ_LOCATION_JS" "$LOCATION_FILE" 2>/dev/null)" ||
    fail "Can't read OrangeSpeakEasy's location file: $(pretty "$LOCATION_FILE")" "Check its permissions."
  case "$home" in
    /*) ;;
    *) fail "OrangeSpeakEasy's location file is invalid: $(pretty "$LOCATION_FILE")" \
      "It should hold the full path of the OrangeSpeakEasy folder. Delete it to use the default place ($(pretty "$HOME/.orangespeakeasy"))." ;;
  esac
  LOCATION_HOME="$home"
}

# 这个目录里有没有东西（装过、用过）
has_contents() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

# 这个目录 OrangeSpeakEasy 用过（重装系统前放在移动硬盘上的那种）：选到它时沿用里面的东西
used_before() {
  local name
  for name in settings.json data models app; do [ -e "$1/$name" ] && return 0; done
  return 1
}

# 这个文件夹所在的那块盘是什么格式（apfs、hfs、exfat、msdos…），看不出来是空的
filesystem_of() {
  local point
  point="$(df -P "$1" 2>/dev/null | awk 'NR == 2 { for (i = 6; i <= NF; i++) printf "%s%s", $i, (i < NF ? " " : "") }')"
  [ -n "$point" ] || return 0
  # 读完 mount 说的再交出第一个对上的：找到就退出的话，盘多、mount 说得比管道装得下的还多时它会被 SIGPIPE 结束，
  # pipefail 把这当成失败，整个脚本一声不吭地停掉
  mount | awk -v on=" on $point (" 'found == "" && index($0, on) { found = substr($0, index($0, on) + length(on)); sub(/[,)].*/, "", found) }
    END { if (found != "") print found }'
}

# 选的文件夹能不能装（第一次安装时问到的、ORANGESPEAKEASY_INSTALL_DIR 给的）。能装的话 PLACE_HOME 是要装进的目录
# （文件夹里的 .orangespeakeasy；选的本身就叫 .orangespeakeasy 就是它），不能的话 PLACE_PROBLEM 说为什么。不在子 shell 里调
check_place() {
  local folder=$1 home bytes fs
  PLACE_HOME="" PLACE_PROBLEM=""
  case "$folder" in /*) ;; *) PLACE_PROBLEM="Use a full path, like /Volumes/Data" && return ;; esac
  [ -d "$folder" ] || { PLACE_PROBLEM="No such folder: $folder (create it first, or pick another one)" && return; }
  folder="$(CDPATH="" cd -- "$folder" 2>/dev/null && pwd -P)" || { PLACE_PROBLEM="Can't open $1" && return; }
  case "$folder" in */.orangespeakeasy) home="$folder" ;; *) home="${folder%/}/.orangespeakeasy" ;; esac
  if has_contents "$home" && ! used_before "$home"; then
    PLACE_PROBLEM="$(pretty "$home") already has other things in it; pick another folder" && return
  fi
  bytes="$(printf '%s' "$home" | wc -c | tr -d ' ')"
  [ "$bytes" -le "$MAX_HOME_BYTES" ] ||
    { PLACE_PROBLEM="That path is too long ($bytes bytes, at most $MAX_HOME_BYTES); pick a shorter place" && return; }
  [ -w "$folder" ] || [ -w "$home" ] || { PLACE_PROBLEM="Can't write to $(pretty "$folder")" && return; }
  # 控制通道是一个 Unix 套接字、运行环境里有符号链接：exFAT、FAT32（U 盘、移动硬盘常见）、网络盘上都建不了
  fs="$(filesystem_of "$folder")"
  case "$fs" in
    apfs | hfs | "") ;;
    *)
      case "$fs" in exfat) fs=exFAT ;; msdos) fs=FAT32 ;; ntfs) fs=NTFS ;; smbfs | afpfs | nfs | webdav) fs="a network share" ;; esac
      PLACE_PROBLEM="$(pretty "$folder") is on a disk formatted as $fs; OrangeSpeakEasy needs APFS or Mac OS Extended" && return
      ;;
  esac
  PLACE_HOME="$home"
}

# 指定了装在哪个文件夹下（ORANGESPEAKEASY_INSTALL_DIR）：只用于第一次安装。别处已经有一份的话停下，
# 不然会多出一个空的目录，"应用程序"里的 App 跟着定位文件换过去，看着像数据丢了。已经装了的用 orangespeakeasy move 搬。
# 定位文件记着别处就算装过，那里现在不在、是空的也一样：移动硬盘没接时看着不在，数据其实都在上面；默认位置用过才算
check_install_dir() {
  check_place "$ORANGESPEAKEASY_INSTALL_DIR"
  [ -z "$PLACE_PROBLEM" ] || fail "Can't install into ORANGESPEAKEASY_INSTALL_DIR: $PLACE_PROBLEM"
  HOME_DIR="$PLACE_HOME"
  if [ -n "$LOCATION_HOME" ] && [ "$(real_dir "$LOCATION_HOME")" != "$HOME_DIR" ]; then
    [ -d "$LOCATION_HOME" ] ||
      fail "Can't find the OrangeSpeakEasy folder: $(pretty "$LOCATION_HOME")" \
        "OrangeSpeakEasy is set up there. If it's on an external drive, connect the drive and run this again." \
        "If you no longer use that place, delete $(pretty "$LOCATION_FILE") first."
    set_up_elsewhere "$LOCATION_HOME"
  fi
  if has_contents "$HOME/.orangespeakeasy" && [ "$(real_dir "$HOME/.orangespeakeasy")" != "$HOME_DIR" ]; then
    set_up_elsewhere "$HOME/.orangespeakeasy"
  fi
}

# 已经装在别处：停下，说怎么接着用那一处、怎么搬过来
set_up_elsewhere() {
  fail "OrangeSpeakEasy is already set up in $(pretty "$1")" \
    "To keep using it there, run this again without ORANGESPEAKEASY_INSTALL_DIR." \
    "To move it to $(pretty "$HOME_DIR"), run: orangespeakeasy move $(shell_path "${HOME_DIR%/.orangespeakeasy}")"
}

# 第一次安装、在终端里时问一句装在哪：回车是默认位置，也可以输入或从访达拖进来一个文件夹（拖进来的路径空格前带 \，
# read 不加 -r 正好去掉）。选了别处就和 ORANGESPEAKEASY_INSTALL_DIR 一样：装进它里面的 .orangespeakeasy、记进定位文件
ask_place() {
  local answer
  heading "Where to install"
  note "OrangeSpeakEasy keeps everything in one folder: the program, on-device models (0.2-1.6 GB each),"
  note "and your settings, history and recordings. You can move it later with: orangespeakeasy move"
  printf '  Press Enter to use %s%s%s, or type a folder (or drag one here from Finder)
' "$BOLD" "$(pretty "$HOME_DIR")" "$RESET"
  printf '  to install into .orangespeakeasy inside it.
'
  while :; do
    answer=""
    read -e -p "  Folder: " answer </dev/tty || answer=""
    # 复制来的路径常带引号
    case "$answer" in \"*\") answer="${answer#\"}" answer="${answer%\"}" ;; \'*\') answer="${answer#\'}" answer="${answer%\'}" ;; esac
    case "$answer" in "~") answer="$HOME" ;; "~/"*) answer="$HOME/${answer#"~/"}" ;; esac
    [ -n "$answer" ] || return 0
    check_place "$answer"
    if [ -n "$PLACE_PROBLEM" ]; then
      warn "$PLACE_PROBLEM"
      continue
    fi
    [ "$PLACE_HOME" = "$(default_home)" ] && return 0
    HOME_DIR="$PLACE_HOME" HOME_FROM=chosen
    used_before "$HOME_DIR" && note "Found OrangeSpeakEasy data there; it will be used as it is."
    return 0
  done
}

check_home() {
  local bytes
  case "$HOME_DIR" in /*) ;; *) fail "ORANGESPEAKEASY_HOME must be an absolute path, not $HOME_DIR" ;; esac
  case "$HOME_DIR" in *[[:cntrl:]]*) fail "The install path has a line break or another control character in it" ;; esac
  # 定位文件说装在一个现在不在的地方（移动硬盘没接、盘被换了）：不在那里新建一个空的，也不改装到默认位置
  if [ "$HOME_FROM" = location ] && [ ! -d "$HOME_DIR" ]; then
    fail "Can't find the OrangeSpeakEasy folder: $(pretty "$HOME_DIR")" \
      "If it's on an external drive, connect the drive and run this again." \
      "If you no longer use that place, delete $(pretty "$LOCATION_FILE") to install to the default one."
  fi

  [ -d "$HOME_DIR" ] || CREATED_HOME=1
  mkdir -p "$HOME_DIR" 2>/dev/null && [ -w "$HOME_DIR" ] ||
    fail "Can't create or write to $(pretty "$HOME_DIR")" "Check its permissions, or install somewhere else with ORANGESPEAKEASY_INSTALL_DIR."
  # 规范成真实的完整路径（a//b、末尾的 /、..、符号链接都解开）：写进链接、定位文件的和程序算出来的是同一个字符串
  HOME_DIR="$(CDPATH="" cd -- "$HOME_DIR" && pwd -P)" || fail "Can't open $HOME_DIR"
  bytes="$(printf '%s' "$HOME_DIR" | wc -c | tr -d ' ')"
  [ "$bytes" -le "$MAX_HOME_BYTES" ] ||
    fail "Install path is too long: $HOME_DIR" "Pick a shorter place (at most $MAX_HOME_BYTES bytes) and run again."
  # 里面会有录音和 key，只让自己进得去
  chmod 700 "$HOME_DIR"

  if [ -n "$PREVIOUS_HOME" ]; then
    # 换家：程序已经整个拷过来了，不再占新的地方
    [ -f "$HOME_DIR/app/bin/orangespeakeasy.mjs" ] || fail "$(pretty "$HOME_DIR") has no copy of OrangeSpeakEasy to move to"
    ok "Moving to $(pretty "$HOME_DIR")"
  elif [ -n "${ORANGESPEAKEASY_INSTALL_FROM:-}" ]; then
    # 从拼好的树装只是改名换上，不再占新的地方（拼的时候已经占过了）
    ok "Installing to $(pretty "$HOME_DIR")"
  else
    local free_mb
    free_mb="$(df -Pk "$HOME_DIR" | awk 'NR == 2 { printf "%d", $4 / 1024 }')"
    [ "$free_mb" -ge "$NEEDED_MB" ] 2>/dev/null ||
      fail "Not enough disk space: ${free_mb} MB free" "About ${NEEDED_MB} MB is needed. Free up some space and run again."
    ok "Installing to $(pretty "$HOME_DIR") ($((free_mb / 1024)) GB free)"
  fi

  INSTALLED_VERSION=""
  if [ -f "$HOME_DIR/app/package.json" ]; then
    INSTALLED_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HOME_DIR/app/package.json" | head -1)"
    ok "Found ${INSTALLED_VERSION:-an earlier version}: replacing it; settings, keys, history and recordings stay"
  fi
}

# 定下装哪个版本：指定了就用指定的，没指定就问下载地址最新的是哪个（channel.json 里的 version）
resolve_version() {
  local version="${ORANGESPEAKEASY_VERSION:-}"
  if [ -n "$version" ]; then
    case "$version" in v*) ;; *) version="v$version" ;; esac
  else
    version="$(curl -fsSL --max-time 20 "$DOWNLOAD_BASE/channel.json" 2>/dev/null |
      sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' | head -n 1)" || version=""
    [ -n "$version" ] || fail "Couldn't find the latest version" "URL: $DOWNLOAD_BASE/channel.json" "Check your network and try again in a bit."
    version="v$version"
  fi
  # 版本号要拼进下载地址：不像版本号的不往下走（比如问到的其实是一个报错的网页）
  if ! [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$ ]]; then
    [ -n "${ORANGESPEAKEASY_VERSION:-}" ] && fail "ORANGESPEAKEASY_VERSION doesn't look like a version: $ORANGESPEAKEASY_VERSION" "Write it like v0.2.0."
    fail "The download server returned a bad version number" "URL: $DOWNLOAD_BASE/channel.json" "Try again in a bit. If it keeps happening, please open an issue at $REPO_URL/issues."
  fi
  if older_than "${version#v}" "$MIN_VERSION"; then
    fail "This installer can't install $version" "Versions before v$MIN_VERSION are packaged differently." \
      "Run it again without ORANGESPEAKEASY_VERSION to install the latest, or download that version's installer:" \
      "$DOWNLOAD_BASE/$version/OrangeSpeakEasy-$ARCH.dmg"
  fi
  check_version_place "$version"
  BASE_URL="$DOWNLOAD_BASE/$version"
}

# 0.12.0 以前的版本只认默认位置：不读定位文件，卸载时也不删它，留下的定位文件指着删掉的目录，新版的 App 就打不开了。
# 所以装到别处（选的、定位文件记着的）只装 0.12.0 起的。默认位置、ORANGESPEAKEASY_HOME（只管这一次、不碰定位文件）不拦
check_version_place() {
  local default
  case "$HOME_FROM" in chosen | location) ;; *) return 0 ;; esac
  default="$(default_home)"
  [ "$(real_dir "$HOME_DIR")" != "$default" ] && older_than "${1#v}" "$MIN_PLACE_VERSION" || return 0
  local hint="Install it in the default place instead, or pick v$MIN_PLACE_VERSION or later."
  [ "$HOME_FROM" = location ] && hint="OrangeSpeakEasy is in $(pretty "$HOME_DIR") now; move it back first with: orangespeakeasy move ~"
  fail "OrangeSpeakEasy $1 can only be installed in $(pretty "$default")" "Versions before v$MIN_PLACE_VERSION only work in that place." "$hint"
}

# 两个 x.y.z 比大小（不管预发版的后缀）：$1 比 $2 旧时成立
older_than() {
  local IFS=. i
  local -a a b
  read -r -a a <<<"${1%%[-+]*}"
  read -r -a b <<<"${2%%[-+]*}"
  for i in 0 1 2; do
    [ "${a[i]:-0}" -lt "${b[i]:-0}" ] && return 0
    [ "${a[i]:-0}" -gt "${b[i]:-0}" ] && return 1
  done
  return 1
}

check_network() {
  resolve_version
  # 顺带确认了这个版本、这种芯片的发布包确实存在
  curl -fsSL --max-time 20 -o /dev/null "$BASE_URL/$ARCHIVE.sha256" 2>/dev/null ||
    fail "Couldn't reach the release package" \
      "URL: $BASE_URL/$ARCHIVE" \
      "Check your network. If you set ORANGESPEAKEASY_VERSION, make sure that version exists."
  ok "Download server reachable"

  # 装得上不等于用得了：整理文字要连用的那一家，装的时候还不知道用哪家，所以都查。连不上只提醒，不拦着
  local i unreachable=0
  for ((i = 0; i < ${#MODEL_HOSTS[@]}; i += 2)); do
    if curl -s --max-time 8 -o /dev/null "https://${MODEL_HOSTS[i + 1]}/" 2>/dev/null; then
      ok "${MODEL_HOSTS[i]} reachable"
    else
      warn "Can't reach ${MODEL_HOSTS[i]} right now (${MODEL_HOSTS[i + 1]})"
      unreachable=1
    fi
  done
  if [ "$unreachable" = 1 ]; then
    note "Installing still works. You need to reach the provider you use; if you need a proxy, set it in the terminal that starts orangespeakeasy."
  fi
}

# ---------- 安装 ----------

download() {
  TMP_DIR="$(mktemp -d "$HOME_DIR/.install.XXXXXX")"
  local progress="-sS"
  [ -t 2 ] && progress="--progress-bar"
  curl -fL "$progress" -o "$TMP_DIR/$ARCHIVE" "$BASE_URL/$ARCHIVE" ||
    fail "Download interrupted" "Run it again. URL: $BASE_URL/$ARCHIVE"
  curl -fsSL -o "$TMP_DIR/$ARCHIVE.sha256" "$BASE_URL/$ARCHIVE.sha256" || fail "Couldn't download the checksum" "Run it again."
  ok "Downloaded"

  local expected actual
  expected="$(awk '{ print $1; exit }' "$TMP_DIR/$ARCHIVE.sha256")"
  # 从标准输入读：路径里有 \ 时 shasum 会在结果前面加一个 \，就永远对不上了
  actual="$(shasum -a 256 <"$TMP_DIR/$ARCHIVE" | awk '{ print $1 }')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] ||
    fail "Checksum mismatch: the download differs from the release" "It was probably damaged on the way. Run it again." "Expected $expected" "Got      $actual"
  ok "Checksum OK"

  tar -xJf "$TMP_DIR/$ARCHIVE" -C "$TMP_DIR" || fail "Couldn't unpack the package" "Run it again."
  NEW_DIR="$TMP_DIR"
  try_new "Unpacked"
}

# 从一棵已经准备好的树装（ORANGESPEAKEASY_INSTALL_FROM）：只认直接放在家目录里、.update- 开头的目录，和要换上的在同一块盘上，改名就换上。
# 两边都先解析成真实路径再比：家目录可能写成 a//b、末尾带 /，或者经过符号链接（/tmp 其实是 /private/tmp），
# 而 orangespeakeasy update 交来的是规范化过的；也挡住 .update-x/../.. 这种绕出去的（失败时这个目录会被整个删掉）
use_tree() {
  [ -d "$ORANGESPEAKEASY_INSTALL_FROM" ] || fail "No such folder: $ORANGESPEAKEASY_INSTALL_FROM"
  local from home
  from="$(CDPATH="" cd -- "$ORANGESPEAKEASY_INSTALL_FROM" && pwd -P)" || fail "Can't open $ORANGESPEAKEASY_INSTALL_FROM"
  home="$(CDPATH="" cd -- "$HOME_DIR" && pwd -P)" || fail "Can't open $(pretty "$HOME_DIR")"
  case "$(basename "$from")" in .update-*) ;; *) from="" ;; esac
  [ -n "$from" ] && [ "$(dirname "$from")" = "$home" ] ||
    fail "ORANGESPEAKEASY_INSTALL_FROM must be a .update- folder inside $(pretty "$HOME_DIR")" "Got $ORANGESPEAKEASY_INSTALL_FROM"
  TMP_DIR="$from"
  NEW_DIR="$from"
  try_new "Prepared"
}

# 换家：用拷到新目录里的那一份（不进 TMP_DIR：出错时 TMP_DIR 会被整个删掉，这里是用户的整个目录）
use_copied() {
  NEW_DIR="$HOME_DIR"
  try_new "Copied"
}

# 换掉旧的之前先在原地跑一下：这台机器上跑不起来的话现在就知道，不至于换完才发现。
# 换家时跑的是拷过去的那一份：新位置的盘不认符号链接、不让执行（有的移动硬盘是这样）的话，在这里就发现
try_new() {
  NEW_ELECTRON="$NEW_DIR/runtime/Electron.app/Contents/MacOS/Electron"
  [ -f "$NEW_DIR/app/bin/orangespeakeasy.mjs" ] && [ -x "$NEW_ELECTRON" ] || fail "The package is incomplete" "That's a problem with the release. Please open an issue at $REPO_URL/issues."
  NEW_VERSION="$(run_new --version 2>/dev/null)" ||
    fail "The new copy of OrangeSpeakEasy won't run on this Mac" "Please open an issue at $REPO_URL/issues with your macOS version and chip."
  ok "$1 OrangeSpeakEasy $NEW_VERSION"
}

# 用新的那一份程序跑一条命令
run_new() {
  ORANGESPEAKEASY_HOME="$HOME_DIR" ELECTRON_RUN_AS_NODE=1 "$NEW_ELECTRON" "$NEW_DIR/app/bin/orangespeakeasy.mjs" "$@"
}

# 把程序和运行环境换成刚下到的。两样要么都换成，要么都不换：中途出错就把原来的放回去
swap_in() {
  local name
  for name in app runtime; do
    rm -rf "$HOME_DIR/$name.old"
    if [ -e "$HOME_DIR/$name" ] && ! mv "$HOME_DIR/$name" "$HOME_DIR/$name.old"; then
      # app 已经挪开、runtime 挪不动：把 app 放回去，不然 orangespeakeasy 命令就坏了
      put_back
      fail "Can't move $(pretty "$HOME_DIR/$name")" "Check the folder's permissions."
    fi
  done
  if mv "$TMP_DIR/app" "$HOME_DIR/app" && mv "$TMP_DIR/runtime" "$HOME_DIR/runtime"; then
    rm -rf "$HOME_DIR/app.old" "$HOME_DIR/runtime.old"
    return
  fi
  put_back
  fail "Couldn't put the new version into $(pretty "$HOME_DIR")" "Check the folder's permissions. OrangeSpeakEasy was stopped; run orangespeakeasy to start it again."
}

# 把挪开的旧版放回原处（换到一半出错时）
put_back() {
  local name
  for name in app runtime; do
    [ -e "$HOME_DIR/$name.old" ] || continue
    rm -rf "$HOME_DIR/$name"
    mv "$HOME_DIR/$name.old" "$HOME_DIR/$name"
  done
}

install_files() {
  # 正在运行的要先停：它开着旧程序的文件。用新的这份去停，新旧版本的后台应用它都认。
  # 0.1 版把数据放在别处，有的话这一步会顺带搬过来。
  # 下面靠它说的话判断停没停、搬没搬，命令行又按终端的语言说话：让它说英文，和这个脚本一致
  local output
  output="$(ORANGESPEAKEASY_LANGUAGE=en run_new stop 2>&1)" || fail "Couldn't stop the running OrangeSpeakEasy" "$output" "Quit it first, then install again."
  case "$output" in *"Moved the old version's data"*) ok "$(printf '%s\n' "$output" | grep "Moved the old version's data" | head -1)" ;; esac
  case "$output" in *"OrangeSpeakEasy stopped."* | *"force-quit"*) ok "Stopped the running OrangeSpeakEasy" ;; esac

  # 换家时程序已经在新目录里了（整个拷过来的），不用换
  [ -n "$PREVIOUS_HOME" ] || swap_in
  SWAPPED=1

  mkdir -p "$HOME_DIR/bin"
  LAUNCHER="$HOME_DIR/bin/orangespeakeasy"
  # 启动脚本里不写任何路径：顺着指向它的链接找到自己真正在哪，它的上一级就是家目录。整个目录搬到别处照样能用。
  # 家目录总是它自己所在的那个，不沿用外面传进来的 ORANGESPEAKEASY_HOME：程序和数据永远是同一个目录里的，
  # 搬家后环境里残留的旧位置也带不偏。0.11.0 及以前的启动脚本把路径写死在里面，升级时换成这一份
  cat >"$LAUNCHER" <<'EOF'
#!/bin/sh
# The orangespeakeasy command, generated by the OrangeSpeakEasy installer.
# Runs on the bundled Electron as Node, so Node doesn't need to be installed.
# Finds its folder from where this file really is (following links to it), so the folder can be moved.
self="$0"
while [ -L "$self" ]; do
  target="$(readlink "$self")"
  case "$target" in /*) self="$target" ;; *) self="$(dirname "$self")/$target" ;; esac
done
ORANGESPEAKEASY_HOME="$(CDPATH='' cd -- "$(dirname "$self")/.." && pwd)" || exit 1
if [ ! -f "$ORANGESPEAKEASY_HOME/app/bin/orangespeakeasy.mjs" ]; then
  echo "orangespeakeasy: this command must stay in OrangeSpeakEasy's bin folder; link to it instead of copying it ($self)" >&2
  exit 1
fi
export ORANGESPEAKEASY_HOME
ELECTRON_RUN_AS_NODE=1 exec "$ORANGESPEAKEASY_HOME/runtime/Electron.app/Contents/MacOS/Electron" "$ORANGESPEAKEASY_HOME/app/bin/orangespeakeasy.mjs" "$@"
EOF
  chmod 755 "$LAUNCHER"
  if [ -n "$PREVIOUS_HOME" ]; then ok "Moved to $(pretty "$HOME_DIR")"; else ok "Installed to $(pretty "$HOME_DIR")"; fi
}

# 换家：links 里记着的、指着旧目录那条命令的链接，改指到这里的启动脚本。已经指着这里的不动：换回去、启动时收拾
# 半路断掉的搬家时多半就是这样，而它所在的目录可能改不了（老的 /usr/local/bin、ORANGESPEAKEASY_BIN_DIR 指的），
# 去改反而出错，每次启动都收拾不完。指着旧目录的改不了就停下：旧目录随后会被删（换回去时是拷了一半的那份），留着它命令就坏了。
# 比真实路径：记下链接时的家目录可能写法不规整，或者经过符号链接
relink_moved() {
  local file="$HOME_DIR/bin/links" link target dir old new
  [ -f "$file" ] || return 0
  old="$(CDPATH="" cd -- "$PREVIOUS_HOME/bin" 2>/dev/null && pwd -P)" || old=""
  new="$(CDPATH="" cd -- "$HOME_DIR/bin" && pwd -P)"
  while IFS= read -r link || [ -n "$link" ]; do
    [ -n "$link" ] && [ -L "$link" ] || continue
    target="$(readlink "$link")"
    case "$target" in /*) ;; *) target="$(dirname "$link")/$target" ;; esac
    dir="$(CDPATH="" cd -- "$(dirname "$target")" 2>/dev/null && pwd -P)" || dir=""
    [ "$(basename "$target")" = orangespeakeasy ] && [ -n "$dir" ] || continue
    if [ "$dir" = "$old" ]; then
      ln -sfn "$LAUNCHER" "$link" || fail "Couldn't update the link $(pretty "$link")" "Check that folder's permissions."
    elif [ "$dir" != "$new" ]; then
      continue
    fi
    ok "orangespeakeasy command: $(pretty "$link")"
  done <"$file"
}

# 记下 OrangeSpeakEasy 装在哪（定位文件）：只在明确选了位置时（ORANGESPEAKEASY_INSTALL_DIR、orangespeakeasy move 换家）。
# 在默认位置就不要定位文件（有指着这里的就删掉）；在别处就写，先写到旁边再改名换上，写到一半断电留下的也是旧的那份。
# 写不了就照实报错：不然从"应用程序"打开的 App、下次安装都找不到它
update_location() {
  local temporary="$LOCATION_FILE.$$.tmp"
  if [ "$HOME_DIR" = "$(default_home)" ]; then
    rm -f "$LOCATION_FILE" 2>/dev/null || fail "Couldn't remove $(pretty "$LOCATION_FILE")" "Check that folder's permissions."
    return
  fi
  if mkdir -p "$(dirname "$LOCATION_FILE")" 2>/dev/null &&
    printf '{\n  "home": %s\n}\n' "$(json_string "$HOME_DIR")" >"$temporary" 2>/dev/null &&
    mv -f "$temporary" "$LOCATION_FILE" 2>/dev/null; then
    ok "Recorded where OrangeSpeakEasy is: $(pretty "$LOCATION_FILE")"
    return
  fi
  rm -f "$temporary" 2>/dev/null || true
  fail "Couldn't write $(pretty "$LOCATION_FILE")" \
    "OrangeSpeakEasy needs it to find $(pretty "$HOME_DIR") when opened from Applications. Check that folder's permissions."
}

link_command() {
  local dir link
  if [ -n "${ORANGESPEAKEASY_BIN_DIR:-}" ]; then
    dir="$ORANGESPEAKEASY_BIN_DIR"
  elif on_path "$HOME/.local/bin"; then
    dir="$HOME/.local/bin"
  elif on_path /usr/local/bin && [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    dir="/usr/local/bin"
  else
    dir="$HOME/.local/bin"
  fi
  link="$dir/orangespeakeasy"

  # 那个位置上已经有一个不是链接的同名文件：不是我们放的，不动它
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    warn "$(pretty "$link") is another orangespeakeasy; left it alone"
    note "To use the new one, run: $(pretty "$LAUNCHER")"
    return
  fi
  mkdir -p "$dir"
  ln -sfn "$LAUNCHER" "$link"
  # 记下在家目录以外建了什么，卸载时照着删
  grep -qxF "$link" "$HOME_DIR/bin/links" 2>/dev/null || printf '%s\n' "$link" >>"$HOME_DIR/bin/links"
  ok "orangespeakeasy command: $(pretty "$link")"

  if ! on_path "$dir"; then
    local rc=".zshrc"
    case "${SHELL:-}" in */bash) rc=".bash_profile" ;; esac
    warn "$(pretty "$dir") isn't on your PATH, so new terminals won't find orangespeakeasy"
    note "Add it: echo 'export PATH=\"$dir:\$PATH\"' >> ~/$rc"
    note "Or use the full path: $(pretty "$LAUNCHER")"
    return
  fi
  # PATH 里排在前面的要是另一个 orangespeakeasy（比如从源码目录 npm link 的），敲命令时用到的会是它
  local found
  found="$(command -v orangespeakeasy 2>/dev/null || true)"
  if [ -n "$found" ] && [ "$found" != "$link" ]; then
    warn "Another orangespeakeasy comes first on your PATH: $(pretty "$found")"
    note "Typing orangespeakeasy runs that one. It's likely an old npm link; remove it with: npm unlink -g orangespeakeasy"
  fi
}

main() {
  local start="yes" arg
  for arg in "$@"; do
    case "$arg" in
      --no-start) start="no" ;;
      *) fail "Unknown option: $arg" "The only option is --no-start (install without starting)." ;;
    esac
  done

  # 和 src/storage/location.mjs 的 locationFileOf 是同一个位置（test/storage/location-everywhere.test.mjs 核对）
  LOCATION_FILE="$HOME/Library/Application Support/com.juzihai.orangespeakeasy/location.json"
  PREVIOUS_HOME="${ORANGESPEAKEASY_PREVIOUS_HOME:-}"
  DOWNLOAD_BASE="${ORANGESPEAKEASY_INSTALL_BASE:-$DOWNLOAD_URL}"
  # 本机的一个目录也可以当下载地址
  case "$DOWNLOAD_BASE" in /*) DOWNLOAD_BASE="file://$DOWNLOAD_BASE" ;; esac

  printf '\n  %sOrangeSpeakEasy installer%s\n' "$BOLD" "$RESET"
  trap cleanup EXIT

  # 装到哪：这一次指定了目录（ORANGESPEAKEASY_HOME）就用它；第一次安装选了文件夹（ORANGESPEAKEASY_INSTALL_DIR）就装进它里面；
  # 否则照定位文件（装在别处、搬过的在那里），都没有是默认位置
  [ -z "${ORANGESPEAKEASY_HOME:-}" ] || [ -z "${ORANGESPEAKEASY_INSTALL_DIR:-}" ] ||
    fail "Set ORANGESPEAKEASY_INSTALL_DIR or ORANGESPEAKEASY_HOME, not both"
  LOCATION_HOME=""
  if [ -n "${ORANGESPEAKEASY_HOME:-}" ]; then
    HOME_DIR="$ORANGESPEAKEASY_HOME" HOME_FROM=env
  else
    read_location
    if [ -n "${ORANGESPEAKEASY_INSTALL_DIR:-}" ]; then
      check_install_dir
      HOME_FROM=chosen
    elif [ -n "$LOCATION_HOME" ]; then
      HOME_DIR="$LOCATION_HOME" HOME_FROM=location
    else
      HOME_DIR="$HOME/.orangespeakeasy" HOME_FROM=default
    fi
  fi
  if [ -n "$PREVIOUS_HOME" ]; then
    [ "$HOME_FROM" = env ] && [ -z "${ORANGESPEAKEASY_INSTALL_FROM:-}" ] ||
      fail "ORANGESPEAKEASY_PREVIOUS_HOME goes with ORANGESPEAKEASY_HOME (where OrangeSpeakEasy was copied to), not with ORANGESPEAKEASY_INSTALL_FROM"
  fi

  # 第一次安装（没有定位文件、默认位置还空着）、在终端里运行：先问一句装在哪
  if [ "$HOME_FROM" = default ] && ! has_contents "$HOME_DIR" && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
    ask_place
  fi

  heading "Checks"
  check_system
  ARCHIVE="orangespeakeasy-darwin-$ARCH.tar.xz"
  check_home
  # 从准备好的树装（orangespeakeasy update）、换家（orangespeakeasy move）不用联网
  [ -n "${ORANGESPEAKEASY_INSTALL_FROM:-}" ] || [ -n "$PREVIOUS_HOME" ] || check_network

  heading "Install"
  if [ -n "$PREVIOUS_HOME" ]; then
    use_copied
  elif [ -n "${ORANGESPEAKEASY_INSTALL_FROM:-}" ]; then
    use_tree
  else
    download
  fi
  install_files
  # 换家时命令的链接还在原处，改指过来；另挑一处新建的话会多出一个
  if [ -n "$PREVIOUS_HOME" ]; then relink_moved; else link_command; fi
  # 明确选了位置的才动定位文件；ORANGESPEAKEASY_HOME 只管这一次（开发时装进临时目录，不能把正式的 App 也指过去）
  if [ -n "$PREVIOUS_HOME" ] || [ "$HOME_FROM" = chosen ]; then update_location; fi

  if [ -n "$PREVIOUS_HOME" ]; then
    printf '\n  %sMoved OrangeSpeakEasy %s to %s%s\n\n' "$BOLD" "$NEW_VERSION" "$(pretty "$HOME_DIR")" "$RESET"
    cleanup
    return
  elif [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" != "$NEW_VERSION" ]; then
    printf '\n  %sUpgraded: %s → %s%s\n' "$BOLD" "$INSTALLED_VERSION" "$NEW_VERSION" "$RESET"
  else
    printf '\n  %sInstalled OrangeSpeakEasy %s%s\n' "$BOLD" "$NEW_VERSION" "$RESET"
  fi
  note "To remove it: orangespeakeasy uninstall deletes all of $(pretty "$HOME_DIR")."

  cleanup
  TMP_DIR=""
  # 从管道里读脚本时标准输入不是终端，而问 key 要用键盘：接到终端上再启动
  if [ "$start" = "yes" ] && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
    printf '\n'
    exec "$LAUNCHER" </dev/tty
  fi
  printf '\n  Run orangespeakeasy to start.\n\n'
}

main "$@"
