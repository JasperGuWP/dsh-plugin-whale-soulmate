# 桌宠交互视频规则（Pet Interaction Video Rules）

> 适用皮肤：`winterboy-chibi`（Q版冬装男孩）、`hanfu`（汉风襦裙）。
> 两套皮肤共用同一状态机与同一份规则，仅 `pet.json` 的帧/视频资源与配色不同。
> 数据源：`assets/<skin>/pet.json` + `packages/soulmate-home/pet-machine.mjs` +
> `packages/soulmate-core/video-cues.mjs` + `browser/pet-video.mjs` / `pet-drag.mjs` / `pet-hit.mjs` / `widget.mjs`。
> 视频规格：640×360、24fps、VP9 **yuva420p 真透明通道**（webm）；WebKit 另备 HEVC-alpha `.mov`（当前未发货）。

---

## 一、状态总表（状态 / 触发 / 时长 / 模式 / 结束去向）

时长 = 成品 webm 实际播放时长（24fps）。模式：`loop`=无缝循环；`once`=单次播完由 `ended` 推进。

| 状态 | 中文 | 触发 | 时长 | 模式 | 结束去向 |
|---|---|---|---|---|---|
| idle | 无所事事 | 默认 / 各状态回落 | 4.00s | loop |  dwell 2.4–4s 后按权重随机 |
| sit | 坐下悠闲 | idle 随机（权重 0.25） | 5.25s | loop | dwell 3–6s → idle |
| sleep | 睡觉 | 连续无交互 300s（idle/sit） | 4.00s | loop | 点击唤醒 → happy |
| think | 思考（hanfu：托腮偏头、无气泡问号） | 外部事件（宿主开始回答） | 4.00s | loop | eureka / 其它事件；安全上限 120s → idle |
| eureka | 灵机一动 | 外部事件（回答落地） | 2.42s | once | holdSec 1.2 → idle |
| wave | 打招呼 | 单击 click | 6.00s | once | → idle |
| happy | 高兴 | 双击 dblclick / 拖拽松手 / 睡眠唤醒 | 5.00s | once | → idle |
| drag | 被拖拽 | pointerdown 且位移 >6px | 4.00s | loop | 松手 dragEnd → happy |
| heart | 爱心（hanfu：脸红害羞、无爱心飞出） | idle 随机（权重 0.12） | 6.00s | once | → idle |
| pout | 撅嘴生气（hanfu：女孩叉腰鼓颊跺脚、无生气符号） | idle 随机（权重 0.08） | 6.00s | once | → idle |
| eat | 吃饭 | idle 随机（权重 0.08） | 5.00s | once | → idle |
| game | 玩游戏 | idle 随机（权重 0.08） | 5.00s | once | → idle |
| ski / dance | 滑雪（winterboy）/ 汉风舞（hanfu） | idle 随机（权重 0.05） | 5.00s | once | → idle |
| run | 跑步 | idle 随机（权重 0.07） | 5.00s | once | → idle |
| walk | 走路 | 外部事件（移动） | 5.04s | once | → idle（含起止静止段） |

idle 随机权重合计 0.73，其余 0.27 回落 idle（`pickNextState` 滚轮未命中即 idle）。

---

## 二、播放模式判定（once vs loop）

`isOnceState(st)`（video-cues.mjs，浏览器 pet-video.mjs 镜像同一逻辑）：
1. `video.once === true/false` 显式优先；
2. 否则 `holdSec != null && dwellSec == null` → once；
3. 其余（有 dwellSec 或无 holdSec）→ loop。

- **loop 状态**：`<video loop>` 循环播放，忽略 `ended`；由状态机 dwell 计时切换。
- **once 状态**：不 loop，播到 `ended` 触发 `endedCue` → `pickNextState(st.next)` 推进；
  另有 **watchdog = holdSec + 10s** 兜底（视频卡死/未触发 ended 时强制推进），避免卡帧。
- walk 虽为 once，但含 **leadSec 0.6 / tailSec 0.5** 起止静止段，配合位移 lead/tail 对齐。

## 三、无缝循环与镜像

- loop 段采用 **boom 结构**（正放 + 精确倒放）保证首尾帧一致、无缝循环；
  idle/sleep/think/drag 取 raw 第 24 帧起 48 帧 boom；sit 0/63；eureka 0/29；wave/heart/pout 0/72；happy/eat/game/run 与 ski(winterboy)/dance(hanfu) 0/60。
- walk 为 0..109 正放 + 第 109 帧冻结 ×11（tail _hold），**不倒放**。
- **walk 朝向**：跟随位移方向（target > start → 镜像 `mirrorForRight`），覆盖状态机随机朝向；
  镜像用 CSS `scaleX(-1)`，**不倒放视频**。其余状态不镜像。
- 校验：loop 状态首尾帧 seamDiff≈0（verify.mjs）；once 状态首尾差异属正常（不倒放）。

## 四、点击 / 双击 / 拖拽（必须播视频，不用 PNG 交互）

- **命中盒**：16:9 stage + hit 元素；`pet-hit.mjs` 做 **alpha 命中测试**（ALPHA_MIN=16）：
  优先采样当前 **视频** 帧 alpha，透明像素 = 点击穿透（不挡下层页面）；视频不可读才采样 PNG。
- **单击**：hit `click` → 280ms 定时器 → `petGesture('tap')` → `petEvent('click')` → **wave 视频**。
  280ms 内若来了 dblclick 则取消单击定时器（避免先 wave 再 happy）。
- **双击**：hit `dblclick` → 取消单击定时器 → `petEvent('dblclick')` → **happy 视频**。
- **拖拽**：`pet-drag.mjs` pointerdown 记录起点；`Math.hypot(dx,dy) > 6` 才判定为拖拽
  （`dragMoved=true`、`setSwallow(true)`、`onDragStart` → **drag 循环视频**）；
  pointerup → `onDragEnd` → **happy 视频**，并 **swallow 该 pointer 序列合成的 click**
  （只吞这一次合成 click，不吞下一次真实 tap），避免拖完又误触 wave。
- **结论**：点击 / 双击 / 拖拽 / 松手全部走 **透明视频**；PNG 仅作为「无视频回退」与 idle 眨眼帧，
  不参与交互动画（修复早期「拖拽抖动 / 点击用 PNG」问题：抖动=缺 drag 视频，已补 drag 循环段）。

## 五、优先级与打断

事件优先于 dwell 计时（`pet-machine.event` 立即 enter）：
1. `dragStart` 最高：进入 drag 并置 dragging，update 期间冻结自动切换；
2. `dragEnd` → happy；
3. `walk / think / eureka` 外部事件直接 enter；
4. sleep 中任何事件 → 唤醒 happy；
5. click → wave；dblclick → happy。
- dragging 期间 `update()` 直接 return（不自动切状态），松手才恢复。
- think 不被 dwell 结束，只被 eureka / 其它事件 / 120s 安全上限结束。
- sleep 不被 dwell 结束，只被事件唤醒。

## 六、冷却 /  dwell / 随机

- idle dwell 2.4–4s 均匀随机；sit dwell 3–6s；到时按 `next` 权重滚轮选下一状态。
- idle 眨眼：进入 idle 后 1.2–3.8s 触发 blink 帧 0.12s，之后 1.5–4.1s 再眨（仅 PNG 回退层；视频层自带眨眼）。
- 无显式全局冷却；靠 dwell + once 时长天然节流（wave/happy/heart/pout 6s、eat/game/ski/run 5s）。
- 睡眠进入：idle/sit 且 `t - lastAct >= sleepAfterIdleSec(300)` → sleep；任何交互重置 lastAct。

## 七、透明通道与回退链

- 首选 **webm(VP9 alpha)**；`prefersMov(ua)` 判定 WebKit（iPhone/iPad/含触控的 Mac）→ 需 `.mov`(HEVC-alpha)。
  WebKit 无 .mov 时 **停留 PNG，绝不回退 webm**（Safari 解 VP9 丢 alpha 会黑块）。
- 无视频 / 视频未发货 → PNG 帧轮播（walk/think 按 fps，idle 眨眼）。
- manifest 只把**实际存在**的 webm/mov 写入 videoUrls/videoMovUrls（带 mtime+size cache-bust），浏览器不会请求 404。
- 校验透明：必须用 `-c:v libvpx-vp9` 解码（FFmpeg 原生 VP9 解码器忽略 alpha side-data，会误判不透明）。

## 八、皮肤差异

- 两皮肤 `pet.json` schema 一致（15 状态、同权重、同 dwell/hold/trigger）；hanfu 以 `dance`（汉风舞）替换 `ski` 状态，资源名 pet-dance。
- 仅资源不同：winterboy 白外套需「选择性增白」；hanfu 彩色襦裙**只做 chromakey + 去绿溢，不增白**。
- hanfu 团扇为固定持物：单手动作用左手、双手动作团扇贴胸前/前臂、末帧回右手胸前（见 prompts-hanfu.json）。
- hanfu 情绪表达约定（第二轮 prompts-hanfu2.json）：pout=女孩叉腰鼓颊跺脚别脸、无生气符号；heart=双颊晕红+双手交握害羞、无爱心粒子飞出；think=托腮偏头眼神点指、无气泡/问号漂浮符号。
