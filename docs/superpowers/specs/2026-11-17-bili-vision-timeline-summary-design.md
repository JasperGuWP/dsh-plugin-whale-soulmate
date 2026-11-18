# B 站冲浪：画面理解时间线总结 + 可选 ASR

日期：2026-11-17  
项目：`dsh-plugin-whale-soulmate`  
状态：已实现（0.2.111）

## 背景

当前「讲了什么」主要来自官方字幕切片（清洗 + 标题对齐），分镜/真帧只作预览图，**不进视觉模型**。错位字幕会被丢弃并退回标题，用户无法靠总结真正了解片内容。用户要求改为：**以画面理解为主**，综合标题/简介/对齐字幕，按时间线产出完整总结。

## 用户决策

| 项 | 选择 |
|---|---|
| 内容策略 | **B**：图片为主，对齐字幕为辅；综合标题、简介；按时间线总结，让用户完整了解内容 |
| 帧来源 | **A**：优先 ffmpeg 真帧；不够用分镜雪碧图；降级**不强制** ffmpeg |
| 完整度 | **B**：约 12–16 帧上限；时间轴分章（开场/发展/高潮/收尾），一屏可读 |
| 失败策略 | **C**：软降级写日志 + 面板提示（ffmpeg 可选 / 需视觉模型 / ASR endpoint） |
| 抽帧密度 | 用户分档选择：`15 / 20 / 30 / 45 / 60 / 90 / 120` 秒/帧（复用现有真看密度配置） |
| ASR | 无官方字幕或字幕错位丢弃时才跑；走用户自配外部 endpoint（**C**）；未配置则跳过并提示 |
| 冲浪卡文案 | **B**：一句话总览 + 时间线分章 + 观感 + **同一段末尾并入做了什么**（点赞/收藏/评论/关注） |
| 实现路线 | 方案 1：看完后挂一次视觉总结（非分批、非本地 caption 两跳） |

## 目标

1. 新增（或默认开启）`extensions.biliVisionSummary`：看片后用视觉模型生成时间线总结，写入 `digest.takeaway` 与冲浪卡。
2. 帧采集：真帧优先，否则分镜；密度 = `biliLiveFrameEverySec`；算出候选后**均匀抽稀到 ≤16 帧**送模。
3. 文本通道：标题 + 简介 +（对齐通过的官方字幕；否则尝试 ASR）。
4. ASR：仅当字幕不可用；调用用户配置的 `biliAsrEndpoint`（+ 可选 Key）；未配置/失败不阻断画面总结。
5. 冲浪卡 summary 结构：总览 → 分章时间线 → 观感 → `｜已点赞、已收藏…`（engage 完成后回写同一 summary）。
6. 任一步视觉失败：退回现有 `composeVideoTakeaway`，标注「未看画面」，面板提示原因。

## 非目标

- 不捆绑 Whisper / 本地 ASR 运行时（本机 Whisper 可后续另开）。
- 不做「始终跑 ASR」；不把整片或全部抽帧送模。
- 不捆绑 ffmpeg、不存整片文件。
- 不硬编码云厂商模型名；经宿主注入的视觉调用（`visionSummarize` / 带图 `generateReply`）。

## 方案对比（已选）

| 方案 | 要点 | 结论 |
|---|---|---|
| **1 一次视觉总结** | 12–16 帧 + 元数据一次调用 | **采用** |
| 2 分批看图再合并 | 长片更稳、更慢更贵 | 否（本迭代） |
| 3 本地 caption → 文本总结 | 两跳误差、缺本地管线 | 否 |

## 数据流

```
digestBiliVideo
  → (可选) live frames（ffmpeg；失败忽略）
  → 选帧：live 优先 else storyboard；按 everySec 节奏 / 抽稀 ≤16
  → 若字幕 empty/mismatch：可选 ASR(endpoint)
  → composeVisionTimelineSummary(frames, title, desc, transcript?)
       成功 → digest.takeaway = 总览+分章+观感
       失败 → composeVideoTakeaway（旧路径）+ channels.visionSummary=skip:…
  → afterSurfWatch / engage
       → summary = takeaway 文案
       → engage 后 patch：在 summary 末尾追加「｜已点赞、已收藏…」（方案 B）
```

## 输出格式（冲浪卡「讲了什么」）

```
讲了什么：<一句话总览>
时间线：
· 00:00–mm:ss <章标题>：<要点>
· …
观感：<沿用评分语气>
｜已点赞、已收藏、已评论
```

- 无互动时不追加 `｜…`，或写 `｜仅观看`。
- 评论正文仍可保留在卡下方 replies 列表（若已有）；本迭代**不要求**把长评论嵌进 summary。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `biliVisionSummary` | boolean | `true` | 开启画面时间线总结；无能力时自动软降级 |
| `biliLiveFrameEverySec` | number | `30` | 复用：`15–120` 分档，同时约束真帧与送模取样节奏 |
| `biliVisionModel` | string | `''` | 可选；空=宿主自动选 vision 模型 |
| `biliAsrEndpoint` | string | `''` | 外部转写 URL；空=不跑 ASR |
| `biliAsrApiKey` | string | `''` | 可选；仅存 credentials/扩展私密配置，不进日志 |

面板：冲浪区增加「画面理解总结」开关；密度控件与真看共用；ASR 显示 endpoint 是否已配置 + 一行说明。

## 失败码（`channels.visionSummary` / 面板）

| 码 | 含义 | 行为 |
|---|---|---|
| `ok:live` | 真帧视觉成功 | 写时间线 |
| `ok:storyboard` | 分镜视觉成功 | 写时间线 |
| `skip:no-frames` | 无真帧无分镜 | 文字总结 + 提示 |
| `skip:no-vision-model` | 无可用视觉模型 | 文字总结 + 提示 |
| `skip:vision-error` | 调用失败/超时 | 文字总结 + 提示 |
| `skip:disabled` | 开关关闭 | 旧路径 |
| ASR：`ok` / `skip:unconfigured` / `skip:error` | 仅影响 transcript 供给 | 不阻断视觉 |

## 挂载点（实现时）

- 新模块建议：`packages/soulmate-bili/vision-summary.mjs`（选帧、组 prompt、解析分章、格式化 takeaway）。
- ASR 薄客户端：`packages/soulmate-bili/asr-client.mjs`（POST audio/url 或 ffmpeg 抽出的短音轨到用户 endpoint；契约在实现计划里钉死，需兼容一种简单 JSON）。
- `watchAndRecordVideo` / 自主冲浪路径在记记忆前替换 takeaway。
- `composeSurfSummary` / `patchSurfLogActions`：engage 后把动作短语拼进 summary 末尾。

## 测试要点

- 有真帧 + mock 视觉回调 → takeaway 含时间线分章，且不含错位字幕胡话。
- 无 ffmpeg、仅有分镜 → `ok:storyboard`。
- 无帧 / 视觉抛错 → 软降级 + 渠道码。
- 无字幕 + 未配 ASR → 仍可纯画面总结；配了 ASR mock → transcript 进入 prompt。
- engage 点赞后 summary 末尾出现 `｜已点赞`。

## 开放实现细节（计划阶段钉死）

1. 宿主带图消息的具体 payload 形状（`image_url` / base64 / 本地 file URL）。
2. ASR endpoint 请求/响应 JSON 最小契约（输入：音轨 URL 或 multipart；输出：带时间戳 segments）。
3. 超长片抽稀算法：先按 `everySec` 生成时间点，再均匀映射到 ≤16。
