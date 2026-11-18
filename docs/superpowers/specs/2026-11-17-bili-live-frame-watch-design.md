# B 站轻量「真看」：播流抽帧（可选）

日期：2026-11-17  
项目：`dsh-plugin-whale-soulmate`  
状态：已确认并实现（0.2.109）

## 背景

当前看片是六通道消化（元数据 / 字幕 / videoshot 分镜 / 弹幕 / 热评 / 打分），**不拉播放流、不用 ffmpeg**。用户希望在开启时能更接近「真实看过」：从 B 站取流后在本地抽若干真实帧，并入摘要与冲浪日志。

## 用户决策

| 项 | 选择 |
|---|---|
| 档位 | 轻量真看（抽帧，不存整片、不做 ASR） |
| ffmpeg | **B**：无 ffmpeg 时面板提示安装；不硬抽帧，回退现有分镜 |
| 默认 | 关闭（需显式开启） |
| 登录 | 仅已登录 B 站时允许真看 |
| 抽帧密度 | **给用户选择**；最密为 **每 15 秒一帧**（不可更密） |

## 目标

1. 新增开关 `extensions.biliLiveFrameWatch`（默认 `false`）。
2. 新增密度配置 `extensions.biliLiveFrameEverySec`（秒/帧），面板可选，**钳制在 `[15, 120]`**（最密 15s，最疏 120s）；默认建议 `30`。
3. 开启且已登录且本机可调用 `ffmpeg` 时：对每个消化中的视频  
   - WBI `playurl` 取流（优先较低清晰度，如 64/32/16）  
   - 按用户所选间隔抽帧：`frameCount ≈ ceil(durationSec / everySec)`，另设安全上限 **240 帧/片**（防超长片打满磁盘；达上限时在 coverage 注明「已按上限截断」）  
   - 帧写入 soulmate 本地缓存目录（不进 git / 不进 tarball）  
   - 并入 digest：`coverage.liveFrames`、冲浪 stills、`howIWatched` 诚实报告（含间隔与是否截断）  
4. 无 ffmpeg / 未登录 / 取流失败：不中断看片；`coverage` 标明原因；面板展示安装/登录提示。
5. 与「认真看完」正交：deepWatch 仍管字幕/分镜密度；真看是额外画面通道。

## 非目标

- 不捆绑 ffmpeg 二进制进插件包。
- 不做音轨 ASR、不本地保存完整视频文件。
- 不绕过大会员/付费墙；拿不到流就降级。
- 不对外转发 playurl；地址仅进程内短时使用。

## 方案对比（已选）

| 方案 | 要点 | 结论 |
|---|---|---|
| A PATH ffmpeg，静默回退 | 无提示 | 否 |
| **B PATH ffmpeg，缺则提示** | 有提示、可回退 | **采用** |
| C 捆绑 ffmpeg | 包体大 | 否 |

## 技术要点

### 检测

- `ffmpeg -version`（或配置的绝对路径）成功 → `ffmpegReady: true`
- API：`GET/POST` 扩展状态或并入 `bili/auth` status：`{ ffmpegReady, liveFrameWatchEnabled, liveFrameWatchBlockedReason }`

### 取流

- `GET /x/player/playurl`（WBI）`bvid + cid + fnval=16`（DASH）或 mp4  
- Header：`Referer: https://www.bilibili.com` + Cookie  
- 选最小可用视频轨；音频可忽略（本迭代不抽声）

### 抽帧

- 间隔 `everySec = clamp(biliLiveFrameEverySec, 15, 120)`（默认 30）  
- 目标帧数 `n = min(240, max(1, ceil(durationSec / everySec)))`  
- 示例：`ffmpeg -y -user_agent … -headers "Referer: …\r\nCookie: …\r\n" -i <url> -vf fps=1/<everySec> -frames:v <n> -q:v 5 out_%02d.jpg`  
- 超时随 `n` 放大（如 `min(600s, 30s + n * 3s)`）→ 软失败  
- 输出：`~/.dsh/soulmate/cache/live-frames/<bvid>/`

### 面板

- 冲浪 / 定时区旁增加勾选：**「真看抽帧（需登录 + 本机 ffmpeg）」**  
- 开启后出现密度滑杆/分档，例如：`每 15 / 20 / 30 / 45 / 60 / 90 / 120 秒一帧`（最左=最密=15s）  
- 未就绪时显示一行提示：未登录 / 未检测到 ffmpeg（可附常见安装说明，不自动下载）  
- 旁注说明：例如「10 分钟片 · 每 15 秒 ≈ 40 帧；每 30 秒 ≈ 20 帧」

### 工具与定时

- `soulmate_video_watch` / surf / auto-surf：若开关开且就绪，在 `digestBiliVideo` 后或并行软通道附加 live frames  
- 关闭或未就绪：行为与 0.2.108 完全一致

## 测试

- mock playurl + 假 ffmpeg 脚本：断言抽帧路径写入 digest  
- 无 ffmpeg：断言降级且 `blockedReason=no-ffmpeg`  
- 未登录：不调用 playurl 抽帧

## 验收

1. 开关默认关；开 + 登录 + 本机有 ffmpeg → 日志/灯箱能看到非 videoshot 的实抽帧（或 coverage 含 liveFrames>0）。  
2. 用户可改抽帧间隔；请求 `<15` 会被钳到 15；面板不提供更密选项。  
3. 关掉 ffmpeg（改名）→ 面板提示；看片仍成功，无 liveFrames。  
4. 包内无 ffmpeg 二进制；`npm pack` 体积不因此暴涨。
