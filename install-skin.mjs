#!/usr/bin/env node
// install-skin.mjs — 一条命令安装桌宠皮肤（无需改代码 / 重新打包 / 重启）
// 用法: node install-skin.mjs <皮肤素材文件夹> [--id 皮肤id] [--profile desktop]
// 素材文件夹 = 含 pet.json + pet-*.webm + pet-*.png 的目录（如 output/pet-video-maid/assets）。
// 原理: 插件 v0.2.108+ 在每次请求时扫描 assets/pet-*/pet.json，复制进去即生效，
//       面板下拉框会自动列出新皮肤（形象 / 桌面小伙伴 两处）。
import { readFileSync, readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const src = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--id' && args[args.indexOf(a) - 1] !== '--profile');
if (!src) {
  console.error('用法: node install-skin.mjs <皮肤素材文件夹> [--id 皮肤id] [--profile desktop]');
  process.exit(1);
}
const srcDir = resolve(src);
if (!existsSync(join(srcDir, 'pet.json'))) {
  console.error('✗ 素材文件夹里没有 pet.json: ' + srcDir);
  process.exit(1);
}
// 皮肤 id: 显式 --id 优先；否则用文件夹名（assets 则取上一级，去掉 pet-video-/pet- 前缀）
let id = flag('id', '');
if (!id) {
  let base = basename(srcDir);
  if (base === 'assets') base = basename(resolve(srcDir, '..'));
  id = base.replace(/^pet-(video-)?/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error('✗ 非法皮肤 id（只允许小写字母/数字/连字符）: ' + id);
  process.exit(1);
}
// 校验素材完整性
const manifest = JSON.parse(readFileSync(join(srcDir, 'pet.json'), 'utf8'));
const problems = [];
let videoCount = 0;
for (const [name, st] of Object.entries(manifest.states || {})) {
  const vn = typeof st.video === 'string' ? st.video : st.video && st.video.name;
  if (vn) {
    videoCount++;
    if (!existsSync(join(srcDir, vn + '.webm'))) problems.push('缺少视频 ' + vn + '.webm（状态 ' + name + '）');
  }
  for (const f of [...(st.frames || []), ...(st.blink ? [st.blink] : [])]) {
    if (!existsSync(join(srcDir, f + '.png'))) problems.push('缺少帧图 ' + f + '.png（状态 ' + name + '）');
  }
}
if (problems.length) {
  console.error('✗ 素材不完整:\n  ' + problems.join('\n  '));
  process.exit(1);
}
// 定位已安装插件
const profile = flag('profile', 'desktop');
const pluginDir = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-plugin-whale-soulmate');
if (!existsSync(join(pluginDir, 'assets'))) {
  console.error('✗ 找不到已安装的插件: ' + pluginDir + '\n  请先安装 dsh-plugin-whale-soulmate（profile=' + profile + '）');
  process.exit(1);
}
const routesFile = join(pluginDir, 'packages', 'soulmate-core', 'routes', 'asset-routes.mjs');
let dynamic = false;
try { dynamic = readFileSync(routesFile, 'utf8').includes('api/pet/skins'); } catch { /* ignore */ }
if (!dynamic) {
  console.error('✗ 已安装插件版本过旧（不支持皮肤自动发现）。请先更新到 v0.2.108+：\n  打包后在 profile 目录执行 pnpm add <tgz> --no-frozen-lockfile');
  process.exit(1);
}
// 复制（覆盖同名文件）
const dest = join(pluginDir, 'assets', 'pet-' + id);
mkdirSync(dest, { recursive: true });
const files = readdirSync(srcDir).filter((f) => /\.(webm|mov|png|json)$/i.test(f));
for (const f of files) copyFileSync(join(srcDir, f), join(dest, f));
console.log('✓ 已安装皮肤 ' + id + '（' + (manifest.displayName || id) + '）');
console.log('  ' + files.length + ' 个文件 → ' + dest);
console.log('  状态 ' + Object.keys(manifest.states || {}).length + ' 个，透明视频 ' + videoCount + ' 个');
console.log('下一步: 打开伙伴面板 → 形象 / 桌面小伙伴 → 下拉选择「' + (manifest.displayName || id) + '」。无需重启。');
