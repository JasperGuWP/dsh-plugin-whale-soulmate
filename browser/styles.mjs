// The plugin stylesheet: injected once on apply, removed on dispose.
const { CSS_KEY } = require('./util.mjs')

    const CSS = `
.sm-widget{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:262px;color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:var(--dsh-content-font-size,14px);line-height:1.5;user-select:none;-webkit-font-smoothing:antialiased}
.sm-widget *,.sm-mini *,.sm-overlay *,.sm-onb *{box-sizing:border-box}

/* Surface: elevation stroke + two faint glows, the same material the shell uses for
   floating panels, so the card reads as part of the app rather than on top of it. */
.sm-card{position:relative;border:0;border-radius:var(--dsw-radius-lg,16px);padding:12px 12px 12px;background:var(--dsw-alias-bg-base,#fff);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px #00000029,0 3px 8px 0 #0000000a,0 0 20px 0 #0000000d)}
.sm-head{display:flex;align-items:center;gap:10px;cursor:pointer;border-radius:var(--dsw-radius-md,12px);padding:2px;margin:-2px -2px 0;transition:background .15s}
.sm-head:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}
.sm-avatar{width:52px;height:52px;flex:none;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,#f9fafb);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2,#0000001a)}
.sm-meta{min-width:0;flex:1}
.sm-name{font-size:13.5px;font-weight:600;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-stage{margin-top:1px;font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,#61666b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-bubble{margin:10px 0 8px;padding:7px 10px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-specific-bubble,#edf3fe);color:var(--dsw-alias-label-secondary,#61666b);font-size:12.5px;line-height:1.5;min-height:20px;word-break:break-word}
.sm-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-skeleton,#0000000a);overflow:hidden;margin:5px 0 2px}
.sm-bar>i{display:block;height:100%;border-radius:2px;transition:width .45s cubic-bezier(.22,.61,.36,1)}
.sm-bar.e>i{background:var(--dsw-alias-state-business-primary,#4176e6)}
.sm-bar.a>i{background:var(--dsw-alias-state-done-primary,#7c3aed)}
.sm-lab{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#61666b)}
.sm-lab>b{font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#61666b)}
.sm-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.sm-btn{height:30px;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:.5px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-button-floating-fill,transparent);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .15s,border-color .15s}
.sm-btn:hover{background:var(--dsw-alias-button-floating-hover,#f1f3f5)}
.sm-btn:active{background:var(--dsw-alias-interactive-bg-active,#edf0f4)}
.sm-btn:disabled{opacity:.45;cursor:default}
.sm-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}

/* Collapsed pill: same material as an icon button in the shell. */
.sm-mini{position:fixed;right:16px;bottom:16px;width:44px;height:44px;padding:0;overflow:hidden;z-index:2147483000;border:.5px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,#fff);box-shadow:var(--dsw-elevation-panel,0 0 0 .5px #0000001f,0 3px 8px 0 #00000008);cursor:pointer;transition:background .15s,box-shadow .15s}
.sm-mini:hover{background:var(--dsw-alias-button-floating-hover,#f1f3f5);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px #00000029,0 3px 8px 0 #0000000a)}
/* Avatar-only widget: a free-floating sticker, no square plate behind her.
   Transparent background + soft character shadow so she sits on the page itself. */
.sm-widget-avatar{width:auto;pointer-events:none;overflow:visible}
.sm-widget-avatar .sm-pet-say{pointer-events:auto}
.sm-card-avatar{position:relative;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;overflow:visible;pointer-events:none}
/* 16:9 stage: layout authority for video + PNG fallback; only .sm-pet-hit receives pointers. */
.sm-pet-stage{position:relative;width:320px;height:180px;pointer-events:none;overflow:visible;line-height:0}
.sm-pet-stage .sm-avatar,.sm-pet-stage .sm-avatar-sprite,.sm-pet-stage-sprite{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:contain;border-radius:0;background:transparent;box-shadow:none;filter:drop-shadow(0 8px 18px rgba(15,17,21,.22));-webkit-user-drag:none;user-select:none;pointer-events:none}
/* A/B swap is a HARD CUT: an opacity crossfade overlaps two silhouettes for
   180ms, which reads as jitter / ghosting while tapping or dragging the pet. */
.sm-pet-video{position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none;object-fit:contain;-webkit-user-drag:none;user-select:none;transform-origin:center}
.sm-pet-video.is-front{opacity:1}
.sm-pet-video.is-mirror{transform:scaleX(-1)}
.sm-pet-hit{position:absolute;pointer-events:auto;cursor:grab;z-index:1;touch-action:none;-webkit-user-select:none;user-select:none;overflow:visible}
.sm-widget-avatar.sm-dragging .sm-pet-hit{cursor:grabbing}
@media (prefers-reduced-motion:reduce){.sm-pet-video{transition:none}}
.sm-card-avatar .sm-avatar{width:148px;height:148px;display:block;border-radius:0;background:transparent;box-shadow:none;filter:drop-shadow(0 8px 18px rgba(15,17,21,.22));-webkit-user-drag:none;user-select:none}
.sm-card-avatar .sm-avatar-sprite{width:148px;height:148px;display:block;object-fit:contain;border-radius:0;background:transparent;box-shadow:none;filter:drop-shadow(0 8px 18px rgba(15,17,21,.22));-webkit-user-drag:none;user-select:none}
/* Corner pet speech bubble — right-anchored so it grows into the viewport (pet sits bottom-right). */
.sm-pet-say{position:absolute;left:auto;right:4px;bottom:calc(100% + 8px);transform:translateY(4px);width:max-content;min-width:168px;max-width:min(280px,72vw);padding:10px 14px;border-radius:14px 14px 6px 14px;background:var(--dsw-specific-bubble,#edf3fe);color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;line-height:1.5;box-shadow:var(--dsw-elevation-panel,0 0 0 .5px #0000001f,0 3px 8px 0 #00000008);opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;z-index:3;white-space:normal;word-break:keep-all;overflow-wrap:break-word;text-align:left}
/* Turn card: sit just above the character (hit box / stage left), not the far stage edge. */
.sm-turn-card{position:absolute;left:50%;right:auto;bottom:calc(100% + 6px);transform:translate(-50%,6px);display:flex;align-items:flex-start;gap:10px;min-width:180px;max-width:min(260px,70vw);padding:12px 14px 12px 12px;border-radius:16px;background:var(--dsw-alias-bg-base,#f5f6f8);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:var(--dsw-elevation-panel,0 0 0 .5px #0000001f,0 6px 18px #00000014);opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;z-index:4}
.sm-turn-card.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}
.sm-turn-card-x{position:absolute;left:-6px;top:-6px;width:22px;height:22px;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#8a8f99);box-shadow:0 0 0 .5px #0000001a,0 2px 6px #00000010;font:600 14px/1 system-ui,sans-serif;cursor:pointer;padding:0}
.sm-turn-card-main{flex:1;min-width:0;padding-right:4px}
.sm-turn-card-title{font-size:13.5px;font-weight:600;line-height:1.45;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sm-turn-card-status{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99);line-height:1.3}
.sm-turn-card-end{flex:none;width:28px;height:28px;margin-top:2px;border:0;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 8%,transparent);cursor:pointer;position:relative}
.sm-turn-card-end::after{content:"";position:absolute;inset:9px;border-radius:2px;background:var(--dsw-alias-label-secondary,#61666b)}
.sm-pet-say.on{opacity:1;transform:translateY(0);pointer-events:auto}
.sm-pet-say::after{content:"";position:absolute;left:auto;right:28px;bottom:-6px;width:10px;height:10px;background:inherit;transform:rotate(45deg);box-shadow:1px 1px 0 0 color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 8%,transparent)}
/* Collapsed state also free-floats when showing a sprite — no white tile. */
.sm-mini.sm-mini-sprite{width:56px;height:56px;border:0;border-radius:0;background:transparent;box-shadow:none;overflow:visible}
.sm-mini.sm-mini-sprite:hover{background:transparent;box-shadow:none}
.sm-mini.sm-mini-sprite .sm-avatar-sprite{width:56px;height:56px;border-radius:0;background:transparent;box-shadow:none;filter:drop-shadow(0 4px 10px rgba(15,17,21,.16))}
/* Overlay: the shell's modal mask plus a panel-radius surface. */
.sm-overlay{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-3,#0000007a)}
.sm-frame{width:min(1280px,94vw);height:min(820px,90vh);border:0;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-alias-bg-base,#fff);box-shadow:var(--dsw-shadow-lv3,0 0 1px 0 #0003,0 12px 32px 0 #00000014);overflow:hidden}
.sm-close{position:absolute;right:20px;top:16px;width:28px;height:28px;display:grid;place-items:center;border:.5px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:14px;line-height:1;cursor:pointer;transition:background .15s}
.sm-close:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5);color:var(--dsw-alias-label-primary,#0f1115)}

/* Onboarding: the approved balloon card (D:\agent\gender-balloons\index.html).
   Cream-light scene with drifting warm blobs; white card; inflated ♂/♀ canvas
   balloons; countdown chip; dark confirm + confetti. Scoped to .sm-onb so the
   settings page keeps its flat instrument language. */
.sm-onb{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;overflow:auto;padding:24px 12px;border:1px solid #ecdcd2;background:radial-gradient(720px 380px at 12% -8%,rgba(255,194,75,.16),transparent 62%),radial-gradient(680px 420px at 92% 108%,rgba(224,68,127,.12),transparent 60%),radial-gradient(520px 320px at 78% -12%,rgba(47,107,255,.08),transparent 60%),linear-gradient(160deg,#fdf4ea,#ffe7ef 70%,#fdf4ea);font-family:"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;color:#2b2542}
.sm-onb-scene{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.sm-onb-blob{position:absolute;border-radius:50%;pointer-events:none}
.sm-onb-blob.b1{width:340px;height:340px;left:-120px;top:-140px;background:radial-gradient(circle at 35% 35%,rgba(255,194,75,.28),rgba(255,194,75,0) 70%);animation:sm-cream-drift 14s ease-in-out infinite alternate}
.sm-onb-blob.b2{width:420px;height:420px;right:-160px;bottom:-180px;background:radial-gradient(circle at 60% 40%,rgba(224,68,127,.20),rgba(224,68,127,0) 70%);animation:sm-cream-drift 18s ease-in-out infinite alternate-reverse}
.sm-onb-blob.b3{width:260px;height:260px;right:16%;top:-110px;background:radial-gradient(circle at 50% 50%,rgba(47,107,255,.14),rgba(47,107,255,0) 70%);animation:sm-cream-drift 16s ease-in-out infinite alternate;animation-delay:-7s}
@keyframes sm-cream-drift{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(40px,26px,0) scale(1.08)}}
.sm-onb-box{position:relative;width:min(560px,100%);max-height:min(88vh,780px);overflow-y:auto;overflow-x:hidden;background:#fff;color:#232733;border-radius:20px;box-shadow:0 30px 70px -30px rgba(10,10,40,.55);padding:22px 24px 18px;animation:sm-onb-rise .8s cubic-bezier(.2,.9,.25,1) both;scrollbar-width:thin;scrollbar-color:#e0447f transparent}
.sm-onb-box::-webkit-scrollbar{width:8px}
.sm-onb-box::-webkit-scrollbar-track{background:transparent}
.sm-onb-box::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#2f6bff,#e0447f);border-radius:99px;border:2px solid #fff}
.sm-onb-box::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,#e79a17,#e0447f)}
@keyframes sm-onb-rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
.sm-onb-box.shake{animation:sm-onb-shake .4s}
@keyframes sm-onb-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-7px)}50%{transform:translateX(6px)}75%{transform:translateX(-4px)}}
.sm-onb-top{display:flex;align-items:center;gap:9px}
.sm-onb-ico{width:26px;height:26px;border-radius:50%;flex:none;background:radial-gradient(circle at 32% 28%,#fff 0 12%,#4d8dff 45%,#1b3f9e 95%);box-shadow:0 4px 10px -4px #4d8dff}
.sm-onb h2{margin:0;font-size:16.5px;font-weight:800;color:#232733;line-height:1.4}
.sm-onb-cd{margin-left:auto;font-size:11px;font-weight:800;line-height:1;color:#2f6bff;background:#e8f0ff;border:1px solid #bcd3ff;padding:6px 10px;border-radius:99px;font-variant-numeric:tabular-nums;white-space:nowrap}
.sm-onb-cd.saved{color:#0c8a5f;background:#e2f8ee;border-color:#a9e6cd}
.sm-onb-sound{display:inline-flex;align-items:center;gap:6px;border:1px solid #e7e9f2;cursor:pointer;background:#fff;color:#7b8194;font-family:inherit;font-size:11px;font-weight:700;line-height:1;padding:6px 10px;border-radius:99px;transition:.2s;flex:none}
.sm-onb-sound:hover{color:#232733;border-color:#bcd3ff}
.sm-onb-sound-dot{width:7px;height:7px;border-radius:50%;background:#3ddc97;box-shadow:0 0 8px #3ddc97}
.sm-onb-sound[aria-pressed="false"] .sm-onb-sound-dot{background:#c6c9d6;box-shadow:none}
.sm-onb-desc{font-size:12.5px;color:#7b8194;line-height:1.75;margin:10px 0 12px}
.sm-onb-progress{height:4px;border-radius:99px;background:#edeff6;overflow:hidden;margin-bottom:18px}
.sm-onb-progress>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2f6bff,#7fb1ff);transition:width .6s cubic-bezier(.2,.9,.3,1)}
.sm-onb-genders{display:flex;justify-content:center;gap:26px;margin:6px 0 34px}
.sm-onb-gbtn{position:relative;width:96px;height:96px;border-radius:26px;cursor:pointer;border:2px solid transparent;transition:.25s;display:flex;align-items:center;justify-content:center;background:transparent;padding:0}
.sm-onb-gbtn.m{background:#e9f2ff;border-color:#a9c8ff}
.sm-onb-gbtn.f{background:#ffeaf3;border-color:#ffb1d0}
.sm-onb-balloon{width:78px;height:78px;pointer-events:none;animation:sm-onb-bob 3.6s ease-in-out infinite}
.sm-onb-balloon.f{animation-delay:-1.8s}
.sm-onb-balloon.boing{animation:sm-onb-boing .5s cubic-bezier(.3,1.6,.4,1),sm-onb-bob 3.6s ease-in-out .5s infinite}
@keyframes sm-onb-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes sm-onb-boing{0%{transform:scale(1,1)}30%{transform:scale(1.12,.86)}60%{transform:scale(.94,1.08)}100%{transform:scale(1,1)}}
.sm-onb-gbtn:hover{transform:translateY(-3px)}
.sm-onb-gbtn[aria-pressed="true"]{transform:translateY(-3px) scale(1.05)}
.sm-onb-gbtn.m[aria-pressed="true"]{border-color:#2f6bff;box-shadow:0 12px 26px -12px #2f6bff}
.sm-onb-gbtn.f[aria-pressed="true"]{border-color:#e0447f;box-shadow:0 12px 26px -12px #e0447f}
.sm-onb-check{position:absolute;right:-7px;top:-7px;width:24px;height:24px;border-radius:50%;color:#fff;font-size:13px;font-weight:900;display:flex;align-items:center;justify-content:center;transform:scale(0);transition:.25s cubic-bezier(.3,1.6,.4,1)}
.sm-onb-gbtn.m .sm-onb-check{background:#2f6bff}
.sm-onb-gbtn.f .sm-onb-check{background:#e0447f}
.sm-onb-gbtn[aria-pressed="true"] .sm-onb-check{transform:scale(1)}
.sm-onb-glabel{position:absolute;bottom:-22px;left:0;right:0;text-align:center;font-size:11.5px;font-weight:800;color:#7b8194;letter-spacing:2px}
.sm-onb-presets{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 14px}
.sm-onb-presets .sm-preset{padding:10px 12px;border:1.5px solid #e7e9f2;border-radius:14px;background:#fff;text-align:left;cursor:pointer;animation:sm-onb-rise .5s cubic-bezier(.2,.9,.25,1) both;transition:border-color .2s,box-shadow .2s,transform .2s}
.sm-onb-presets .sm-preset:hover{transform:translateY(-2px);border-color:#bcd3ff;box-shadow:0 8px 18px -10px #2f6bff}
.sm-onb-presets .sm-preset.on{border-color:#2f6bff;box-shadow:0 8px 18px -10px #2f6bff;background:#f4f8ff}
.sm-onb-presets .sm-preset b{font-size:12.5px;font-weight:700;color:#232733}
.sm-onb-presets .sm-preset span{font-size:11px;color:#7b8194}
.sm-onb-nick{width:100%;border:1.5px solid #e7e9f2;border-radius:12px;padding:12px 14px;font-family:inherit;font-size:13px;font-weight:500;line-height:1;color:#232733;outline:none;transition:.2s;background:#fff}
.sm-onb-nick:focus{border-color:#2f6bff;box-shadow:0 0 0 4px #2f6bff22}
.sm-onb-nick::placeholder{color:#a6abbd}
.sm-onb-foot{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:16px}
.sm-onb-later{border:0;background:none;cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;line-height:1;color:#7b8194;padding:10px 6px}
.sm-onb-later:hover{color:#232733}
.sm-onb-confirm{border:0;cursor:pointer;font-family:inherit;font-size:13.5px;font-weight:800;line-height:1;color:#fff;background:#171a22;padding:13px 22px;border-radius:12px;transition:.2s;box-shadow:0 10px 22px -12px rgba(0,0,0,.7)}
.sm-onb-confirm:hover{transform:translateY(-2px)}
.sm-onb-confirm:active{transform:scale(.96)}
.sm-onb-confirm.done{background:#0c8a5f}
.sm-onb-confetti{position:absolute;width:8px;height:12px;top:40%;left:50%;pointer-events:none;border-radius:2px;z-index:5}
/* Shared flat presets grid + gender pick used by the settings page. */
.sm-presets{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sm-gender-pick{display:flex;gap:28px;justify-content:center;align-items:flex-end;margin:8px 0 18px}
.sm-gender-balloon{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;width:96px;padding:8px 6px 10px;border:1.5px solid #ecdcd2;border-radius:22px;background:#fffaf5;cursor:pointer;box-shadow:0 10px 22px -16px rgba(120,80,60,.45);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease,background .18s ease}
.sm-gender-balloon:hover{transform:translateY(-2px);box-shadow:0 14px 26px -14px rgba(120,80,60,.5)}
.sm-gender-balloon.male.on{border-color:#2f6bff;background:#eef4ff;box-shadow:0 0 0 2px rgba(47,107,255,.22),0 14px 26px -14px rgba(47,107,255,.35)}
.sm-gender-balloon.female.on{border-color:#e0447f;background:#fff0f5;box-shadow:0 0 0 2px rgba(224,68,127,.2),0 14px 26px -14px rgba(224,68,127,.35)}
.sm-gender-balloon-cv{width:78px;height:78px;pointer-events:none;animation:sm-onb-bob 3.6s ease-in-out infinite}
.sm-gender-balloon.female .sm-gender-balloon-cv{animation-delay:-1.8s}
.sm-gender-balloon-label{font-size:12.5px;font-weight:700;letter-spacing:.04em;color:#5a516e}
.sm-gender-balloon.male.on .sm-gender-balloon-label{color:#2f6bff}
.sm-gender-balloon.female.on .sm-gender-balloon-label{color:#e0447f}
/* Legacy flat circles kept as no-op aliases so old class names never flash unstyled. */
.sm-gender-btn{display:none}
@media (max-width:640px){.sm-onb{padding:14px 8px}.sm-onb-box{padding:18px 16px 14px}.sm-onb-genders{gap:16px}.sm-onb-presets{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.sm-onb-blob,.sm-onb-balloon,.sm-onb-box,.sm-onb-presets .sm-preset{animation:none}}
.sm-preset-fold{margin:8px 0;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:12px}
.sm-preset-fold summary{cursor:pointer;padding:8px 12px;font-weight:500}
.sm-preset{padding:10px 12px;display:flex;flex-direction:column;gap:2px;border:.5px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s}
.sm-preset:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}
.sm-preset.on{border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary,#4176e6)}
.sm-preset b{font-size:13px;font-weight:500}
.sm-preset span{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#61666b)}
.sm-input{width:100%;height:34px;padding:0 10px;margin-bottom:14px;border:.5px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,#fff));color:inherit;font:inherit;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
.sm-input::placeholder{color:var(--dsw-alias-label-tertiary,#61666b)}
.sm-input:hover{border-color:var(--dsw-alias-border-l3,#0000001f)}
.sm-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 18%,transparent)}
.sm-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px}
.sm-saved{font-size:11.5px;color:var(--dsw-alias-state-success-primary,#1a9f5a);opacity:0;transition:opacity .25s}
.sm-saved.on{opacity:1}
.sm-primary{height:32px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s}
.sm-primary:hover{background:var(--dsw-alias-button-primary-hover,#61666b)}
.sm-link{padding:0 2px;border:0;background:none;color:var(--dsw-alias-label-tertiary,#61666b);font:inherit;font-size:12px;cursor:pointer;transition:color .15s}
.sm-link:hover{color:var(--dsw-alias-label-secondary,#61666b);text-decoration:underline}

/* Inline tool-result card: sits in the transcript, so it uses the shell's bubble radius
   and label scale rather than a second visual language. */
.sm-chat{margin:8px 0;padding:10px 14px;max-width:560px;border:.5px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:var(--dsh-content-font-size,14px);line-height:1.6}
.sm-chat.bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 45%,transparent)}
.sm-chat .t{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:13px;font-weight:600;line-height:1.5}
.sm-chat .p{display:inline-flex;align-items:center;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-mask-1,#0000003d);color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px;font-weight:500;line-height:16px}
.sm-chat .l{color:var(--dsw-alias-label-secondary,#61666b);font-size:13px;word-break:break-word}
.sm-chat .bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-skeleton,#0000000a);overflow:hidden;margin-top:8px}
.sm-chat .bar>i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-done-primary,#7c3aed)}
/* ---- sidebar panel: the persona workshop (host design tokens, light + dark) ---- */
/* No top padding on the scrollport: sticky tabs + padding-top left a see-through
   strip where card text scrolled through (the "中间空隙"). Top inset lives on the wrap. */
.sm-panel{height:100%;box-sizing:border-box;overflow-y:auto;padding:0 32px 96px;color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:14px;line-height:1.6}
.sm-panel *{box-sizing:border-box}
.sm-panel-wrap{max-width:840px;margin:0 auto;padding-top:28px;display:flex;flex-direction:column;gap:14px}
.sm-panel-head{display:flex;gap:16px;align-items:flex-start;padding:4px 2px 10px;position:relative;z-index:1}
.sm-panel-avatar{width:84px;height:84px;flex:none;border-radius:18px;border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.sm-panel-title{margin:0;font-size:19px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary,inherit)}
.sm-panel-sub{margin:3px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#4e5561)}
.sm-panel-muted{margin:4px 0 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.sm-panel-card{border:1px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,#fafbfc);padding:12px 14px 14px}
.sm-panel-h3{margin:0 0 10px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#4e5561)}
.sm-panel-row{display:flex;gap:12px;flex-wrap:wrap}
.sm-panel-field{display:flex;flex-direction:column;gap:6px;flex:1 1 190px;min-width:150px}
.sm-panel-field>span{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.sm-panel-input{width:100%;height:32px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:13px;outline:none;transition:border-color .15s}
.sm-panel-input:hover{border-color:var(--dsw-alias-border-l3,#d0d3d9)}
.sm-panel-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.sm-panel-textarea{width:100%;min-height:110px;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:13px;line-height:1.55;resize:vertical;outline:none;transition:border-color .15s}
.sm-panel-textarea:hover{border-color:var(--dsw-alias-border-l3,#d0d3d9)}
.sm-panel-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.sm-preset-body{margin:12px 0 0;padding:12px 14px;border-radius:var(--dsw-radius-md,10px);border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 8%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 2%,transparent)}
.sm-preset-body p{margin:0;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary,#4e5561)}
.sm-preset-body ul{margin:10px 0 0;padding:0 0 0 18px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.sm-preset-body li{margin:3px 0}
.sm-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.sm-chip{border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-base,#fff);color:inherit;border-radius:var(--dsw-radius-md,8px);padding:6px 11px;font:inherit;font-size:12.5px;line-height:1.4;cursor:pointer;text-align:left;transition:background .15s,border-color .15s,color .15s}
.sm-chip:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}
.sm-chip.on{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 8%,transparent);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.sm-chip small{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.sm-chip.on small{color:inherit;opacity:.85}
.sm-trait{display:grid;grid-template-columns:96px minmax(120px,1fr) 56px;gap:12px;align-items:center;margin:9px 0}
.sm-trait>span{font-size:12.5px;color:var(--dsw-alias-label-secondary,#4e5561);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-trait>b{font-size:12.5px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4e5561);white-space:nowrap}
.sm-trait input[type=range]{width:100%;height:20px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);background:transparent}
.sm-scheme-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:4px 0 8px}
.sm-scheme-toggle{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;cursor:pointer;user-select:none}
.sm-scheme-toggle input{accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.sm-mbti-quiz-btn{flex:none;max-width:100%;min-height:32px;height:auto;padding:6px 12px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12.5px;font-weight:500;letter-spacing:0;line-height:1.35;white-space:normal;text-align:left;cursor:pointer}
.sm-mbti-quiz-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}
.sm-mbti-quiz-btn:disabled{opacity:.55;cursor:default}
.sm-mbti-quiz-msg{margin:0 0 12px;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#4e5561)}
.sm-mbti-quiz-msg.bad{color:var(--dsw-alias-state-error-primary,#ec1313)}
.sm-mbti-quiz-msg.ok{color:var(--dsw-alias-state-success-primary,#1a9f5a)}
.sm-mbti-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:4px 0 10px}
.sm-mbti-cell{border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-base,#fff);border-radius:var(--dsw-radius-md,8px);padding:8px 4px;font:inherit;font-size:12px;font-weight:600;letter-spacing:.04em;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.sm-mbti-cell:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}
.sm-mbti-cell.on{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 10%,transparent);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.sm-mbti-blurb{margin:0 0 10px;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#4e5561)}
.sm-mbti-axis{grid-template-columns:72px minmax(120px,1fr) 64px}
.sm-color{display:flex;align-items:center;gap:8px}
.sm-color input[type=color]{width:32px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:6px;background:transparent;cursor:pointer}
.sm-color code{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8f99);font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.sm-panel-actions{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 2px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 0%,transparent),var(--dsw-alias-bg-base,#fff) 34%)}
.sm-panel-btn{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;cursor:pointer;transition:background .15s,border-color .15s}
.sm-panel-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}
.sm-panel-btn.primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
.sm-panel-btn.primary:hover{background:var(--dsw-alias-button-primary-hover,#3f5ae0)}
.sm-panel-btn.primary:disabled{opacity:.55;cursor:default}
.sm-panel-note{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.sm-panel-note.bad{color:var(--dsw-alias-state-error-primary,#ec1313)}
.sm-panel-actions .sm-panel-note:not(.bad){color:var(--dsw-alias-state-success-primary,#1a9f5a)}
/* Companion art upload */
.sm-sprite-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin-bottom:10px}
.sm-sprite-preview{width:180px;height:180px;flex:0 1 180px;min-width:150px;object-fit:contain;object-position:center center;border-radius:var(--dsw-radius-md,10px);border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-layer-2,#f9fafb);display:block}
video.sm-sprite-preview{background:transparent;object-fit:contain;object-position:center center}
.sm-cap-mask{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,#0f1115 42%,transparent);backdrop-filter:blur(2px)}
.sm-cap-dialog{width:min(380px,100%);padding:18px 18px 14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-panel,0 12px 40px #00000022);color:var(--dsw-alias-label-primary,#0f1115)}
.sm-cap-dialog h3{margin:0 0 8px;font-size:15px;font-weight:650}
.sm-cap-dialog p{margin:0 0 14px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#5c6370)}
.sm-cap-actions{display:flex;justify-content:flex-end;gap:8px}
.sm-cap-actions .sm-btn{min-width:72px}
.sm-cap-actions .sm-btn.primary{background:var(--dsw-alias-button-primary-fill,#4d6bfe);border-color:transparent;color:var(--dsw-alias-button-primary-label,#fff)}
.sm-sprite-preview.empty{display:flex;align-items:center;justify-content:center;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8f99);background:repeating-linear-gradient(45deg,transparent,transparent 5px,color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 3%,transparent) 5px,color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 3%,transparent) 10px)}
.sm-sprite-ops{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0;flex:1 1 220px}
.sm-sprite-ops .sm-panel-muted{flex-basis:100%;margin:2px 0 0}
.sm-sprite-ops label{display:flex;align-items:center;gap:6px;margin:0;font-size:12.5px}
.sm-sprite-ops input[type=range]{width:150px}
/* 桌面小伙伴右侧控件竖排：横向 flex-wrap 会把「尺寸/皮肤」标签和滑杆挤到互相遮挡 */
.sm-pet-ops{flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:8px}
.sm-pet-ops>label{flex:none;width:100%}
.sm-pet-ops .sm-panel-field{flex:none;width:100%;min-width:0;max-width:420px;margin:0}
.sm-pet-ops .sm-panel-field>span{white-space:normal;line-height:1.4}
.sm-pet-ops input[type=range]{width:100%;max-width:420px}
.sm-pet-ops .sm-panel-input{max-width:260px}
.sm-pet-ops .sm-panel-muted{flex-basis:auto;margin:0;line-height:1.5}
/* 作息与主动：竖排表单，勿复用横向 sm-sprite-ops（会把 LLM 块和滑杆挤成乱漂） */
.sm-rhythm-body{display:flex;flex-direction:column;gap:10px;align-items:stretch;min-width:0}
.sm-rhythm-check{display:flex;align-items:center;gap:8px;margin:0;font-size:12.5px;line-height:1.4}
.sm-rhythm-body .sm-panel-field{margin:2px 0;flex:none;width:100%;max-width:420px}
.sm-rhythm-body .sm-panel-field input[type=range]{width:100%;max-width:420px}
.sm-rhythm-body .sm-bili-auth{margin-top:4px;margin-bottom:2px}
.sm-autosurf-knobs{display:flex;flex-direction:column;gap:8px;margin:4px 0 0 22px;min-width:0}
.sm-autosurf-knobs .sm-panel-field{flex:none;margin:0}
/* Tab bar: hairline underline that slides, no pills, no fills.
   Solid sticky bg covers content scrolling under the bar. Do NOT use a ::before
   upward mask — it paints over the in-flow head (等级/心情/提示) and looks clipped. */
.sm-tabs{display:flex;gap:2px;flex-wrap:wrap;position:sticky;top:0;z-index:6;padding:4px 0 0;background:var(--dsw-alias-bg-base,#fff);border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 8%,transparent);isolation:isolate}
.sm-tab{position:relative;border:0;background:transparent;padding:9px 13px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-tertiary,#8a8f99);cursor:pointer;border-radius:var(--dsw-radius-sm,6px) var(--dsw-radius-sm,6px) 0 0;transition:color .15s,background .15s;white-space:nowrap}
.sm-tab:hover{color:var(--dsw-alias-label-secondary,#4e5561);background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 3%,transparent)}
.sm-tab.on{color:var(--dsw-alias-label-primary,#0f1115);font-weight:600}
.sm-tab.on::after{content:'';position:absolute;left:13px;right:13px;bottom:-1px;height:1.5px;border-radius:2px;background:var(--dsw-alias-brand-primary,#4d6bfe)}
.sm-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}
.sm-tab.sm-tab-feature{font-size:14px;font-weight:700;color:#1e3a8a}
.sm-tab.sm-tab-feature:hover{color:#1e40af;background:color-mix(in srgb,#1e3a8a 5%,transparent)}
.sm-tab.sm-tab-feature.on{color:#1e3a8a;font-weight:700}
.sm-tab.sm-tab-feature.on::after{background:#1e3a8a}
/* Neuron field: one ink, hairlines, generous negative space. */
.sm-neuron-lead{display:flex;align-items:baseline;gap:7px;margin:2px 0 10px;font-family:var(--sm-mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--sm-ink3)}
.sm-neuron-lead b{font-size:15px;font-weight:500;letter-spacing:0;color:var(--sm-ink);font-variant-numeric:tabular-nums}
.sm-neuron-lead span+span{padding-left:10px}
.sm-neuron-canvas{display:block;width:100%;height:auto;border-radius:var(--dsw-radius-md,10px);background:#05070f;border:1px solid color-mix(in srgb,#7aaaff 20%,transparent);box-shadow:inset 0 0 60px rgba(40,80,160,.22);cursor:grab;touch-action:none}
/* ---- engine dashboard: quiet instrument panel -------------------------------------
   Deliberately restrained: hairlines instead of borders, one hairline-thin accent line
   per card, a 4–6% grid etched into the surface, and every figure in tabular mono so
   the numbers read like a readout rather than a dashboard poster. No neon, no glass. */
.sm-panel{--sm-accent:var(--dsw-alias-brand-primary,#4d6bfe);--sm-ink:var(--dsw-alias-label-primary,#0f1115);--sm-ink2:var(--dsw-alias-label-secondary,#4e5561);--sm-ink3:var(--dsw-alias-label-tertiary,#8a8f99);--sm-surface:var(--dsw-alias-bg-layer-1,#fafbfc);--sm-line:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 9%,transparent);--sm-faint:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 4%,transparent);--sm-mono:var(--ds-font-family-code,ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace)}
/* identity readout under the name: small mono key/value pairs, hairline separated */
.sm-id-readout{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 0;margin:7px 0 2px;font-family:var(--sm-mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--sm-ink3)}
.sm-id-readout>span{display:inline-flex;align-items:baseline;gap:5px;padding:0 10px}
.sm-id-readout>span:first-child{padding-left:0}
.sm-id-readout>span+span{border-left:1px solid var(--sm-line)}
.sm-id-readout b{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--sm-ink2);font-variant-numeric:tabular-nums}
/* instrument surface: 4% etched grid + one faint accent wash top-right */
.sm-eng-card{position:relative;overflow:hidden;border:1px solid var(--sm-line,#e3e5e8);border-radius:var(--dsw-radius-lg,14px);background-color:var(--sm-surface,#fafbfc);background-image:radial-gradient(130% 100% at 100% 0,color-mix(in srgb,var(--sm-accent,#4d6bfe) 6%,transparent),transparent 62%),linear-gradient(var(--sm-faint,#0000000a) 1px,transparent 1px),linear-gradient(90deg,var(--sm-faint,#0000000a) 1px,transparent 1px);background-size:auto,24px 24px,24px 24px;padding:15px 17px 17px}
/* B 站鉴权卡复用 eng-card 气质；num/field 补齐 panel-bili 引用 */
.sm-bili-auth{margin-top:12px}
.sm-bili-auth .sm-eng-head{margin-bottom:6px;align-items:flex-start}
.sm-bili-auth .sm-bili-actions{margin-top:4px}
.sm-bili-manual{margin-top:14px;padding:12px 14px;border:1px dashed var(--sm-line,#e3e5e8);border-radius:12px;background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 3%,transparent)}
.sm-bili-manual-lead{margin:0 0 4px;font-size:12px;line-height:1.6}
.sm-bili-cred{margin-top:10px}
.sm-bili-cred-label{display:flex;align-items:baseline;gap:6px;font-size:12.5px}
.sm-bili-cred-label b{font-weight:600;letter-spacing:.02em}
.sm-bili-cred-label i{font-style:normal;font-size:11px}
.sm-bili-cred-hint{margin:2px 0 0;font-size:11.5px;line-height:1.55}
.sm-bili-write{margin-top:14px;padding-top:12px;border-top:1px solid var(--sm-line,#e3e5e8)}
.sm-bili-write .sm-rhythm-check{margin:0}
.sm-bili-write p{margin:6px 0 0;font-size:11.5px;line-height:1.55}
.sm-eng-num{flex:none;font-family:var(--sm-mono);font-size:9.5px;line-height:1;letter-spacing:.14em;color:var(--sm-accent);padding:3px 5px;border:1px solid color-mix(in srgb,var(--sm-accent) 32%,transparent);border-radius:4px}
.sm-field{display:block;font-size:12.5px;color:var(--sm-ink2);margin:0}
/* a single accent hairline across the top edge, fading at both ends */
.sm-eng-card::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--sm-accent,#4d6bfe) 55%,transparent) 22%,color-mix(in srgb,var(--sm-accent,#4d6bfe) 22%,transparent) 78%,transparent);pointer-events:none}
/* one 11px corner tick, top-right — the only "HUD" flourish */
.sm-eng-card::after{content:"";position:absolute;right:11px;top:11px;width:11px;height:11px;border-top:1px solid color-mix(in srgb,var(--sm-accent,#4d6bfe) 45%,transparent);border-right:1px solid color-mix(in srgb,var(--sm-accent,#4d6bfe) 45%,transparent);border-top-right-radius:2px;pointer-events:none}
.sm-eng-head{display:flex;align-items:center;gap:8px;margin:0 0 13px;padding-right:20px}
.sm-eng-idx{flex:none;font-family:var(--sm-mono);font-size:9.5px;line-height:1;letter-spacing:.14em;color:var(--sm-accent);padding:3px 5px;border:1px solid color-mix(in srgb,var(--sm-accent) 32%,transparent);border-radius:4px}
.sm-eng-title{font-size:12.5px;font-weight:600;letter-spacing:.01em;color:var(--sm-ink)}
/* the headline of a card whose subtitle is a long sentence, not a short tag */
.sm-eng-title>b{display:block;font-weight:600}
.sm-eng-title>em{display:block;margin-top:2px}
.sm-eng-title em{font-style:normal;font-weight:400;font-size:11.5px;letter-spacing:0;color:var(--sm-ink3);margin-left:7px}
@media(max-width:420px){.sm-eng-title em{display:none}.sm-panel{padding-left:18px;padding-right:18px}}
.sm-eng-state{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-family:var(--sm-mono);font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--sm-ink3);white-space:nowrap}
@media(max-width:360px){.sm-eng-state{display:none}}
.sm-eng-dot{--sm-dot:var(--dsw-alias-state-success-primary,#1a9f5a);display:inline-block;flex:none;width:5px;height:5px;border-radius:50%;background:var(--sm-dot);animation:sm-pulse 3s ease-out infinite}
.sm-eng-dot.warn{--sm-dot:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sm-eng-dot.idle{--sm-dot:var(--dsw-alias-label-tertiary,#8a8f99);animation:none;opacity:.7}
@keyframes sm-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--sm-dot) 50%,transparent)}60%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media(prefers-reduced-motion:reduce){.sm-eng-dot{animation:none}}
/* metric matrix: cells share hairline rules, so it reads as one instrument, not 6 cards */
.sm-eng-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--sm-line);border:1px solid var(--sm-line);border-radius:9px;overflow:hidden}
@media(max-width:700px){.sm-eng-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:360px){.sm-eng-grid{grid-template-columns:1fr}}
.sm-metric{min-width:0;padding:10px 12px 11px;background:var(--sm-surface)}
.sm-metric>.lb{display:block;font-size:10.5px;letter-spacing:.07em;color:var(--sm-ink3);margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-metric>.val{display:flex;align-items:baseline;gap:1px;font-family:var(--sm-mono);font-size:19px;font-weight:500;line-height:1.1;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--sm-ink)}
.sm-metric>.val>.u{font-family:var(--sm-mono);font-size:10.5px;font-weight:400;letter-spacing:.02em;color:var(--sm-ink3);margin-left:3px}
.sm-metric>.val.tiny{font-size:13px;letter-spacing:0}
.sm-metric>.sub{display:block;margin-top:4px;font-size:10.5px;line-height:1.45;color:var(--sm-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-metric>.mtr{position:relative;display:block;height:3px;margin-top:9px;border-radius:2px;background:color-mix(in srgb,var(--sm-ink) 8%,transparent);overflow:hidden}
.sm-metric>.mtr>b{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,color-mix(in srgb,var(--sm-accent) 40%,transparent),var(--sm-accent));box-shadow:0 0 7px color-mix(in srgb,var(--sm-accent) 45%,transparent);transition:width .5s cubic-bezier(.22,.61,.36,1)}
.sm-metric>.mtr::after{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(90deg,var(--sm-surface) 0 1px,transparent 1px 6px);pointer-events:none}
/* cognitive budget: label · segmented meter · share */
.sm-eng-foot{margin-top:13px;padding-top:12px;border-top:1px dashed var(--sm-line)}
.sm-eng-foot>.cap{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:9px;font-size:10.5px;letter-spacing:.07em;color:var(--sm-ink3)}
.sm-eng-foot>.cap>b{font-family:var(--sm-mono);font-weight:400;letter-spacing:.02em;text-transform:none;color:var(--sm-ink3);opacity:.9}
.sm-eng-budget{display:flex;flex-direction:column;gap:8px;min-width:0}
.sm-eng-budget-row{display:grid;grid-template-columns:auto minmax(48px,1fr) max-content;gap:8px 10px;align-items:center;font-size:11px;color:var(--sm-ink2);min-width:0}
.sm-eng-budget-row>span:first-child{color:var(--sm-ink3);letter-spacing:.02em;white-space:nowrap}
.sm-eng-budget-row>span:last-child{font-family:var(--sm-mono);font-size:10px;text-align:right;color:var(--sm-ink3);font-variant-numeric:tabular-nums;white-space:nowrap;justify-self:end}
.sm-eng-budget-row>i{position:relative;display:block;height:4px;border-radius:2px;background:color-mix(in srgb,var(--sm-ink) 7%,transparent);overflow:hidden}
.sm-eng-budget-row>i>b{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,color-mix(in srgb,var(--sm-accent) 35%,transparent),color-mix(in srgb,var(--sm-accent) 85%,transparent));box-shadow:0 0 6px color-mix(in srgb,var(--sm-accent) 35%,transparent)}
.sm-eng-budget-row>i::after{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(90deg,var(--sm-surface) 0 1px,transparent 1px 7px);pointer-events:none}
/* read-only tags for derived labels (tone / length / gate mode) */
.sm-eng-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.sm-eng-tag{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--sm-line);border-radius:5px;background:color-mix(in srgb,var(--sm-accent) 4%,transparent);font-family:var(--sm-mono);font-size:10px;letter-spacing:.04em;color:var(--sm-ink2);line-height:1.5}
.sm-eng-tag>i{display:block;width:3px;height:3px;border-radius:50%;background:color-mix(in srgb,var(--sm-accent) 70%,transparent)}
.sm-eng-note{margin:11px 0 0;font-size:11px;line-height:1.6;color:var(--sm-ink3)}
/* persona: invariant clauses + narrative self + changelog timeline */
.sm-eng-clauses{display:flex;flex-wrap:wrap;gap:6px}
.sm-eng-clause{position:relative;max-width:100%;padding:5px 9px 5px 11px;border:1px solid var(--sm-line);border-radius:6px;background:color-mix(in srgb,var(--sm-ink) 3%,transparent);font-size:11.5px;line-height:1.5;color:var(--sm-ink2)}
.sm-eng-clause::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:2px;border-radius:0 2px 2px 0;background:color-mix(in srgb,var(--sm-accent) 60%,transparent)}
.sm-eng-quote{position:relative;margin:12px 0 0;padding:2px 0 2px 11px;border-left:1px solid color-mix(in srgb,var(--sm-accent) 30%,transparent);font-size:12px;line-height:1.7;color:var(--sm-ink2)}
.sm-eng-quote+.sm-eng-note{margin-top:10px}
.sm-sprite{width:84px;height:84px;object-fit:contain;border-radius:18px;border:1px solid var(--dsw-alias-border-l2,#e3e5e8);background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.sm-avatar-sprite{width:52px;height:52px;object-fit:contain;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,#f9fafb);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2,#0000001a);flex:none}
/* Token 统计：趋势柱 + 日标签必须分列，否则会糊成 11-0511-06… */
.sm-usage-totals{display:flex;flex-direction:column;gap:8px;margin:0 0 14px}
.sm-usage-big{display:flex;align-items:baseline;gap:8px}
.sm-usage-big>span{font-size:11px;color:var(--sm-ink3,#8a8f99)}
.sm-usage-big>b{font-family:var(--sm-mono);font-size:22px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--sm-ink,#0f1115)}
.sm-usage-big>em{font-style:normal;font-size:11px;color:var(--sm-ink3,#8a8f99)}
.sm-usage-sub{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--sm-ink2,#4e5561)}
.sm-usage-sub .warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sm-usage-cap{margin:0 0 14px}
.sm-usage-cap-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12px;color:var(--sm-ink2,#4e5561);margin-bottom:6px}
.sm-usage-cap-row>b.ok{color:var(--dsw-alias-state-success-primary,#1a9f5a)}
.sm-usage-cap-row>b.warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sm-usage-track{height:4px;border-radius:2px;background:color-mix(in srgb,var(--sm-ink,#0f1115) 8%,transparent);overflow:hidden}
.sm-usage-track>i{display:block;height:100%;background:var(--sm-accent,#4d6bfe);border-radius:2px}
.sm-usage-track>i.warn{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sm-usage-spark{display:flex;flex-direction:column;gap:6px;margin:0 0 14px}
.sm-usage-bars{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;align-items:end;height:48px}
.sm-usage-bar{display:flex;align-items:flex-end;justify-content:center;height:100%;background:color-mix(in srgb,var(--sm-ink,#0f1115) 5%,transparent);border-radius:3px;overflow:hidden}
.sm-usage-bar>i{display:block;width:100%;min-height:2px;background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 75%,transparent);border-radius:3px 3px 0 0}
.sm-usage-bar.blocked>i{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sm-usage-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;font-family:var(--sm-mono);font-size:9px;letter-spacing:.02em;color:var(--sm-ink3,#8a8f99);text-align:center}
.sm-usage-kinds{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.sm-usage-kind{display:inline-flex;align-items:baseline;gap:6px;padding:4px 8px;border:1px solid var(--sm-line,#e3e5e8);border-radius:6px;font-size:11.5px;color:var(--sm-ink2,#4e5561)}
.sm-usage-kind>span:last-of-type{font-family:var(--sm-mono);font-variant-numeric:tabular-nums}
.sm-usage-form{margin-top:14px;padding-top:12px;border-top:1px dashed var(--sm-line,#e3e5e8)}
/* one card owns a whole settings page row */
.sm-usage-card{grid-column:1/-1}
.sm-diary-card{display:flex;flex-direction:column;min-height:min(70vh,720px)}
.sm-diary-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;flex:none}
.sm-diary-tab{height:28px;padding:0 10px;border:1px solid var(--sm-line,#e3e5e8);border-radius:6px;background:transparent;color:var(--sm-ink2,#4e5561);font:inherit;font-size:12px;cursor:pointer}
.sm-diary-tab.on{border-color:color-mix(in srgb,var(--sm-accent,#4d6bfe) 45%,transparent);background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 8%,transparent);color:var(--sm-ink,#0f1115);font-weight:500}
.sm-diary-body{display:grid;grid-template-columns:minmax(160px,240px) minmax(0,1fr);gap:12px;flex:1 1 auto;min-height:min(56vh,560px);align-items:stretch}
@media(max-width:560px){.sm-diary-body{grid-template-columns:1fr;min-height:0}}
.sm-diary-list{display:flex;flex-direction:column;gap:4px;min-height:0;height:100%;max-height:min(62vh,640px);overflow:auto;padding-right:2px}
.sm-diary-year{display:flex;flex-direction:column;gap:4px;margin:0 0 8px}
.sm-diary-month{display:flex;flex-direction:column;gap:2px;margin:0 0 6px 6px}
.sm-diary-group{margin:4px 0 2px;padding:0 2px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--sm-ink3,#8a8f99)}
.sm-diary-group-m{font-weight:500;color:var(--sm-ink2,#4e5561)}
.sm-diary-item{text-align:left;padding:7px 9px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--sm-ink2,#4e5561);font:inherit;font-size:12px;line-height:1.4;cursor:pointer}
.sm-diary-month .sm-diary-item{margin-left:4px}
.sm-diary-item:hover{background:color-mix(in srgb,var(--sm-ink,#0f1115) 4%,transparent)}
.sm-diary-item.on{border-color:var(--sm-line,#e3e5e8);background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 7%,transparent);color:var(--sm-ink,#0f1115)}
.sm-diary-paper{margin:0;padding:14px 16px;border:1px solid var(--sm-line,#e3e5e8);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);white-space:pre-wrap;word-break:break-word;font:inherit;font-size:13px;line-height:1.75;color:var(--sm-ink2,#4e5561);min-height:0;height:100%;max-height:min(62vh,640px);overflow:auto}
/* The settings rows: label above a full-width control. Without these the input and select
   collapsed to their intrinsic width and the hint text sat inline beside them. */
.sm-form-row{display:flex;flex-direction:column;gap:5px;margin:0 0 12px}
.sm-form-label{font-size:11.5px;font-weight:600;color:var(--sm-ink2,#4e5561)}
.sm-form-row input,.sm-form-row select{width:100%;height:32px;padding:0 9px;border:1px solid var(--sm-line,#e3e5e8);border-radius:6px;background:var(--sm-surface,#fff);color:var(--sm-ink,#0f1115);font:inherit;font-size:12.5px;outline:none;transition:border-color .15s,box-shadow .15s}
.sm-form-row input:hover,.sm-form-row select:hover{border-color:color-mix(in srgb,var(--sm-ink,#0f1115) 18%,transparent)}
.sm-form-row input:focus,.sm-form-row select:focus{border-color:var(--sm-accent,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--sm-accent,#4d6bfe) 18%,transparent)}
.sm-form-hint{margin:0;font-size:11px;line-height:1.5}
/* keeps a long display name from pushing the LV/affinity readout out of the header */
.sm-panel-id{min-width:0;flex:1}
/* Optional LLM dream / distill budget block on 作息与主动 */
.sm-llm-budget{margin:10px 0 12px;padding:10px 12px;border:1px solid var(--sm-line,#e3e5e8);border-radius:8px;background:color-mix(in srgb,var(--sm-ink,#0f1115) 2.5%,transparent);display:flex;flex-direction:column;gap:8px}
.sm-llm-budget-on{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--sm-ink,#0f1115)}
.sm-llm-budget-warn{margin:0;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sm-llm-budget-row{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--sm-ink2,#4e5561)}
.sm-llm-budget-row>span{font-weight:600}
.sm-llm-budget-row input,.sm-llm-budget-row select{width:100%;height:30px;padding:0 8px;border:1px solid var(--sm-line,#e3e5e8);border-radius:6px;background:var(--sm-surface,#fff);font:inherit;font-size:12.5px}
.sm-llm-budget-row input:disabled{opacity:.55;cursor:not-allowed;background:color-mix(in srgb,var(--sm-ink,#0f1115) 4%,transparent)}
.sm-llm-budget-rem{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--sm-ink2,#4e5561);font-variant-numeric:tabular-nums}
.sm-llm-budget-track{height:4px;border-radius:2px;background:color-mix(in srgb,var(--sm-ink,#0f1115) 8%,transparent);overflow:hidden}
.sm-llm-budget-track>i{display:block;height:100%;background:var(--sm-accent,#4d6bfe);border-radius:2px}
/* 冲浪：平台分列 + 日志卡 */
.sm-surf-page{display:flex;flex-direction:column;gap:12px;grid-column:1/-1}
.sm-surf-gate,.sm-dsbot-gate{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:18px 16px}
.sm-surf-gate-btn,.sm-dsbot-gate-btn{min-height:40px;padding:0 18px;font-size:14px;font-weight:650}
.sm-surf-gate-bar,.sm-dsbot-gate-bar{display:flex;justify-content:flex-end;margin:0 0 8px}
.sm-surf-body,.sm-dsbot-body{display:flex;flex-direction:column;gap:12px}
.sm-surf-platforms{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 4px}
.sm-surf-platform{height:30px;padding:0 12px;border:1px solid var(--sm-line,#e3e5e8);border-radius:8px;background:transparent;color:var(--sm-ink2,#4e5561);font:inherit;font-size:12.5px;cursor:pointer}
.sm-surf-platform.on{border-color:color-mix(in srgb,var(--sm-accent,#4d6bfe) 45%,transparent);background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 8%,transparent);color:var(--sm-ink,#0f1115);font-weight:600}
.sm-surf-filters{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.sm-surf-log-list{display:flex;flex-direction:column;gap:12px}
.sm-surf-log{display:flex;flex-direction:column;gap:10px}
.sm-surf-log-media{min-width:0}
.sm-surf-log-body{min-width:0;display:flex;flex-direction:column;gap:6px}
.sm-surf-log-card{display:grid;grid-template-columns:minmax(96px,140px) minmax(0,1fr);gap:12px;padding:10px;border:1px solid var(--sm-line,#e3e5e8);border-radius:10px;background:color-mix(in srgb,var(--sm-ink,#0f1115) 1.5%,transparent)}
@media(max-width:560px){.sm-surf-log-card{grid-template-columns:1fr}}
.sm-surf-cover-btn{display:block;width:100%;padding:0;border:0;background:transparent;cursor:zoom-in;border-radius:8px}
.sm-surf-log-cover{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;background:color-mix(in srgb,var(--sm-ink,#0f1115) 6%,transparent)}
.sm-surf-log-cover-empty{display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--sm-ink3,#8a8f99)}
.sm-surf-log-stills{display:flex;gap:4px;margin-top:6px}
.sm-surf-still{flex:1 1 0;min-width:0;aspect-ratio:16/10;border:0;padding:0;border-radius:4px;cursor:zoom-in;background-color:color-mix(in srgb,var(--sm-ink,#0f1115) 6%,transparent);overflow:hidden}
.sm-surf-still-full{display:block}
.sm-surf-still-full>img{display:block;width:100%;height:100%;object-fit:cover;border-radius:4px}
.sm-surf-stills-all{width:100%;margin-top:6px;height:28px;font-size:12px}
.sm-surf-lightbox{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,10,16,.72)}
.sm-surf-lightbox-inner{position:relative;max-width:min(920px,96vw);max-height:90vh;display:flex;flex-direction:column;align-items:center;gap:12px}
.sm-surf-lightbox-inner>img{max-width:100%;max-height:min(78vh,820px);border-radius:10px;background:#111;object-fit:contain}
.sm-surf-lightbox-crop{border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.35);background-color:#111}
.sm-surf-lightbox-close{min-width:88px}
.sm-surf-lightbox-gallery{width:min(960px,96vw);max-height:90vh;overflow:auto;align-items:stretch;padding:14px;border-radius:12px;background:var(--dsw-alias-bg-base,#fff)}
.sm-surf-gallery-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:4px}
.sm-surf-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.sm-surf-gallery-grid .sm-surf-still{width:100%;aspect-ratio:16/10}
.sm-surf-gallery-focus{display:flex;flex-direction:column;align-items:center;gap:10px;padding:8px 0}
.sm-surf-gallery-focus>img{max-width:min(860px,92vw);max-height:min(70vh,720px);border-radius:10px;background:#111;object-fit:contain}
.sm-surf-log-title a{color:var(--sm-accent,#4d6bfe);font-weight:600;text-decoration:none}
.sm-surf-log-title a:hover{text-decoration:underline}
.sm-surf-log-summary{margin:6px 0;font-size:12.5px;line-height:1.55;color:var(--sm-ink2,#4e5561)}
.sm-surf-log-actions{margin:0;font-size:12px;font-weight:500;color:var(--sm-ink,#0f1115)}
.sm-surf-log-replies{margin:6px 0 0;padding-left:16px;font-size:11.5px;color:var(--sm-ink3,#8a8f99)}
.sm-surf-engage .sm-rhythm-check{margin-top:6px}
/* 形象：已有皮肤切换 */
.sm-sprite-bundled{display:flex;flex-direction:column;gap:6px;margin:0 0 10px}
.sm-sprite-looks{display:flex;flex-wrap:wrap;gap:6px}
.sm-sprite-looks .sm-btn{height:28px;padding:0 10px;font-size:12px}
/* DsBot：多列平台 + 微信会话区 */
.sm-panel-wrap:has(.sm-dsbot-card){max-width:1120px}
.sm-dsbot-card{padding-bottom:12px}
.sm-dsbot-column{min-width:0;display:flex;flex-direction:column;gap:10px}
.sm-dsbot-top{margin-bottom:12px}
.sm-dsbot-title{margin:0 0 4px;font-size:18px;font-weight:700;letter-spacing:.02em}
.sm-dsbot-platforms{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 14px}
@media(max-width:720px){.sm-dsbot-platforms{grid-template-columns:repeat(2,minmax(0,1fr))}}
.sm-dsbot-plat{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px 14px;border:1px solid var(--sm-line,#e3e5e8);border-radius:12px;background:color-mix(in srgb,var(--sm-ink,#0f1115) 1.5%,transparent);cursor:pointer;font:inherit;text-align:left;transition:border-color .15s,background .15s}
.sm-dsbot-plat:hover{background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 6%,transparent)}
.sm-dsbot-plat.on{border-color:color-mix(in srgb,var(--sm-accent,#4d6bfe) 45%,transparent);background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 8%,transparent)}
.sm-dsbot-plat.soon{opacity:.72}
.sm-dsbot-plat-badge{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:6px 12px;border:1.5px solid color-mix(in srgb,var(--sm-accent,#4d6bfe) 40%,transparent);border-radius:8px;font-family:var(--sm-mono);font-size:15px;font-weight:700;line-height:1;letter-spacing:.12em;color:var(--sm-accent,#4d6bfe);background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 6%,transparent)}
.sm-dsbot-plat-badge.lg{min-height:36px;padding:8px 16px;font-size:19px;letter-spacing:.14em;border-radius:10px}
.sm-dsbot-plat-sub{font-size:11.5px;color:var(--sm-ink3,#8a8f99)}
.sm-dsbot-column-head{display:flex;align-items:flex-start;gap:14px;margin:0 0 10px}
.sm-dsbot-column-head h3{margin:0 0 4px;font-size:15px;font-weight:650}
.sm-dsbot-placeholder{padding:28px 16px;border:1px dashed var(--sm-line,#e3e5e8);border-radius:12px;text-align:center}
.sm-dsbot-placeholder>p{margin:0 0 6px}
.sm-dsbot-card .sm-dsbot-note{margin:0 0 10px;font-size:11.5px;line-height:1.55}
.sm-dsbot-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.sm-dsbot-qr{margin-top:12px;display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.sm-dsbot-qr>img{border-radius:8px;background:#fff;padding:8px;box-sizing:content-box}
.sm-dsbot-enable{margin-top:14px;padding-top:12px;border-top:1px solid var(--sm-line,#e3e5e8)}
.sm-dsbot-send{margin-top:14px;padding-top:12px;border-top:1px solid var(--sm-line,#e3e5e8)}
.sm-dsbot-send .sm-panel-h3{margin:0 0 8px;font-size:13px;font-weight:600}
.sm-dsbot-send .sm-panel-field{margin-top:8px}
.sm-dsbot-chat{display:grid;grid-template-columns:minmax(200px,28%) minmax(0,1fr);gap:0;margin-top:14px;border:1px solid var(--sm-line,#e3e5e8);border-radius:12px;overflow:hidden;min-height:min(68vh,720px);height:min(68vh,720px);background:color-mix(in srgb,var(--sm-ink,#0f1115) 1.5%,transparent)}
@media(max-width:640px){.sm-dsbot-chat{grid-template-columns:1fr;min-height:min(72vh,640px);height:min(72vh,640px)}}
.sm-dsbot-peers{border-right:1px solid var(--sm-line,#e3e5e8);display:flex;flex-direction:column;height:100%;overflow:auto;background:color-mix(in srgb,var(--sm-ink,#0f1115) 2%,transparent)}
.sm-dsbot-peers-head{padding:10px 12px;font-size:12px;font-weight:600;color:var(--sm-ink2,#4e5561);border-bottom:1px solid var(--sm-line,#e3e5e8)}
.sm-dsbot-peer{display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:2px 8px;width:100%;text-align:left;padding:10px 12px;border:0;border-bottom:1px solid var(--sm-line,#e3e5e8);background:transparent;color:inherit;font:inherit;cursor:pointer}
.sm-dsbot-peer:hover{background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 6%,transparent)}
.sm-dsbot-peer.on{background:color-mix(in srgb,var(--sm-accent,#4d6bfe) 10%,transparent)}
.sm-dsbot-peer-name{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-dsbot-peer-time{font-size:10.5px;color:var(--sm-ink3,#8a8f99);font-variant-numeric:tabular-nums}
.sm-dsbot-peer-preview{grid-column:1/-1;font-size:11.5px;color:var(--sm-ink3,#8a8f99);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-dsbot-thread{display:flex;flex-direction:column;height:100%;min-height:0}
.sm-dsbot-thread-head{padding:10px 12px;font-size:12.5px;font-weight:600;border-bottom:1px solid var(--sm-line,#e3e5e8);flex:none}
.sm-dsbot-load-older{align-self:center;margin:8px 0 0;height:26px;padding:0 10px;font-size:11.5px;flex:none}
.sm-dsbot-msgs{flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px;min-height:0}
.sm-dsbot-bubble-row{display:flex;flex-direction:column;max-width:78%}
.sm-dsbot-bubble-row.user{align-self:flex-end;align-items:flex-end}
.sm-dsbot-bubble-row.bot{align-self:flex-start;align-items:flex-start}
.sm-dsbot-bubble{padding:10px 12px;border-radius:12px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.sm-dsbot-bubble-row.user .sm-dsbot-bubble{background:color-mix(in srgb,#95ec69 88%,#fff);color:#0f1115;border-bottom-right-radius:4px}
.sm-dsbot-bubble-row.bot .sm-dsbot-bubble{background:#fff;border:1px solid var(--sm-line,#e3e5e8);border-bottom-left-radius:4px}
.sm-dsbot-bubble-row>time{margin-top:3px;font-size:10.5px;color:var(--sm-ink3,#8a8f99)}
.sm-dsbot-composer{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--sm-line,#e3e5e8);flex:none}
.sm-dsbot-composer .sm-panel-input{flex:1;height:36px}
`

    function injectStyles() {
      if (typeof document === 'undefined') return () => {}

      // A constructable stylesheet is not an inline style, so it survives the nonce-based
      // style-src policy the desktop shell serves (a plain <style> element is dropped there,
      // which is why the widget used to render as bare HTML). Adopted sheets also win ties
      // against the host's own author styles, so no !important is needed.
      try {
        if (typeof CSSStyleSheet === 'function' && typeof document.adoptedStyleSheets !== 'undefined') {
          const sheet = new CSSStyleSheet()
          sheet.replaceSync(CSS)
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
          return () => {
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter((candidate) => candidate !== sheet)
          }
        }
      } catch (err) {
        console.warn('[soulmate] constructable stylesheet unavailable, falling back to <style>:', err)
      }

      // Fallback: a <style> element that carries the host's CSP nonce when it publishes one.
      // An existing tag is refreshed in place instead of trusted: a stale tag from an earlier
      // module generation would otherwise pin the page to outdated rules forever.
      const selector = 'style[data-plugin-css="' + CSS_KEY + '"]'
      let tag = document.querySelector(selector)
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.pluginCss = CSS_KEY
        const meta = document.querySelector('meta[property="csp-nonce"]')
        const nonce = meta && (meta.nonce || meta.getAttribute('nonce') || meta.getAttribute('content'))
        if (nonce) tag.setAttribute('nonce', nonce)
        document.head.appendChild(tag)
      }
      tag.textContent = CSS
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

module.exports = { CSS, injectStyles }
