// Poll replies under our own comments and optionally follow up (max N rounds).
import { loadConfig } from '../soulmate-core/state.mjs';
import { patchSurfLogActions } from '../soulmate-core/surf-log.mjs';
import { inRanges, localClock } from '../soulmate-core/proactive.mjs';
import { sanitizeCommentText, decideSurfEngageHeuristic } from './engage.mjs';
import { composeThreadReplyPrompt, parseAuthoredText } from './engage-brain.mjs';
import { biliWriteAction } from './write-actions.mjs';
import { cookieFromCredentials } from './auth/credentials.mjs';
import { readCommentLedger, writeCommentLedger } from './comment-ledger.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function makeClient(options = {}, cookie = '') {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 soulmate-bili/0.2';
  return {
    async api(path, params = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
      const res = await fetchImpl(`https://api.bilibili.com${path}${[...q].length ? `?${q}` : ''}`, {
        headers: {
          'user-agent': UA,
          referer: 'https://www.bilibili.com/',
          ...(cookie ? { cookie } : {}),
        },
      });
      if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
      const body = await res.json();
      if (body.code !== 0) throw new Error(`${path}: ${body.message || body.code}`);
      return body.data ?? body;
    },
  };
}

const ABUSE_RE = /(傻逼|去死|尼玛|操你|滚)/;

function clipReply(s) {
  const t = str(s).trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/**
 * One reply-patrol pass. Returns how many replies were handled.
 */
export async function runAutoReplyPatrol(home, options = {}) {
  const conf = await loadConfig(home);
  const ext = conf.extensions ?? {};
  if (ext.biliWriteEnabled !== true || ext.biliAutoReplyEnabled === false) {
    return { ok: true, ran: false, reason: 'disabled' };
  }
  const tz = num(conf.proactive?.tzOffsetMinutes, 480);
  const clock = localClock(options.nowMs ?? Date.now(), tz);
  if (inRanges(clock.minutes, conf.proactive?.quietHours ?? [])) {
    return { ok: true, ran: false, reason: 'quiet-hours' };
  }

  const maxRounds = Math.min(5, Math.max(1, Math.floor(num(ext.biliAutoReplyMaxRounds, 2))));
  const maxChars = Math.min(500, Math.max(10, Math.floor(num(ext.biliCommentMaxChars, 80))));
  const ledger = await readCommentLedger(home);
  const open = ledger.threads.filter((t) => !t.closed && num(t.rounds) < maxRounds);
  if (!open.length) return { ok: true, ran: false, reason: 'none' };

  const cookie = await cookieFromCredentials(home);
  const client = makeClient(options, cookie);
  let handled = 0;

  for (const thread of open.slice(0, 3)) {
    if (!thread.aid && !thread.bvid) continue;
    let replies = [];
    try {
      const oid = thread.aid;
      if (!oid) continue;
      const data = await client.api('/x/v2/reply/reply', {
        type: 1,
        oid,
        root: thread.root || thread.rpid,
        ps: 10,
        pn: 1,
      });
      const list = Array.isArray(data?.replies) ? data.replies : [];
      replies = list.map((r) => ({
        rpid: str(r?.rpid),
        message: str(r?.content?.message),
        mid: str(r?.member?.mid),
      })).filter((r) => r.rpid && r.message);
    } catch {
      continue;
    }

    const seen = new Set((thread.seenReplyIds || []).map(str));
    const fresh = replies.filter((r) => !seen.has(r.rpid));
    if (!fresh.length) continue;

    for (const reply of fresh.slice(0, 1)) {
      seen.add(reply.rpid);
      if (ABUSE_RE.test(reply.message)) {
        thread.closed = true;
        thread.closeReason = 'abuse';
        break;
      }

      const plan = decideSurfEngageHeuristic({
        digest: { worthScore: 12, title: thread.bvid },
        persona: conf.persona,
      });
      if (!plan.comment && num(conf.persona?.traits?.talkative, 50) < 40) {
        thread.closed = true;
        thread.closeReason = 'not-in-mood';
        break;
      }

      // Author the reply in character, actually reading what they said. The old
      // regex-templates ("谢谢→不客气～") ignored the content entirely; LLM first,
      // template only as a soft fallback when no authoring channel exists.
      let text = '';
      if (ext.biliEngageLlmEnabled !== false && typeof options.authorReply === 'function') {
        try {
          const prompt = composeThreadReplyPrompt({
            threadTitle: thread.title || thread.bvid,
            theirReply: reply.message,
            myComment: thread.commentText || '',
            persona: conf.persona,
            voice: typeof options.voiceOf === 'function' ? options.voiceOf(conf.persona) : '',
            maxChars,
            round: num(thread.rounds) + 1,
            maxRounds,
          });
          const raw = await options.authorReply({ prompt, kind: 'engage-llm' });
          const parsed = parseAuthoredText(raw, { maxChars });
          if (!parsed.ok) {
            thread.closed = true;
            thread.closeReason = parsed.reason === 'declined' ? 'she-declined' : parsed.reason;
            break;
          }
          text = parsed.text;
        } catch {
          // fall through to template
        }
      }
      if (!text) {
        text = plan.commentText || '嗯，看到了。';
        if (/谢谢|感谢/.test(reply.message)) text = '不客气～';
        else if (reply.message.length < 40) text = clipReply(`收到啦`);
      }
      const scrub = sanitizeCommentText(text, maxChars);
      if (!scrub.ok) {
        thread.closed = true;
        thread.closeReason = scrub.reason;
        break;
      }

      const res = await biliWriteAction(home, {
        action: 'comment',
        bvid: thread.bvid,
        message: scrub.text,
        parent: reply.rpid,
        root: thread.root || thread.rpid,
      }, options);

      if (res?.ok) {
        thread.rounds = num(thread.rounds) + 1;
        handled += 1;
        await patchSurfLogActions(home, {
          platform: 'bilibili',
          videoId: thread.bvid,
          replies: [{
            at: new Date().toISOString(),
            toId: reply.rpid,
            text: scrub.text,
            round: thread.rounds,
          }],
        }).catch(() => {});
        if (thread.rounds >= maxRounds) thread.closed = true;
      }
      break;
    }
    thread.seenReplyIds = [...seen].slice(-40);
  }

  await writeCommentLedger(home, ledger);
  return { ok: true, ran: handled > 0, handled };
}
