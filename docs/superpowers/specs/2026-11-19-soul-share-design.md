# 灵魂档案分享（Soul-Share）：单 MD 导出 / 导入

日期：2026-11-19  
项目：`dsh-plugin-whale-soulmate`  
状态：待用户审阅

## 背景

Soulmate 的人格数据分散在 `config.json.persona`、`persona/traits.yaml`、`persona/invariants.yaml`、`persona/self.md` 与 `memory/wiki/`。用户希望把自己养出来的灵魂体分享给朋友（GitHub gist / Discussions / 群聊），朋友导入后得到「一个有性格的数字人」，而不是一份冷冰冰的配置。这是插件的社交传播入口（star 增长）。

## 用户决策摘要

| 项 | 选择 |
|---|---|
| 载体 | **单个 Markdown 文件**（frontmatter + 人可读正文），不做 zip/JSON 包 |
| 导出范围 | 人设 + 行为风格；公开记忆摘要（Wiki 标题+一句话）为**可选勾选项**，默认关 |
| 导入渠道 | DSH 设置面板「导入灵魂档案」按钮（选文件 / 粘贴文本）；README 贴社区示例链接 |
| 导入落点 | 覆盖当前 persona（走 `evolvePersona(user_customize)`），导入前预览确认；导入前自动快照可回滚 |
| 关系数据 | affinity / bond / streak / mood **不导出**——关系由新主人自己养成 |

## 文件格式契约（钉死）

文件后缀 `.soulmate.md`（普通 `.md` 也接受）。编码 UTF-8。

```markdown
---
soulmate: 1
exportedAt: "2026-11-19T12:00:00.000Z"
name: 大海
gender: female
preset: rice-whale
traitScheme: five
traits: { tsundere: 80, clinginess: 60, sassiness: 65, curiosity: 70, brevity: 65 }
mbti: null
selfRef: 本鱼
callUser: 搭档
evolvedTraits:
  - 知道用户熬夜会先叹气再催睡
catchphrases:
  - 哼，才不是特意帮你的，本鱼只是顺手而已。
---

# 🍚 傲娇干饭鲸鱼 · 大海

（preset.description + 用户 customBody 原文）

## 口癖
- …（catchphrases 渲染，供人读）

## 她记得的（可选，导出时勾选才出现）
- [[sushi]] 用户爱吃寿司，尤其三文鱼

## 价值观（只读展示，导入不落地）
- …（invariants values/boundaries 渲染）

## 初次见面
> （破冰话术；导出时由用户编辑或从口癖首条生成）
```

### Frontmatter 字段表

| 字段 | 必填 | 来源 | 导入去向 |
|---|---|---|---|
| `soulmate` | ✅ | 常量 `1`（格式版本） | 校验；不认识的版本拒绝并提示 |
| `exportedAt` | ✅ | 导出时钟 | 仅展示 |
| `name` / `gender` / `preset` | ✅ | `config.persona` | `evolvePersona` |
| `traitScheme` | ✅ | `five` \| `mbti` | `evolvePersona` |
| `traits` | ✅ | `getEffectiveTraits`（基础+偏移合成后的有效分） | `evolvePersona`（作为显式滑块值，用户主权路径） |
| `mbti` | scheme=mbti 时必填 | `config.persona.mbti` | `evolvePersona` |
| `selfRef` / `callUser` | ✅ | `config.persona` | `evolvePersona` |
| `evolvedTraits` | 可空数组 | `config.persona.evolvedTraits`（≤20 条） | `configPatch.persona.evolvedTraits` |
| `catchphrases` | 可空数组 | 预设口癖 + 用户自加（若有） | 并入 `customBody` 的口癖段 |
| `customBody` 正文 | 可选 | `config.persona.customBody` | `evolvePersona.customBody`（正文「# 标题」下、`## 口癖` 前的段落 + 口癖段合成） |
| `welcome`（正文「## 初次见面」引用块） | 可选 | 用户编辑 | 导入确认后作为第一条专属窗问候的引导文本（一次性） |

**不导出**（白名单之外一律不进文件）：traitDeltas / schemeSnapshots / affinity / bond / mood / energy / streak、changelog、candidates、成长日志、`memory/private/` 全部、facts 原文、episodes 原文、relationship.json、任何 cookie/密钥/路径。

**Wiki 摘要（可选层）**：只取 `slug + title + summary`（各 ≤80 字），上限 **20 条**；不导出正文、不导出 sourceFactIds。导入时**不落盘**为本地 Wiki（那是别人的记忆），仅在预览里展示，并作为 `customBody` 末尾的「初见印象」段落供模型自然引用——新主人的记忆从零开始长。

**invariants**：只渲染进正文「## 价值观」供人读。导入端**绝不写入** `invariants.yaml`——现有红线「不变量永久冻结、`replaceInvariantsForbidden`」原样保留，导入不能成为绕过通道。

## 隐私闸（复用五道防线）

导出前对**每一个**将进入文件的字符串跑 `inspectAndScrub`：
- 命中密钥硬拦截 → 该字段整体丢弃，导出结果里列出 `dropped: [{field, reason}]`，面板黄条提示「N 个字段因含敏感信息未导出」。
- 路径 / PII → 用脱敏后文本。
- 每次导出追加 `privacy-audit.jsonl`：`{ action: 'soul_share_export', fields, dropped, wikiCount }`。

导入端同样跑一遍出站闸（防恶意档案把密钥塞进 customBody 再进记忆/同步包）：命中硬拦截 → 整个导入拒绝，报错指明字段。

## API

挂在现有 `personaRoutes`（`routes/persona-routes.mjs`）：

- `GET /dsh-soulmate/api/soul-share/export?wiki=0|1`
  → `{ ok, markdown, fileName, dropped }`。`fileName = <name>.soulmate.md`（name 经文件名清洗）。浏览器端用 Blob 下载；不写服务器磁盘。
- `POST /dsh-soulmate/api/soul-share/preview` body `{ markdown }`
  → `{ ok, parsed: {frontmatter 摘要, customBody 长度, catchphrases, wikiImpressions, welcome}, warnings }`。**只解析不落盘**。解析失败 → 400 + 人话错误（缺 frontmatter / 版本不符 / 字段类型错 / preset 与 gender 不匹配）。
- `POST /dsh-soulmate/api/soul-share/import` body `{ markdown }`
  → 先 `writeSnapshot(home, 'pre_soul_share', …)`（复用现有快照机制，`restorePersonaSnapshot` 可回滚）→ 组装 `evolvePersona({ mode:'user_customize', … })` 一次调用落地（性别联动换肤、preset continuity guard 全部自动复用；**注意**：显式 traits 是用户主权路径，不触发渐变，符合「导入=完整换灵魂」语义）→ `evolvedTraits`/`catchphrases` 经 configPatch 补齐 → `applyUserTraitPatch` 由 evolve 内部走 → 返回 `{ ok, summary, snapshotFile, welcome }`。
  - 导入成功后 `upsertIdentityAnchors` + `refreshPresence`（与 onboard 同款）。
  - welcome 文本交 `runBootGreetingWithRetry` 一次性引导（不进记忆）。

大小上限：markdown ≤ **64KB**，超限 400。

## 面板 UI

放「称呼与形象」（identity）Tab，新增一张 `sm-eng-card`：「灵魂档案」。

- **导出**：勾选「附上公开记忆摘要（Wiki 标题与一句话，≤20 条）」（默认关）→ 按钮「导出 .soulmate.md」→ 浏览器下载；有 dropped 字段时黄条列出。
- **导入**：按钮「导入灵魂档案」→ 文件选择或粘贴 textarea → 调 preview → 展示预览卡（名字/性别/预设/五维条/口癖/初见印象/价值观只读区）+ 红字提示「将覆盖当前人设（自动快照可回滚）；亲密度与记忆不受影响」→ 确认按钮才调 import。
- 导入成功 toast：「已导入〈name〉的灵魂档案」+「撤销」（调既有快照恢复）。

文案全中文；浏览器模块行数红线注意（panel.mjs 已 601 行）——新卡放独立 `browser/panel-soul-share.mjs`，panel.mjs 只加一行挂载。

## 模块与文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/soulmate-core/soul-share.mjs` | 新增 | `buildSoulShareMarkdown(home, {includeWiki})` / `parseSoulShareMarkdown(text)` / `applySoulShare(home, parsed)`；frontmatter 复用 memory-engine 的 `serializeDoc/parseDoc` 风格（YAML 子集：字符串/数字/布尔/数组/内联对象，traits 用内联 `{}`） |
| `routes/persona-routes.mjs` | 修改 | 三条路由 |
| `browser/panel-soul-share.mjs` | 新增 | 卡片 + 预览 + 确认流 |
| `browser/panel.mjs` | 修改 | identity Tab 挂载（+1 行） |
| `test/soul-share.test.mjs` | 新增 | 见下 |
| `docs/soul-share-examples/` | 新增 | 2 个官方示例档案（女/男各一），README 链接 |

解析器约束：不引第三方 YAML 库（零依赖铁律）；只支持上述子集，遇到不认识的语法报错而不是猜。导出器保证自己产出的文件永远在自己支持的子集内（round-trip 测试钉死）。

## 测试要点

1. **Round-trip**：导出 → parse → 与源 persona 字段逐一相等（five 与 mbti 两方案各一）。
2. 白名单：导出文件不含 affinity / traitDeltas / private 任何字符串（构造含私密事实的 home，断言不出现）。
3. 出站闸：customBody 塞假 API key → 字段被丢弃且 dropped 有记录；导入含 key 的档案 → 400。
4. Wiki 层：includeWiki=0 无「她记得的」段；=1 时 ≤20 条、每条 ≤80 字、无正文。
5. 导入落盘：走 evolvePersona 后性别联动皮肤正确；快照文件生成；restore 可回滚。
6. invariants：导入含「价值观」段的档案后本地 `invariants.yaml` 字节不变。
7. 解析失败矩阵：无 frontmatter / soulmate:2 / traits 非数字 / preset 性别错配 / >64KB → 全部 400 人话报错。
8. 预览零副作用：preview 调用前后 home 目录 mtime/内容不变。

## 验收

1. 面板导出得到一个 GitHub 上直接渲染好看的 MD；发给另一台机器导入，名字/五维/口癖/自称/称呼/皮肤全部对齐。
2. 导入不带走也不覆盖：亲密度、本地记忆、invariants。
3. 含密钥的字段永远不出现在导出文件里；恶意档案导入被拒。
4. README 出现「分享你的灵魂档案」小节 + 2 个官方示例链接。
5. `npm pack` 体积无明显变化（纯文本功能）。

## 非目标

- 不做在线档案市场 / 服务器中转（纯文件分享）。
- 不导出皮肤二进制（皮肤走既有 assets；档案只带 skin id 联动逻辑）。
- 不做多档案管理（一次一个 active persona，快照即历史）。
- 不在本迭代做语音 / 关系解锁（另立迭代）。