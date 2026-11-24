// Weather tool — a keyless, always-available fallback when the host's web search
// provider is down (WEB_PROVIDER_ERROR). Open-Meteo geocoding + forecast; city comes
// from the persona setting or the caller. Pure network, no secrets.

import { loadConfig } from '../state.mjs';
import { clip, errMsg } from '../small-utils.mjs';

const WEATHER_TEXT = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '密集小雨',
  56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};
const wx = (code) => WEATHER_TEXT[Number(code)] || '未知天气';

async function fetchJson(fetchImpl, url) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(12_000) : undefined;
  const res = await fetchImpl(url, signal ? { signal } : undefined);
  if (!res || typeof res.ok !== 'boolean') throw new Error('invalid fetch response');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function weatherTools({ makeTool, home, cfg }) {
  return [
    makeTool({
      name: 'soulmate_weather',
      description:
        '查询当前天气与未来几天预报（Open-Meteo，无需密钥）。默认用设置里的城市；'
        + '宿主 web_search 不可用时也可以用它回答天气问题。',
      parameters: {
        city: { type: 'string', description: '城市名（省略则用设置里的城市）' },
        days: { type: 'number', description: '预报天数 1–3，默认 2' },
      },
      async run(args = {}) {
        const conf = await loadConfig(home).catch(() => null);
        if (conf?.extensions?.weatherEnabled === false) {
          return { ok: false, error: '天气功能已在设置里关闭（extensions.weatherEnabled=false）。' };
        }
        const city = String(args.city || conf?.persona?.city || '').trim();
        if (!city) {
          return {
            ok: false,
            error: '需要城市：请在设置→称呼与形象里填写你所在的城市，或在对话里告诉我你在哪。',
          };
        }
        const days = Math.max(1, Math.min(3, Math.floor(Number(args.days) || 2)));
        const fetchImpl = cfg?.fetch || cfg?.biliFetch || globalThis.fetch;
        if (typeof fetchImpl !== 'function') return { ok: false, error: '当前环境没有可用的网络请求能力。' };
        try {
          const geo = await fetchJson(fetchImpl,
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`);
          const hit = Array.isArray(geo?.results) ? geo.results[0] : null;
          if (!hit) return { ok: false, error: `没找到「${city}」这个地名，换个写法试试。` };
          const fc = await fetchJson(fetchImpl,
            'https://api.open-meteo.com/v1/forecast'
            + `?latitude=${hit.latitude}&longitude=${hit.longitude}`
            + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m'
            + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
            + `&timezone=auto&forecast_days=${days}`);
          const cur = fc?.current || {};
          const daily = fc?.daily || {};
          const list = (daily.time || []).slice(0, days).map((date, i) => ({
            date,
            weather: wx((daily.weather_code || [])[i]),
            min: Math.round(Number((daily.temperature_2m_min || [])[i]) || 0),
            max: Math.round(Number((daily.temperature_2m_max || [])[i]) || 0),
            rainChance: Number((daily.precipitation_probability_max || [])[i]) || 0,
          }));
          const now = {
            text: wx(cur.weather_code),
            temp: Math.round(Number(cur.temperature_2m) || 0),
            feels: Math.round(Number(cur.apparent_temperature) || 0),
            humidity: Math.round(Number(cur.relative_humidity_2m) || 0),
            wind: Math.round(Number(cur.wind_speed_10m) || 0),
          };
          const place = [hit.name, hit.admin1, hit.country].filter(Boolean).join('·');
          const summary = `${place}现在${now.text}，${now.temp}°C（体感${now.feels}°C），湿度${now.humidity}%，风${now.wind}km/h；`
            + list.map((d) => `${d.date.slice(5)} ${d.weather} ${d.min}~${d.max}°C${d.rainChance ? ` 降雨${d.rainChance}%` : ''}`).join('；');
          return { ok: true, city: place, now, days: list, summary: clip(summary, 400) };
        } catch (err) {
          return { ok: false, error: `天气查询失败：${errMsg(err)}` };
        }
      },
    }),
  ];
}