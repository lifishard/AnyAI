# 从源码构建与发版

## 环境

- **Node ≥ 20**（`package.json` 里 `engines` 卡的就是这个）
- Windows / macOS / Linux 都能构建，但**只能构建当前平台的安装包** ——
  electron-builder 不做跨平台交叉打包（Windows 上打 macOS 包必然失败）。
  跨平台产物交给 GitHub Actions，见下。

```bash
git clone https://github.com/lifishard/wickrunAI.git
cd wickrunAI
npm install
```

## 开发

```bash
npm run dev            # 只开浏览器调 UI（工具要配好遥控才能用）
npm run dev:electron   # 开 Electron 窗口，功能完整
```

Windows 上不想开命令行：双击 **`开发模式.bat`**。

浏览器模式下网络请求走 Vite 的 `/__sn` 代理插件（读 `x-sn-base` 头决定转发到哪），
这是为了绕开上游不发 CORS 头的问题。

## 打包桌面版

```bash
npm run dist:win     # 或 dist:mac / dist:linux
```

Windows 上双击 **`打包桌面版.bat`** 是同一件事的无命令行版本：装依赖 → 类型检查 → 打包 →
自动打开当前版本的安装向导。按向导完成安装即可；安装包也保存在 `release/<当前版本>`。版本直接读取 `package.json`，不会额外生成 1.0 包。

产物：

| 文件 | 说明 |
|---|---|
| `wickrunAI-<当前版本>-win-x64-setup.exe` | NSIS 安装版，自动建桌面和开始菜单快捷方式 |
| 带 `portable` 的那个 | 免安装，扔哪都能双击跑 |

**类型检查失败会停止打包。** 新包成功生成后，保留最新和前一个有可用包的版本，清理 release 内更老的已识别安装包、blockmap 和对应版本目录，兼容历史 SenseNova Chat 包。构建失败不清理；仍在运行的旧产物暂留。未知文件、没有可用包的目录及目录链接不删除。

双击“同步到github.bat”会检查、提交并推送。只想检查可运行 `npm run sync:check`，不改动暂存区、不提交、不推送。密钥扫描只显示文件、行号和类型；测试用模拟密钥在运行时构造，扫描仍生效。此前提交成功但推送失败时，再运行脚本会继续推送已有提交。

### 三个批处理入口

请依次运行，并等待前一个窗口完成：

1. **打包桌面版.bat**：构建当前 Windows 安装包，并打开安装向导。
2. **同步到github.bat**：检查、提交本地修改并推送当前分支。
3. **发布三平台版本.bat**：再次检查，同步遗漏修改，推送 `v<当前版本>` 标签；GitHub Actions 自动构建 Windows、macOS、Linux，核对八个安装包后公开 Release。

三个入口都会切到仓库目录、保留退出码并停留显示结果。第三个入口本身也会同步，因此第二步已经做过时不会重复提交。版本从 `package.json` 读取，并核对锁文件；已经发布的标签不能被新代码覆盖。

本次正式版本为 **2.0.1**。发布依赖本机可用的 GitHub 推送身份、网络和仓库 Actions；点击第三个入口表示开始云端构建，不表示三平台已经构建完成。失败时保留本地文件，修复后可重试。

批处理使用 ASCII 薄壳，中文提示由 Node 输出。需要只验证本地打包且不安装、不清理旧包或打开窗口，可运行 `node scripts/build-desktop.mjs --no-install --no-cleanup --no-open`。只检查发布前条件可运行 `node scripts/sync-github.mjs --release --check-only`。

## 两个 Windows 上常见的打包失败

### 1. 符号链接权限

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
  ...\winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

跟网络和杀毒**没有关系** —— 看日志会发现下载每次都成功，挂的是解压。

electron-builder 要解压一个叫 winCodeSign 的签名工具包，里面混进了 macOS 用的
`libcrypto.dylib` / `libssl.dylib`，这两个是符号链接。Windows 上创建符号链接需要
`SeCreateSymbolicLinkPrivilege`，普通用户默认没有。

二选一，一次设置永久有效：

- **打开开发者模式**：设置 → 系统 → 开发者选项 → 开发人员模式。推荐这个。
- 用管理员身份跑一次打包。

不处理也能用：脚本检测到这个错误会**自动退到 `--dir` 模式**，产出 `release\<当前版本>\win-unpacked\`，
再用 PowerShell 在桌面建一个快捷方式。功能完全一样，只是没有安装程序 ——
注意那个 exe 依赖同目录的其它文件，要挪就整个文件夹一起挪。

### 2. `output file is locked for writing`

**旧的 wickrunAI 还开着。** 关掉再打。
`scripts/build-desktop.mjs` 会先用 `tasklist` 检测，问你要不要 `taskkill`。

## Android

```bash
npm run cap:add:android    # 首次：生成 android/ 工程并装上原生插件
npm run cap:sync           # 之后每次改完前端
npx cap open android       # 用 Android Studio 打开，Build → APK
```

`android/` 是生成产物，不进版本库。
**每次重新 `cap add android` 之后都要跑一遍 `npm run cap:patch`**，
否则那个自写的流式插件不会被装进去，手机上流式响应会失效（退化成整包返回）。

为什么要自写插件：Capacitor 官方的 `CapacitorHttp` 能绕过 CORS，但它会把整个响应缓冲完才回调，
拿不到流式增量。

## 发布到 GitHub

### 一次性：认领这个仓库（fork 之后）

仓库地址散落在 package.json、README、SECURITY 和这份文档里。fork 之后跑一次这个脚本，
它会把它们全部指向你自己的仓库：

```bash
node scripts/init-repo.mjs <owner> [repo]
# 例：node scripts/init-repo.mjs octocat wickrunAI
```

脚本匹配的是当前仓库的 `owner/repo` 字样，改完自检一下
`grep -rn "github.com/" package.json README.md SECURITY.md docs/`。

然后推上去：

```bash
git init
git add -A
git commit -m "wickrunAI 1.0.0"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

### CI（`.github/workflows/ci.yml`）

每次 push 和 PR 触发：`tsc --noEmit`（**阻断**）→ `vite build` →
`electron-builder --linux --dir` 验证打包配置能过。

本地打包和发布流程也会阻断类型错误。

### 发版（`.github/workflows/release.yml`）

Windows 双击 **`发布三平台版本.bat`**。它会先检查类型、密钥和测试，再提交、推送源码并推送当前版本标签。普通的 `同步到github.bat` 只同步源码，不创建 Release。

macOS / Linux 或命令行使用：

```bash
node scripts/sync-github.mjs --release
```

首次发布当前版本可直接运行；下一次发布前用 `npm version <新版本> --no-git-tag-version` 同时更新版本和锁文件，并准备 `docs/releases/v<新版本>.md`。脚本不会覆盖指向其他提交的同名标签。

Actions 在 **Windows / macOS / Linux 三个平台**分别检查、测试和打包。三个构建全部成功后，统一核对 8 个安装包：Windows 安装版和便携版、macOS Intel / Apple Silicon 各一份 DMG 和 ZIP、Linux AppImage 和 DEB。再上传到草稿，检查上传后的名称和大小，全部通过才自动公开 Release。某个平台失败时不会公开不完整版本。

Release 还包含 `SHA256SUMS.txt` 和 `release-manifest.json`，记录文件大小、校验值和源码提交。已公开的版本不自动覆盖。

可在 Actions 页手动触发：默认勾选 `dry_run` 只构建；发布必须选择对应版本标签并取消 `dry_run`。失败后可重跑工作流，已公开版本会拒绝再次上传。

如果三个平台都构建成功，只有发布脚本需要修复，可修复并推送源码后运行 **Recover Release**，填写原 Release 的运行编号。恢复流程会核对原运行的源码提交与版本标签一致、三个平台均成功，再复用原安装包发布；不会移动版本标签。Linux 打包工具生成的 `x86_64.AppImage` / `amd64.deb` 文件会统一成 README 中的 `x64` 命名。

**不需要配任何 secret。** 用的是 Actions 自带的 `GITHUB_TOKEN`，
仓库地址 electron-builder 会从 `GITHUB_REPOSITORY` 环境变量自己认。

### 没有代码签名

`CSC_IDENTITY_AUTO_DISCOVERY: false`，mac 那边 `identity: null, notarize: false`。

后果：Windows SmartScreen 和 macOS Gatekeeper 会警告「未知发布者」/「已损坏」。
这是没有证书时的预期行为。macOS 用户绕过的方法是右键 → 打开，
或者 `xattr -dr com.apple.quarantine /Applications/wickrunAI.app`。

要签名的话：Windows 需要一张 OV/EV 代码签名证书（一年几百刀），
macOS 需要 Apple Developer Program（$99/年）。把证书放进仓库 secrets，
electron-builder 会自己认 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` 那几个变量。

### 许可合规

`LICENSE` 和 `NOTICE` 已经加进 electron-builder 的 `files` 里，会随应用一起打包。
依赖自带的 license 文本在 `node_modules` 里，也会跟着进 asar —— 所以现在就是合规的。

只有一种情况要额外处理：哪天把依赖 bundle 进单文件（tree-shaking 掉 node_modules），
那就得手工生成一份第三方声明附上。`npx license-checker --summary` 能列出全部。

### 没有自动更新

没接 `electron-updater`。更新靠用户自己下新版本。
要加的话 `publish` 配置已经就位，装上 `electron-updater` 接几行即可。
