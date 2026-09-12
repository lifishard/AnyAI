# 从源码构建与发版

## 环境

- **Node ≥ 20**（`package.json` 里 `engines` 卡的就是这个）
- Windows / macOS / Linux 都能构建，但**只能构建当前平台的安装包** ——
  electron-builder 不做跨平台交叉打包（Windows 上打 macOS 包必然失败）。
  跨平台产物交给 GitHub Actions，见下。

```bash
git clone https://github.com/lifishard/AnyAI.git
cd anyai
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
打开 `release` 文件夹。

产物：

| 文件 | 说明 |
|---|---|
| `AnyAI-1.0.0-win-x64.exe` | NSIS 安装版，自动建桌面和开始菜单快捷方式 |
| 带 `portable` 的那个 | 免安装，扔哪都能双击跑 |

**类型检查失败不阻断打包。** vite 用 esbuild 剥类型，本来就不做类型检查，类型错不影响产物能不能跑。
脚本会把错误列出来然后继续。（CI 里相反，typecheck 是**阻断**的，见下。）

### 那两个 .bat 为什么一个中文都没有

cmd.exe 按**字节偏移**逐行读批处理文件。`chcp 65001` 之后偏移量和多字节字符的实际长度对不上，
从那行起整个文件会被切错位 —— 表现就是 echo 的中文被拆成一截一截当命令执行
（`'js:' is not recognized...`）。

所以那两个 bat 是纯 ASCII 的薄壳，真正的逻辑在 `scripts/build-desktop.mjs`，中文提示由 Node 输出。
macOS / Linux 直接 `node scripts/build-desktop.mjs`。

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

不处理也能用：脚本检测到这个错误会**自动退到 `--dir` 模式**，产出 `release\win-unpacked\`，
再用 PowerShell 在桌面建一个快捷方式。功能完全一样，只是没有安装程序 ——
注意那个 exe 依赖同目录的其它文件，要挪就整个文件夹一起挪。

### 2. `output file is locked for writing`

**旧的 AnyAI 还开着。** 关掉再打。
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
# 例：node scripts/init-repo.mjs octocat anyai
```

脚本匹配的是当前仓库的 `owner/repo` 字样，改完自检一下
`grep -rn "github.com/" package.json README.md SECURITY.md docs/`。

然后推上去：

```bash
git init
git add -A
git commit -m "AnyAI 1.0.0"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

### CI（`.github/workflows/ci.yml`）

每次 push 和 PR 触发：`tsc --noEmit`（**阻断**）→ `vite build` →
`electron-builder --linux --dir` 验证打包配置能过。

本地那套「类型错也放行」是为了让你拿到能跑的 exe；进仓库的代码不给这个宽限。

### 发版（`.github/workflows/release.yml`）

打 tag 触发：

```bash
npm version 1.0.1 --no-git-tag-version   # 改 package.json 里的版本号
git commit -am "v1.0.1"
git tag v1.0.1
git push && git push --tags
```

之后 Actions 会在 **Windows / macOS / Linux 三个 runner** 上并行打包，
产物自动传到一个 draft release 里。`fail-fast: false` —— 一个平台挂了不影响另外两个。

去仓库的 Releases 页把 draft 编辑一下发布即可。

也可以在 Actions 页手动触发，勾上 `dry_run` 只打包不发布，用来验证工作流本身。

**不需要配任何 secret。** 用的是 Actions 自带的 `GITHUB_TOKEN`，
仓库地址 electron-builder 会从 `GITHUB_REPOSITORY` 环境变量自己认。

### 没有代码签名

`CSC_IDENTITY_AUTO_DISCOVERY: false`，mac 那边 `identity: null, notarize: false`。

后果：Windows SmartScreen 和 macOS Gatekeeper 会警告「未知发布者」/「已损坏」。
这是没有证书时的预期行为。macOS 用户绕过的方法是右键 → 打开，
或者 `xattr -dr com.apple.quarantine /Applications/AnyAI.app`。

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
