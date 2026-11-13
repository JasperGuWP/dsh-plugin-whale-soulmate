// Three hard red lines from the companion architecture diagram.
// These are assertions shared by tools and HTTP — never soft-fail.

/** Engine must never write persona traits directly (edge ⑥ only via submission gate). */
export function assertNoEnginePersonaWrite(source) {
  if (source === 'engine' || source === 'tool' || source === 'model') {
    throw new Error(
      '[soulmate:redline] 引擎 → 人格 不允许直连。模型只能写入 candidates.jsonl，经提交门（第 2–3 周）才能改 traits。'
    );
  }
}

/** Persona must never grant itself permissions / sandbox rights. */
export function assertNoPersonaPermissionGrant(patch) {
  if (!patch || typeof patch !== 'object') return;
  const forbidden = ['permissions', 'sandbox', 'tools', 'allowTools', 'dangerFullAccess', 'capability'];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      throw new Error(`[soulmate:redline] 人格 → 权限 不允许。字段 "${key}" 不能由人格层写入。`);
    }
  }
}

/**
 * Time must enter the status layer as numbers — never as a model "feeling".
 * @returns {{ nowMs: number, absoluteIso: string, relativeHours: number, decay: number }}
 */
export function assertNumericTime(nowMs, lastContactAt) {
  const n = Number(nowMs);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('[soulmate:redline] 时间 → 引擎 不允许「体会」。nowMs 必须是有限正数。');
  }
  const last = typeof lastContactAt === 'string' && lastContactAt ? Date.parse(lastContactAt) : NaN;
  const relativeMs = Number.isFinite(last) ? Math.max(0, n - last) : 0;
  const relativeHours = relativeMs / 3_600_000;
  // Soft exponential decay over ~14 days of silence (display-only).
  const decay = Number.isFinite(last) ? Math.exp(-relativeHours / (14 * 24)) : 1;
  return {
    nowMs: n,
    absoluteIso: new Date(n).toISOString(),
    relativeHours: Math.round(relativeHours * 100) / 100,
    decay: Math.round(decay * 1000) / 1000,
  };
}
