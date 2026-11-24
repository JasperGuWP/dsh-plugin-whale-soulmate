// Tool-result chat-card projection + the shared makeTool wrapper.
// Pure rendering: cardOf never mutates the tool value; makeTool binds the
// per-apply ready gate / error funnel handed in by the assembly.

import { defineTool } from './tool-kit.mjs';
import { clip, errMsg } from './small-utils.mjs';

// Valid JSON Schema: `required` is a top-level array, never a property-level boolean.
// The old shape (`ok: { type:'boolean', required:true }`) is not valid draft-07 and made
// the host's output validator reject every call — the QQ bot surfaced it as
// "ToolOutputError: INVALID_TOOL_OUTPUT" on soulmate_memory_recall.
export const GENERIC_OUTPUT = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
};

export function cardOf(kind, tool, value) {
  const card = { kind, tool, ok: value?.ok !== false };
  if (value?.ok === false) return { ...card, title: '没成功', lines: [clip(value.error ?? value.blockedReason ?? '', 160)] };
  switch (tool) {
    case 'soulmate_memory_recall':
      return {
        ...card,
        title: '🔎 翻小本本',
        lines: [
          ...(value.facts ?? []).slice(0, 3).map((f) => {
            const head = `📌 ${clip(f.topic, 24)}：${clip(f.content, 70)}`;
            return f.evidenceNote ? `${head}\n　 ↳ ${clip(f.evidenceNote, 90)}` : head;
          }),
          ...(value.wiki ?? []).slice(0, 2).map((w) => `📚 ${clip(w.title, 24)}`),
          ...(value.episodes ?? []).slice(0, 2).map((e) => `📔 ${e.date} · ${clip(e.snippet, 60)}`),
        ],
        counts: {
          facts: value.facts?.length ?? 0,
          wiki: value.wiki?.length ?? 0,
          episodes: value.episodes?.length ?? 0,
          traced: value.evidenceCount ?? 0,
        },
      };
    case 'soulmate_memory_retain':
      return {
        ...card,
        title: value.fact ? '🧠 记下一条事实' : '📔 写进日记本',
        lines: [value.fact ? `${clip(value.fact.topic, 30)}：${clip(value.fact.content, 90)}` : `${value.date} · ${value.kind}`],
        private: value.storedIn === 'private' || value.visibility === 'private',
      };
    case 'soulmate_memory_reflect':
      return { ...card, title: '📚 Wiki 更新', lines: [`${value.page?.title ?? ''}（${value.page?.slug ?? ''}）`, clip(value.page?.summary, 90)] };
    case 'soulmate_memory_forget':
      return { ...card, title: '✂️ 突触切除', lines: [`已遗忘 ${value.id ?? ''}`] };
    case 'soulmate_status_interact':
      return {
        ...card,
        title: `${{ feed: '🍚 投喂', pat: '✋ 摸头', tap: '👆 轻触', nuzzle: '🤗 贴贴', chat: '💬 聊天', work_assist: '⚡ 协作', sleep: '🛏 睡觉' }[value.action] ?? '互动'}`,
        lines: [`心情 ${value.state?.mood} · 精力 ${value.state?.energy} · 亲密度 ${value.state?.affinity}（${value.bondStage?.title}）`],
        state: value.state,
        bondStage: value.bondStage,
      };
    case 'soulmate_persona_evolve':
      return {
        ...card,
        title: `🎨 人设 · ${value.mode}`,
        lines: [`${value.persona?.displayName ?? ''} · 称呼你「${value.persona?.callUser ?? ''}」`, value.notebooks?.innerTitle ?? ''],
      };
    case 'soulmate_video_watch':
      return {
        ...card,
        title: value.mode === 'skim'
          ? `👀 扫了一眼 · ${clip(value.title, 30)}`
          : `📺 看完了 · ${clip(value.title, 30)}`,
        lines: [
          `@${value.author} · 评分 ${value.worthScore}/20${value.mode === 'skim' ? ' · 简单看' : ''}`,
          ...(value.highEnergyPeaks ?? []).slice(0, 3).map((p) => `🔥 ${p.label}（${p.count} 条弹幕）`),
        ],
        cover: value.coverUrl,
      };
    case 'soulmate_video_surf':
      if (value.via || value.dryRun) return { ...card, title: '📨 已分享', lines: [`${value.bvid} · via ${value.via} · 今日 ${value.sharedToday}/${value.maxDailyShares}`] };
      return {
        ...card,
        title: '🏄 冲浪一圈',
        lines: [`关键词：${(value.searchedKeywords ?? []).join(' / ')}`, `看了 ${value.pickedCount} 个，跳过已看 ${value.skippedSeenCount} 个`],
      };
    case 'soulmate_bili_manage':
      return {
        ...card,
        title: '📺 B 站登录',
        lines: [
          value.qrcodeKey ? `扫码中 · key ${clip(value.qrcodeKey, 12)}` : value.status ? `扫码状态 ${value.status}` : value.loggedIn ? `已登录 ${value.uname || value.uidMasked || ''}`.trim() : '未登录（无号也可看片）',
        ],
      };
    case 'soulmate_bili_action': {
      const label = {
        dm: '私信', comment: '评论', danmaku: '弹幕', like: '点赞', coin: '投币', favorite: '收藏',
        follow: '关注', profile: '改资料', live_start: '开播', live_stop: '下播', upload: '投稿',
      }[value.action] ?? '写操作';
      return {
        ...card,
        title: value.dryRun ? `📺 B 站${label} · 预览` : value.ok ? `📺 B 站${label}完成` : `📺 B 站${label}未执行`,
        lines: [value.error || value.message || value.title || value.bvid || value.to || ''],
      };
    }
    case 'soulmate_weather':
      return {
        ...card,
        title: `🌤 ${value.city || '天气'}`,
        lines: [clip(value.summary, 160)],
      };
    case 'soulmate_im_send':
      return { ...card, title: `💬 已发到${value.platform ?? ''}`, lines: [`via ${value.via ?? value.mode ?? 'api'}`] };
    case 'soulmate_im_manage':
      return { ...card, title: '💬 跨端分身', lines: [value.status ? `状态：${value.status}` : value.platforms ? Object.entries(value.platforms).map(([k, v]) => `${k}:${v.enabled ? 'on' : 'off'}`).join(' · ') : 'ok'] };
    default:
      return card;
  }
}

/** Shared tool wrapper: generic JSON output + chat card + ready gate + error funnel. */
export function makeToolFactory({ cardKind, ready }) {
  return ({ run, ...def }) =>
    defineTool({
      timeoutMs: 30_000,
      ...def,
      output: {
        schema: GENERIC_OUTPUT,
        render: (_args, value) => {
          // A circular or BigInt payload must not turn into INVALID_TOOL_OUTPUT.
          let text;
          try {
            text = JSON.stringify(value);
          } catch {
            text = JSON.stringify({ ok: value?.ok !== false, note: 'tool result not serializable' });
          }
          return [{ type: 'text', text }];
        },
        presentationMeta: (_args, value) => {
          try {
            return cardOf(cardKind, def.name, value);
          } catch {
            return { kind: cardKind, tool: def.name, ok: value?.ok !== false };
          }
        },
      },
      async execute(args, exec) {
        try {
          await ready;
          const value = await run(args, exec);
          // Always hand the host a plain JSON object with a boolean `ok`, whatever the
          // domain tool returned (undefined, a bare string, or `{ ok }`).
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            return { ok: value.ok !== false, ...value };
          }
          return { ok: true, value };
        } catch (err) {
          return { ok: false, error: errMsg(err) };
        }
      },
    });
}
