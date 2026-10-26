package main

// 安装程序说的话：跟着 Windows 的显示语言，中文系统说中文，别的说英文（和 App 一样只有这两种）。
// 安装进度那几行是 install.ps1 打的，一直是英文

type words struct {
	title       string
	question    string // %s：默认位置
	installHere string
	choose      string
	cancel      string
	pickTitle   string
	again       string
	cancelled   string
	// 选的文件夹不能用的原因
	notFull    string
	missing    string
	tooLong    string // %d：最多几个字符
	notEmpty   string // %s：那个 .orangespeakeasy
	format     string // %s：磁盘格式
	unwritable string
	// 对话框弹不出来时在控制台里问
	consoleIntro  string
	consoleEnter  string // %s：默认位置
	consoleType   string
	consoleFolder string
}

var english = words{
	title:       "OrangeSpeakEasy Setup",
	question:    "Where should OrangeSpeakEasy be installed?\n\nThe app, on-device models (0.2–1.6 GB each), and your settings, history and recordings all go into one folder. By default it's:\n\n%s\n\nYou can move it later in Settings › General › Storage location.",
	installHere: "Install Here",
	choose:      "Choose…",
	cancel:      "Cancel",
	pickTitle:   "Choose where to install OrangeSpeakEasy (it goes into .orangespeakeasy inside the folder)",
	again:       "Choose Again",
	cancelled:   "Setup was cancelled; nothing was installed.",
	notFull:     "Choose a folder with a full path, like D:\\Apps.",
	missing:     "That folder doesn't exist. Create it first, or choose another one.",
	tooLong:     "That path is too long; choose a folder whose path is at most %d characters.",
	notEmpty:    "%s already has other things in it. Choose another folder.",
	format:      "That disk is formatted as %s. OrangeSpeakEasy needs an NTFS disk; USB sticks and external drives are often exFAT or FAT32.",
	unwritable:  "Can't write to that folder. Choose a folder of your own, like D:\\Apps.",

	consoleIntro:  "OrangeSpeakEasy keeps everything it installs and saves (the app, on-device models, history) in one folder.",
	consoleEnter:  "Press Enter to use %s,",
	consoleType:   "or type another folder to install into (for example D:\\Apps) and press Enter: ",
	consoleFolder: "Folder (or press Enter for the default): ",
}

var chinese = words{
	title:       "OrangeSpeakEasy 安装程序",
	question:    "OrangeSpeakEasy 安装到哪里？\n\n程序、本机模型（每个约 0.2–1.6 GB）、设置、历史和录音都保存在同一个文件夹中。默认位置：\n\n%s\n\n以后也可在 设置 › 通用 › 存储位置 中更改。",
	installHere: "安装到这里",
	choose:      "选择其他位置…",
	cancel:      "取消",
	pickTitle:   "选择安装位置（会装进所选文件夹中的 .orangespeakeasy）",
	again:       "重新选择",
	cancelled:   "已取消安装，没有装任何东西。",
	notFull:     "请选择带完整路径的文件夹，比如 D:\\Apps。",
	missing:     "这个文件夹不存在。请先建好它，或选择其他文件夹。",
	tooLong:     "路径太长了，请选择路径不超过 %d 个字符的文件夹。",
	notEmpty:    "%s 里已经有其他文件，请选择其他文件夹。",
	format:      "这块磁盘是 %s 格式。OrangeSpeakEasy 需要 NTFS 格式的磁盘；U 盘、移动硬盘常是 exFAT 或 FAT32。",
	unwritable:  "无法写入这个文件夹。请选择自己的文件夹，比如 D:\\Apps。",

	consoleIntro:  "OrangeSpeakEasy 的程序、本机模型、设置和历史都保存在同一个文件夹中。",
	consoleEnter:  "直接按回车安装到 %s，",
	consoleType:   "或输入其他文件夹（比如 D:\\Apps）再按回车：",
	consoleFolder: "文件夹（直接回车用默认位置）：",
}

// wordsFor Windows 显示语言的 LANGID：主语言是中文（0x04）的说中文
func wordsFor(langID uint16) words {
	if langID&0x3ff == 0x04 {
		return chinese
	}
	return english
}
