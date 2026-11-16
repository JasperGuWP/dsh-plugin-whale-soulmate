# 多平台冲浪（先 B 站）自动互动 +「冲浪」标签页

日期：2026-11-16  
项目：`dsh-plugin-whale-soulmate`  
状态：待用户审阅

## 背景

用户已开启定时自动刷 B 站与写操作开关。当前冲浪只读看片并记小本本，**不会**按性格自动点赞 / 收藏 / 评论 / 关注；别人回复其评论也不会跟帖。B 站登录与定时冲浪配置挤在「作息与主动」页，缺少给用户看的冲浪履历。后续还会接入**抖音**等平台，UI 与数据必须按平台分列，避免混成一锅。

## 目标

1. 定时冲浪看完每个视频后，用**短模型决策**按人设决定：是否喜欢（赞）、收藏、评论、关注作者；当场执行（方案 A）。
2. 若有人回复其评论，按人设自动跟帖；同一条楼最多 **2–3 轮**；内容必须符合该平台评论规范（先落地 B 站规范）。
3. 新增侧栏标签 **「冲浪」**：**按平台分列**（先做 B 站列；抖音列占位）。每列自含登录 / 写操作 / 定时冲浪 / 自动互动 / **本平台冲浪日志**（截图、可点链接、观看总结、**在平台做过什么**必有）。

## 非目标

- 本迭代不实现抖音抓取 / 登录 / 写操作（仅 UI 分列占位 + 数据结构预留）。
- 不自动：投币、私信、弹幕、改资料、开播、投稿（B 站）。
- 不改免打扰总规则（冲浪与跟帖轮询均尊重 `quietHours`）。
- 不在本规格内做云同步冲浪日志。

## 用户决策摘要

| 项 | 选择 |
|---|---|
| 互动时机 | A：当场自动执行 |
| 评论范围 | A：赞 / 藏 / 评均可自动 |
| 跟帖深度 | B：同一楼最多 2–3 轮 |
| 决策方式 | 方案 2：每片一次短决策 |
| 关注作者 | 可按性格自行关注（同作者 id 7 天不重复） |
| UI | 新标签「冲浪」；**平台分列**（B 站 / 抖音…） |

## 多平台分列（架构）

### 原则

- **一个外层 Tab「冲浪」**，内部是 **平台分列切换**（二级 tabs 或左侧平台条），不是把所有平台控件堆在一页。
- 每个平台 = 独立配置命名空间 + 独立日志流 + 独立写操作闸；共享的只有人设短决策骨架与「冲浪卡片」展示组件。
- 平台 id 稳定枚举：`bilibili` | `douyin` |（未来再加）。

### UI 示意

```
[ 冲浪 ]
  ├─ 平台条： [ B站 ]  [ 抖音（即将） ]
  └─ 当前平台面板（仅一列内容）
        ├─ 登录 / 凭证
        ├─ 写操作开关
        ├─ 定时冲浪
        ├─ 自动互动（赞藏评关 / 跟帖）
        └─ 本平台冲浪日志
```

- **B 站列**：本迭代完整实现（迁入现有 `biliAuthCard` + `autoSurfSection` + 新互动与日志）。
- **抖音列**：占位卡——「即将支持：登录、定时刷、按性格互动、专属日志」；控件 disabled，不读不写抖音 API。

### 迁入（仅 B 站列）

从「作息与主动」**移出**：

- `biliAuthCard`（B 站登录、Cookie、写操作总开关）
- `autoSurfSection`（定时自动刷 B 站、间隔、每次数量、认真看完、关键词）

「作息与主动」保留主动问候、日记、梦境、专属窗、免打扰展示、每日主动次数等。

### Tab 注册

`panel.mjs` tabs 增加 `{ id: 'surf', label: '冲浪' }`；页内 `surfPlatform` state 默认 `bilibili`。  
`requestSoulmateTab('surf', { platform: 'bilibili' })` 可用于 Toast。

## 冲浪日志（给用户看）

### 存储（按平台分文件，避免混列）

- B 站：`~/.dsh/soulmate/surf-log-bilibili.jsonl`
- 抖音（预留）：`~/.dsh/soulmate/surf-log-douyin.jsonl`
- 兼容：若存在旧名 `bili-surf-log.jsonl`，启动时迁入 bilibili 文件一次。

### API

- `GET /dsh-soulmate/api/surf-log?platform=bilibili|douyin&limit=&filter=`
- `platform` **必填**（或默认 bilibili）；禁止一次接口混返回多平台。

### 写入时机

每片看完 + 决策执行后追加；跟帖成功时 **patch** 对应条目的 `actions` / `replies`。

### 卡片字段（必有；跨平台共用形状）

| 字段 | 说明 |
|---|---|
| `platform` | `bilibili` / `douyin` / … |
| `at` | ISO 时间 |
| `videoId` / `url` | 平台视频 id + **可点击**外链（B 站为 bvid） |
| `title` / `author` / `authorId` | 元数据（B 站 authorId = mid） |
| `coverUrl` + `stills[]` | 截图：封面优先，另 0–3 张关键帧 URL |
| `worthScore` | 0–20（或平台等价分，展示时标明） |
| `summary` | 观看总结（要点 / 性格口吻观感） |
| `actions` | **必有**：`{ like, favorite, comment, follow, commentText?, skippedReasons? }`；若全无互动须写明「未互动」及原因 |
| `replies` | 跟帖记录：`[{ at, toId, text, round }]` |

图片：优先用该平台 CDN 封面 / 分镜 URL（不强制本地下载）；若 URL 失效，卡片仍显示文字与链接。

### 展示组件

共用 `SurfLogCard`；平台相关文案 / 外链格式由 `platform` 适配器提供（B 站已实现，抖音适配器本迭代返回占位）。

## 冲浪后自动互动（本迭代：仅 bilibili 管线）

### 触发

`runAutonomousSurfRound` / `watchAndRecordVideo` 成功后，若：

- `extensions.biliWriteEnabled === true`
- `extensions.biliAutoEngageEnabled === true`（默认随写操作）
- 非免打扰（与冲浪同一套 quietHours）
- 未超 `biliMaxDailyWrites` / 最小间隔

则调用 `decideSurfEngage({ platform: 'bilibili', digest, persona }) → EngagePlan`。

抖音管线接入后复用同一 `EngagePlan` 形状与决策骨架，换平台执行器与规范提示词。

### EngagePlan（模型 JSON）

```json
{
  "like": true,
  "favorite": false,
  "comment": true,
  "commentText": "……",
  "follow": false,
  "reason": "一句话自述"
}
```

### 性格与启发式（提示词内软约束，非硬替模型）

- 低分（如 &lt; 7）：倾向全否
- 高分（如 ≥ 13）：更易赞；收藏略严；评论视话多/外向
- 关注：仅当「特别对口 / 想追更」；同 `authorId` 7 日内已关注则强制 `follow: false`
- 评论文案必须像本人，禁止广告腔与刷屏套话

### 执行

顺序建议：`like` → `favorite` → `comment` → `follow`，均走现有 `biliWriteAction`；任一步失败记入 `actions.skippedReasons`，不阻断后续（除凭证失效则整段停止）。

评论成功后把 `rpid` / `aid` / `bvid` 写入 **平台评论账本**（路径带 platform，如 `surf-comment-ledger-bilibili.json`）。

## 自动跟帖

### 轮询

挂在 `runProactiveTick`：与 auto-surf 同级，免打扰跳过。间隔可配置，默认每 tick 最多处理 N 条未读回复（如 3）。

### 流程

1. 读评论账本中未关闭线程（`rounds < maxRounds`，默认 3）
2. 拉该评论下的新回复（需 B 站 reply 列表 API；跟帖发评需 `parent`/`root`——**扩展**现有 `comment` action）
3. 短决策：是否回复 + 文案
4. 执行；`rounds++`；达到上限标记 `closed`
5. 同步追加到对应冲浪日志条目

### 楼内上限

同一 `root`/`rpid` 线程最多 **3** 轮我方回复（用户选 B：2–3 轮，取 3 为默认，可配置 `biliAutoReplyMaxRounds` ∈ [2,3]）。

## B 站评论规范（硬门槛）

决策 system 提示 + 发出前本地校验；失败则不发或允许模型重写 **1** 次：

- 不人身攻击、歧视、骚扰、引战
- 不剧透关键情节（若摘要含剧透标记则倾向不评）
- 不导流站外、不广告、不刷屏复读
- 不泄露隐私 / Cookie / 密钥
- 不冒充官方或伪造互动数据
- 长度克制（建议 ≤ 100 字；硬上限沿用写操作 900 字 scrub）
- 像真人一句感受，不像营销号

跟帖额外：不抬杠升级；对方辱骂则停止跟帖并关楼。

## 配置项

B 站继续用现有 `extensions.bili*` 前缀（本迭代不强制迁到嵌套对象，避免破坏已装配置）。  
抖音预留平行前缀 `extensions.douyin*`（本迭代可不写入默认 config，UI 占位即可）。

| 键 | 默认 | 含义 |
|---|---|---|
| `biliAutoSurfEnabled` | 已有 | 定时看片 |
| `biliWriteEnabled` | 已有 | 写操作总闸 |
| `biliAutoEngageEnabled` | `true`（当 write 开） | 冲浪后自动赞藏评关 |
| `biliAutoReplyEnabled` | `true` | 自动跟帖 |
| `biliAutoReplyMaxRounds` | `3` | 同楼最大轮数 |
| `biliFollowDedupDays` | `7` | 同 authorId 关注去重天数 |

未来若做统一结构，可迁到 `extensions.surf.platforms.bilibili.*`，需一次性迁移脚本；**非本迭代必做**。

## 短决策调用

- 不经专属窗 UI（避免刷屏）；走内部 completion / 轻量 prompt（与现有 proactive 预算计入 **自动额度**）
- 额度用尽：跳过互动，日志记 `skippedReasons: ['daily-token-cap']`，看片与日志仍写入

## 测试要点

- 决策 JSON 解析失败 → 不写站，日志记失败原因
- write 关闭 → 绝不调用 biliWriteAction
- 同 authorId 7 天内不重复 follow
- 跟帖第 3 轮后不再回
- 规范词拦截（辱骂、导流）不发出
- 「冲浪」Tab：平台条有 B 站 + 抖音占位；切到抖音为占位卡、无凭证写入
- 「作息与主动」无 B 站登录 / 自动冲浪块
- 日志 API 按 `platform` 隔离；卡片含链接、总结、`actions`（含未互动）

## 实现分期（建议）

1. **UI**：新 Tab「冲浪」+ **平台分列**（B 站实装 / 抖音占位）+ 迁入登录与自动冲浪 + 日志空态  
2. **日志管线**：`surf-log-bilibili.jsonl` + API（强制 platform）+ 卡片（先接现有看片，actions 可先「未互动」）  
3. **Engage**：短决策 + 执行赞藏评关 + 写 actions  
4. **跟帖**：comment parent/root + 账本轮询 + 2–3 轮 + 规范过滤  
5. **（后续迭代）** 抖音适配器：登录、冲浪、执行器、规范词、日志文件

## 开放问题

无（若审阅无异议则进入实现计划）。
