# B 站冲浪自动互动 +「冲浪」分列 Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax. Do **not** git commit unless the user asks.

**Goal:** 侧栏「冲浪」按平台分列（B 站实装 / 抖音占位）；定时看片后按性格自动赞/藏/评/关注；跟帖最多 3 轮；冲浪日志可看截图、链接、总结与站内动作。

**Architecture:** UI 新 Tab `surf` + 平台二级条；日志按 `surf-log-<platform>.jsonl` 隔离；看片成功后短决策 → `biliWriteAction`；proactive tick 轮询评论账本跟帖。规范：本地硬过滤 + 决策提示词。

**Tech Stack:** Cordis/dsh plugin, browser CJS modules → `client.js` build, soulmate-core ESM routes/runtime, soulmate-bili write-actions.

**Spec:** `docs/superpowers/specs/2026-11-16-bili-surf-engage-design.md`

## Global Constraints

- 本迭代不实现抖音 API（仅占位）
- 不自动投币/私信/弹幕/改资料/开播/投稿
- 尊重 quietHours；写操作受 `biliWriteEnabled` + 日配额
- 配置继续 `extensions.bili*` 前缀
- 版本递增；tar-overlay desktop；中文交付

## File map

| 文件 | 职责 |
|---|---|
| `browser/panel-surf.mjs` | 冲浪 Tab：平台条、B 站列、抖音占位、日志列表 |
| `browser/panel-forms.mjs` | 导出 `autoSurfSection`；rhythm 去掉 bili |
| `browser/panel.mjs` | 注册 `surf` tab |
| `browser/panel-bili.mjs` | 登录卡（可加自动互动开关区或由 panel-surf 组合） |
| `packages/soulmate-core/surf-log.mjs` | 读写 jsonl、migrate 旧文件 |
| `packages/soulmate-core/routes/surf-routes.mjs` | `GET .../surf-log` |
| `packages/soulmate-core/state.mjs` | 新 extensions 默认键 |
| `packages/soulmate-bili/engage.mjs` | 短决策 + 执行 + 规范校验 |
| `packages/soulmate-bili/write-actions.mjs` | comment 支持 parent/root |
| `packages/soulmate-bili/index.mjs` | watch 后挂 engage + 写日志 |
| `packages/soulmate-core/runtime/proactive-runtime.mjs` | 跟帖轮询 |
| `test/surf-*.test.mjs` | 日志 / 规范 / engage plan |

---

### Task 1: 冲浪 Tab + 平台分列 + 迁入 B 站块

**Files:** Create `browser/panel-surf.mjs`; Modify `panel-forms.mjs`, `panel.mjs`, `state.mjs`

- [ ] 导出 `autoSurfSection`；`rhythmCard` 移除 `BiliAuth` 与 `autoSurfSection`
- [ ] `panel-surf.mjs`：平台条 bilibili | douyin；bilibili 列渲染 auth + autosurf + engage 开关占位；douyin 占位文案
- [ ] `panel.mjs` 增加 tab `surf`
- [ ] 默认配置增加 `biliAutoEngageEnabled` / `biliAutoReplyEnabled` / `biliAutoReplyMaxRounds` / `biliFollowDedupDays`
- [ ] build；手动确认作息页无 B 站块

### Task 2: surf-log 存储 + API + 卡片 UI

**Files:** Create `surf-log.mjs`, `routes/surf-routes.mjs`; Modify routes index, watch path, panel-surf

- [ ] `appendSurfLog` / `listSurfLog` / migrate `bili-surf-log.jsonl`
- [ ] `GET /dsh-soulmate/api/surf-log?platform=&filter=&limit=`
- [ ] 看片成功后追加一条（actions 可先未互动）
- [ ] 冲浪页拉取并渲染卡片（封面、链接、总结、actions）
- [ ] 测试 list/filter/platform 隔离

### Task 3: 短决策 + 赞藏评关

**Files:** Create `engage.mjs`; Modify bili index / prompt host

- [ ] `sanitizeCommentText` 规范过滤单测
- [ ] `decideSurfEngage`（可先规则+可选 LLM hook；有 session 则短 prompt）
- [ ] `executeSurfEngage` → like/favorite/comment/follow；关注去重 7 天
- [ ] 写入日志 `actions`
- [ ] write 关闭时不调用写站

### Task 4: 跟帖 2–3 轮

**Files:** Modify write-actions, engage/ledger, proactive-runtime

- [ ] comment 支持 `parent` / `root`
- [ ] 评论账本 + tick 轮询回复
- [ ] 最多 3 轮；辱骂关楼
- [ ] patch 日志 `replies`

### Task 5: 打包安装

- [ ] bump version、build、test、tar-overlay desktop
- [ ] 记录 memory / hindsight

---

**Execution note:** Prefer implementing Task 1→2 as first shippable slice, then 3→4.
