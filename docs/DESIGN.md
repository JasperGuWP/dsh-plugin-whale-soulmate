# Design Overview / 设计概览

> Package: `dsh-plugin-whale-soulmate` · Form: **DSH Bundle** (node + browser)  
> 详细实现以源码为准；本文只保留对外可读的架构与产品设计。

---

## 中文

### 1. 定位

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**模块化 AI 小伙伴**：

- 人设 × 情绪 × 关系养成
- **LLM Wiki** 混合记忆（事实 / Wiki / 日记）
- **五道隐私防线**（默认纯本地）
- 右下角透明视频桌宠 + `/soulmate-home` 双模 3D 空间
- 可选 AIGC 云同步与动态云端能力
- 同时是办公 / 编程副驾（不遮蔽 DSH 任何内置工具）

明确**不做**「又一个只会刷 B 站的缝合怪」：B 站 / IM 是可插拔扩展，记忆与陪伴才是内核。

### 2. 形态与装配

| 半侧 | 入口 | 职责 |
|---|---|---|
| Node | `index.js` → `packages/soulmate-core` | Cordis `apply(ctx)`：工具、systemPrompt、HTTP、主动调度、`ctx.soulmate` 服务 |
| Browser | `browser/*` → `npm run build:client` → `client.js` | 悬浮桌宠、设置面板、聊天卡片、3D 家园浮层 |
| Patch | `cordis.patch.yml` | Bundle / `--patch` 挂载声明 |

设计铁律：

1. **可逆副作用**：注册一律经 `ctx.effect` / `ctx.on` / `ctx.tools.register`，卸载即净。
2. **可选依赖**：`webServer`、`dshHomePath`、`sessionController` 用 `ctx.get()`，缺失则降级。
3. **配置外置、响亮失败**：非法配置在 `apply` 时抛错。
4. **零脆弱 peer**：内联 `defineTool` + JSON Schema 编译，避免桌面 profile 静默不激活。
5. **tarball 不含 `browser/`**：只带构建产物 `client.js`，防止宿主二次注册。

### 3. 模块地图

```
packages/
  soulmate-core/     # 记忆 / 人设 / 隐私 / 主动调度 / 云网关 / 路由 / 工具
  soulmate-home/     # 桌宠状态机 + 3D 家园页
  soulmate-bili/     # B 站理解与风控写操作（扩展）
  soulmate-im/       # 微信 / QQ / 飞书 / 钉钉分身（扩展）
assets/
  pet-winterboy-chibi/   # 默认桌宠皮肤（PNG + VP9-alpha WebM）
browser/             # 前端源模块（改这里再 build）
```

### 4. 记忆设计（LLM Wiki + 事实神经元）

| 层 | 内容 | 落点 |
|---|---|---|
| Facts | 带 salience / energy / 半衰期的原子事实 | `memory/facts/`，私密 → `memory/private/` |
| Wiki | 反思蒸馏的主题页，`[[slug]]` 互链 | `memory/wiki/` |
| Episodes | 公开信 / 私密小本本 | `memory/episodes/` |

生命周期：**Retain → Recall → Reflect → Invalidate**。

陪伴式增强：在场摘要、承诺状态机、冲突挂起裁决、`decayClass` 语义遗忘、temporal 时间窗召回、强化仅计对话内召回。

### 5. 隐私五道防线

1. 默认 `cloud.consentGiven = false`，零外网  
2. 私密记忆物理目录隔离，永不进同步包  
3. 出站 `inspectAndScrub`：密钥硬拦截，路径 / PII 脱敏  
4. 可选 PBKDF2 + AES-256-GCM 端到端加密  
5. 本地 `privacy-audit.jsonl` 透明账本 + 一键销毁云端

### 6. 桌宠与主动开口

- 皮肤：`assets/pet-winterboy-chibi`（idle / think / eureka / walk / sleep / …）  
- 透明像素 hit-test：只有角色不透明区域可点拖  
- 主动调度：本地生物钟闸（早安 / 催饭 / 晚间 / 催睡 / sulking），投专属 soulmate 会话  
- 夜间做梦蒸馏 Wiki；窗满交接蒸馏；每周提交门写 `traits.yaml`

### 7. 双轨副驾

- **干活轨**：完整使用 DSH 工具链  
- **人设轨**：语气保持角色；`driftAnchor` 经 runtime context 贴历史尾部防漂移

---

## English

### 1. Positioning

A **modular AI companion** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- Persona × mood × relationship growth
- **LLM Wiki** hybrid memory (facts / wiki / diaries)
- **Five privacy layers** (local-first by default)
- Transparent video desktop pet + dual-mode `/soulmate-home` 3D space
- Optional AIGC cloud sync & dynamic cloud capabilities
- Full co-pilot: never masks built-in DSH tools

Bilibili / IM are **pluggable extensions**; memory and companionship are the core.

### 2. Shape

Dual-face **Bundle**: node half (`index.js`) + browser half (`client.js` built from `browser/`).  
Cordis module with reversible effects, optional `ctx.get()` deps, fail-loud config, and an inlined `defineTool` so desktop profiles do not silently skip activation. Packed tarballs must **not** include `browser/` sources.

### 3. Memory

Facts / Wiki / Episodes with Retain → Recall → Reflect → Invalidate.  
Companion extras: presence digest, promise FSM, conflict hold/resolve, semantic `decayClass` decay, temporal recall, reinforce-only-on-dialog-recall.

### 4. Privacy

Local-first consent gate · private directory isolation · outbound scrub · optional E2EE · audit ledger.

### 5. Pet & proactive

Winter-boy chibi VP9-alpha skin · alpha hit-testing · local proactive gate into a dedicated chat home · night dream distill · weekly submission gate.

### 6. Dual-track co-pilot

Work track uses all host tools; persona track keeps voice; drift-anchor re-pins tone at the history tail.
