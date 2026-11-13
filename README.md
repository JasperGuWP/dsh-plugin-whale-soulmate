# dsh-plugin-whale-soulmate 🐋

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-0A7EA4)](https://github.com/topics/dsh-plugin)

> **中文** · [English](#english)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的**模块化、可插拔 AI 小伙伴（Soulmate）**：

人设 × 情绪 × 关系养成 × **LLM Wiki 记忆** × **五道隐私防线** × **透明视频桌宠** × 可选 AIGC 云同步。

同时也是你的**办公 / 编程副驾**——不会因为陪伴而少用任何 DSH 能力。

形态：**Bundle 组合包**（npm 包，`dsh.bundle.patch`），双半侧 —— node（`index.js`）+ browser（`client.js`）。

更完整的架构说明见 [`docs/DESIGN.md`](./docs/DESIGN.md)；版权与致谢见 [`NOTICE.md`](./NOTICE.md)。

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 零配置上手 | 装上重启后右下角冒出桌宠 + 引导；未授权云端时**零外网请求** |
| 人设引擎 | 多套预设、五维滑块、MBTI 测验、性别声线、自我成长与三档安全重置 |
| 混合记忆 | 事实 / Wiki / 双日记本；在场摘要、承诺、冲突裁决、语义遗忘 |
| 桌宠 | `pet-winterboy-chibi`：PNG 回退 + VP9-alpha WebM；拖拽 / 点击 / 思考 / 走路 |
| 主动开口 | 本地生物钟闸：早安 / 催饭 / 晚间 / 催睡；夜间做梦蒸馏；专属会话投递 |
| 隐私 | 五道防线 + 审计账本；私密记忆永不进云同步 |
| 扩展 | B 站理解与风控写操作；微信 / QQ / 飞书 / 钉钉 IM 分身 |
| 副驾 | 双轨提示词 + 人设漂移重锚；完整调用宿主工具链 |

## 快速安装

```bash
# 在本仓库根目录
npm pack
# → dsh-plugin-whale-soulmate-<version>.tgz

dsh plugin --profile web add ./dsh-plugin-whale-soulmate-<version>.tgz
# 或 desktop profile
dsh plugin --profile desktop add ./dsh-plugin-whale-soulmate-<version>.tgz
```

> **务必装 tarball，不要装目录。** 目录会记成 `link:`，容易触发 `ERR_MODULE_NOT_FOUND`。  
> node 半侧**无热加载**：装完请重启 dsh 进程。

也可（锁定 commit 更稳）：

```bash
dsh plugin --profile web add github:JasperGuWP/dsh-plugin-whale-soulmate#<sha>
```

本地 `--patch`（仅自用）：

```bash
dsh --patch ./cordis.patch.yml
```

## 使用片刻

1. 打开 DSH Web / Desktop，右下角出现桌宠；引导里选性格、填称呼（自动保存）。
2. 侧边栏「小鱼 / 设置」可改人设、信任层、作息、用量等。
3. 需要多端同步时，在设置里**显式授权**云端后再联网。

## 开发

```bash
npm run build:client     # browser/*.mjs → client.js
```

- 改前端请编辑 `browser/`，勿手改 `client.js`（构建产物，且默认不入库）。
- 改 node 后重启 dsh；改 browser 后重建并刷新页面。

## 仓库结构

```
index.js                 # node 入口
cordis.patch.yml         # Bundle / patch 声明
packages/soulmate-core/  # 记忆 / 人设 / 隐私 / 调度 / 路由 / 工具
packages/soulmate-home/  # 桌宠状态机
packages/soulmate-bili/  # B 站扩展
packages/soulmate-im/    # IM 扩展
browser/                 # 前端源模块
assets/pet-winterboy-chibi/  # 桌宠素材
docs/DESIGN.md           # 设计概览（中英）
NOTICE.md                # 版权与致谢
```

## 版权与许可

- 代码与文档：**MIT**，Copyright © 2026 JasperGuWP —— 见 [`LICENSE`](./LICENSE)
- 素材版权与第三方致谢 —— 见 [`NOTICE.md`](./NOTICE.md)

欢迎打主题标签 **`dsh-plugin`**，以便 [deepseek-harness 插件库](https://github.com/topics/dsh-plugin) 发现本仓库。

---

<a id="english"></a>

## English

A **modular, pluggable AI companion (Soulmate)** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

persona × mood × relationship · **LLM Wiki memory** · **five privacy layers** · **transparent video desktop pet** · optional AIGC cloud sync.

Also your **coding / office co-pilot** — companionship never strips host tools.

**Form:** dual-face **Bundle** (`dsh.bundle.patch`) — node (`index.js`) + browser (`client.js`).

Architecture: [`docs/DESIGN.md`](./docs/DESIGN.md) · Credits: [`NOTICE.md`](./NOTICE.md).

### Features

| Area | What you get |
|---|---|
| Zero-config | Pet + onboarding after install/restart; **no network** until cloud consent |
| Persona | Presets, 5-axis sliders, MBTI quiz, voice/gender, safe 3-tier reset |
| Memory | Facts / Wiki / dual diaries; presence, promises, conflicts, semantic decay |
| Desktop pet | `pet-winterboy-chibi` PNG + VP9-alpha WebM; drag / tap / think / walk |
| Proactive | Local circadian gate; night dream distill; dedicated chat-home delivery |
| Privacy | Five layers + audit ledger; private memories never sync |
| Extensions | Bilibili watcher + gated writes; WeChat / QQ / Feishu / DingTalk |
| Co-pilot | Dual-track prompts + drift anchor; full host tool access |

### Install

```bash
npm pack
dsh plugin --profile web add ./dsh-plugin-whale-soulmate-<version>.tgz
```

Install the **tarball**, not a directory. Restart dsh (node half is not hot-reloadable).

```bash
dsh plugin --profile web add github:JasperGuWP/dsh-plugin-whale-soulmate#<sha>
```

### Develop

```bash
npm run build:client   # browser/*.mjs → client.js
```

Edit `browser/` sources; do not hand-edit generated `client.js`.

### License & credits

- Code & docs: **MIT**, Copyright © 2026 JasperGuWP — [`LICENSE`](./LICENSE)
- Asset copyright & third-party thanks — [`NOTICE.md`](./NOTICE.md)

Please tag the repo with **`dsh-plugin`** so the harness plugin library can discover it.
