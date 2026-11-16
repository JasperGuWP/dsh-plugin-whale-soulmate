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

- **硬约束：所有视频（loop 与 once）首帧 == 末帧**（详见第十节）。
- **方向性 / 位移状态禁止倒放**：run（两皮肤）/ ski(winterboy) / dance(hanfu) / drag（两皮肤）用**纯正向循环**——
  run 取步态窗硬拼或环绕淡化（winterboy raw[28,58)×4=120+1；hanfu 周期弱，取环绕窗 [34,59)×5 份、份间 3 帧 alpha 感知交叉淡化=113+1）；
  ski/dance 取运动窗 + 2–3 帧环绕交叉淡化；drag 取 3 帧环绕淡化无缝循环 ×2（109 帧）。
  倒放半段会造成「倒着跑 / 拖拽抖动」，故方向性动作绝不回文。
- **原地振荡 / 呼吸类状态保留 boom**（正放 + 精确倒放）：idle/sleep/think/sit/eureka/wave/heart/pout/happy/eat/game。
  这些动作左右对称，倒放半段视觉自然，且 boom 天然首尾一致。
  窗口：idle/sleep/think raw 第 24 帧起 48 帧 boom；sit 0/63；eureka 0/29；wave/heart/pout 0/72；happy/eat/game 0/60。
- walk 为 0..109 正放 + 第 109 帧冻结 ×11（tail_hold），**不倒放**；末尾追加首帧满足首末一致（122 帧）。
- **walk 朝向**：跟随位移方向（target > start → 镜像 `mirrorForRight`），覆盖状态机随机朝向；
  镜像用 CSS `scaleX(-1)`，**不倒放视频**。其余状态不镜像。
- 校验：`output/pet-firstlast-audit.cjs` 逐视频解码首/末帧算不透明像素平均 RGB 差，30 个全部 ≤0.09（重建者多为 0.00）；
  方向性状态另用 palinPSNR<30 确认无倒放半段（`output/pet-boom-fix/check-palin.cjs`）。

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

## 九、性别联动默认形象（v0.2.85）

- 选定性别后的默认立绘：女 = `assets/pet-hanfu/pet-drag.png`（GET /api/sprite）、男 = `assets/pet-winterboy-chibi/pet-drag.png`（GET /api/sprite-male），均为拖拽姿势透明 PNG。
- 桌面小伙伴皮肤自动跟随性别（`GENDER_PET_SKIN`：female=hanfu、male=winterboy-chibi）。`pet.skinAuto` 默认 true；onboard / 面板切换性别立即换皮肤。
- 面板手动选皮肤会写入 `skinAuto:false`，此后固定不跟随；再次切换性别会重新建立联动（skinAuto:true）。
- 启动时 bootstrap 自动修正历史错配：skinAuto≠false 时把皮肤对齐到性别，并把与性别不符的默认立绘 URL 重置（自定义上传不受影响）。
- config POST 兜底：patch.pet.skin 存在且 skinAuto≠false 时强制对齐当前性别，防旧草稿回写错误皮肤。

## 十、首末帧一致硬约束（2026-11-16）

- **规则：不管做什么动作，视频第一帧与最后一帧必须一致**（用户硬约束）。30 个 webm（2 皮肤 ×15 状态）审计全部 ≤0.09；
  fix4/5/6/7 重建的 14 个中 12 个达像素级 0.00（ski/dance 为环绕淡化 ≤0.09）。
- 背景：原 boom 回文（正放+倒放拼接）使方向性动作的倒放半段「倒着跑 / 拖拽抖动」。
  fix4 把 winterboy run/ski、hanfu dance、两皮肤 drag 改纯正向循环（从 backup 正放 raw 解码、Node 精确拼帧，保留 alpha 与白外套，**不重新 chromakey**）。
  fix7 补 hanfu run（原遗漏，palinPSNR 44→18.6）：环绕窗 [34,59)×5、3 帧交叉淡化、114 帧。
- fix5：为满足首==末，对近循环视频末尾追加首帧（run/drag/walk/heart/pout/wave 两皮肤 + ski/dance 先环绕淡化再追加），共 13 个。
- fix6：半透明光晕 VP9 量化使 heart/pout/wave 首末差 0.03–0.09 → 编码前**把首帧 raw 字节覆盖到末帧** +
  `-force_key_frames <(N-1)/24>` 末帧强制关键帧 → 0.00。fix7 同样套用。
- 最终帧数：winterboy run121/ski102/drag109/walk122/heart·pout·wave145；hanfu run114/dance97/drag109/walk122/heart·pout·wave145；其余振荡类不变。
- 编码：`-c:v libvpx-vp9 -pix_fmt yuva420p -crf 30 -b:v 0 -auto-alt-ref 0 -deadline good -cpu-used 4 -an`；
  force_key_frames 用时间串 (N-1)/24，**勿用** expr:eq(n,..)（逗号转义报错）。
- 脚本：`output/pet-boom-fix{4,5,6,7}.cjs`、`pet-firstlast-audit.cjs`、`pet-boom-fix/check-palin.cjs`、`pet-boom-fix/smoke-boom.mjs`；正放备份 `output/pet-boom-fix/backup/`。
- 资产-only 改动：无需 client 重建、无需重启 dsh；manifest cache-bust(mtime+size) 自动失效，刷新页面即生效。
- 冒烟 94/94：30 webm 仓库↔installed 哈希一致、manifest videoUrls 覆盖 15 状态、cache-bust 与安装文件 mtime+size 匹配、/pet/video 200 字节相等。
