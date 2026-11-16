# 桌宠冬装 coat 纯白修复（2026-11-16）

> 本文取代被并行会话删除的 `pet-video-production.md` 中与颜色/键控相关的部分。
> 视频生产总流程仍以 `output/pet-video-winterboy/` 下脚本为准。

## 症状
Q版冬装男孩的 webm / GIF 预览中外套发品红（pink/magenta），用户要求纯白。
源 firstframe PNG 与 raw 绿幕视频本身只是暖白（cream），并不粉。

## 根因（像素级实测，raw/pet-wave.mp4 第 0 帧）
| 处理链 | coat 近白均值 RGB | 品红像素数 |
|---|---|---|
| 无滤镜 | (237.4, 229.7, 228.2) | 2312 |
| chromakey=0x00FF00:0.20:0.10 | (237.5, 229.7, 228.3) | 2312 |
| chromakey + despill=type=green:mix=0.5:expand=0.15 | (238.8, 216.4, 229.4) | 33941 |

`despill=green` 在暖白像素上把 G 通道削低 ~13（B 反超 G）→ 品红。
chromakey 只改 alpha 不改色；GIF 由 webm 生成，忠实继承品红。

## 修复管线（rewhite.mjs）
1. 解码 raw mp4：`chromakey=0x00FF00:0.20:0.10,scale=640:360:flags=lanczos,format=rgba`（**去掉 despill**）。
2. 逐像素：
   - 绿 spill 抑制：仅当 G 严格主导且 (a<250 或 min>150)：g = max(r,b) + (g-max(r,b))*0.35（保护饱和绿色道具与肤色/橙背带/蓝发）。
   - 选择性提白：min>=165 且 S=(max-min)/max<=0.16 时，权重 w=min(1,(min-165)/45)*min(1,(0.16-S)/0.08)，
     目标 L'=255-(255-L)*0.35（L 为亮度），向 (L',L',L') 混合 w。coat → ~(244,241,240) 纯白观感。
3. 按状态结构组帧（@24fps，raw 共 121 帧）：
   - boom（正放+精确反放，无缝循环）：idle/sleep/think/drag start=24 len=48；sit 0/63；eureka 0/29；wave/heart/pout 0/72；happy/eat/game/ski/run 0/60。
   - walk：0..109 + 冻结第 109 帧 ×11（tail hold）。
4. 编码：libvpx-vp9 yuva420p crf30 b:v0 auto-alt-ref0 deadline good cpu-used4（与原一致）。
5. PNG 回退：15 张静态 PNG 原位提白；eat/game/ski/run 由新 webm 第 0 帧经 fallback.mjs 重建。
6. GIF：gifmake-all.mjs（15 状态，checker 底 + palettegen diff + bayer）。

## 验证
- verify.mjs：15/15 hasAlpha=true、四角 alpha=0；boom 接缝 <=0.08
  （wave/heart/pout ~5.5 为 vp9 反放半段预测噪声，与旧版同量级；这些状态实际播放 <1s 即切走）。
- coat 品红像素：每帧数千 → ~80；均值 (238,229,229) → (244,241,240)。
- 测试门禁：node --test（见仓库 test/）。

## 同步与备份
- 仓库 assets/pet-winterboy-chibi/（35 文件）与已安装
  `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-plugin-whale-soulmate\assets\pet-winterboy-chibi\` 已覆盖。
- 旧品红版本备份：`output/pet-video-winterboy/backup-pink-webm/`、`backup-pink-png/`。
- 复跑：`node output/pet-video-winterboy/rewhite.mjs [state...]` → verify.mjs → fallback.mjs → gifmake-all.mjs → 复制 assets。

## 坑
- ffprobe.exe 缺失：尺寸/时长用 `ffmpeg -i` stderr 解析。
- node_repl 禁止 import node:process；跑 .mjs 用 exec_command `node`。
- 并行会话在迭代 0.2.7x→0.2.8x：不要 stash/reset、不要主动 npm pack；assets 是共享真相源，下次 pack 自动带上。
