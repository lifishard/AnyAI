#!/usr/bin/env node
/**
 * 把 native/android/SncHttpPlugin.java 装进 Capacitor 生成的 android 工程，
 * 并在 MainActivity 里注册它。
 *
 * android/ 目录是 `cap add android` 生成的、不进版本库的产物，所以每次重新生成
 * 之后都要跑一遍这个脚本。可以反复执行，已经装过就跳过。
 *
 *   node scripts/install-android-plugin.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PKG = 'cn.sensenova.chat';
const pkgPath = PKG.split('.').join('/');
const javaDir = path.join(root, 'android', 'app', 'src', 'main', 'java', pkgPath);
const pluginSrc = path.join(root, 'native', 'android', 'SncHttpPlugin.java');
const pluginDst = path.join(javaDir, 'SncHttpPlugin.java');
const mainActivity = path.join(javaDir, 'MainActivity.java');

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(javaDir)) {
  fail(
    `找不到 ${path.relative(root, javaDir)}\n` +
      `  先跑一次 \`npx cap add android\` 生成 android 工程，再执行本脚本。`,
  );
}
if (!fs.existsSync(pluginSrc)) fail(`找不到插件源码 ${path.relative(root, pluginSrc)}`);

// 1. 拷贝插件
fs.copyFileSync(pluginSrc, pluginDst);
console.log(`✓ 已复制 SncHttpPlugin.java → ${path.relative(root, pluginDst)}`);

// 2. 在 MainActivity 里注册
if (!fs.existsSync(mainActivity)) fail(`找不到 ${path.relative(root, mainActivity)}`);

let src = fs.readFileSync(mainActivity, 'utf8');

if (src.includes('SncHttpPlugin.class')) {
  console.log('✓ MainActivity 已注册过 SncHttpPlugin，跳过');
} else {
  const patched = `package ${PKG};

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册，否则 WebView 起来时拿不到这个插件
        registerPlugin(SncHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
  fs.writeFileSync(`${mainActivity}.bak`, src);
  fs.writeFileSync(mainActivity, patched);
  console.log('✓ 已改写 MainActivity.java 并注册插件（原文件备份为 MainActivity.java.bak）');
}

console.log('\n完成。接下来：npm run cap:sync && npx cap open android\n');
