// 形象与桌宠合并卡(含皮肤目录/预览回落):从 panel-forms 拆出,守住模块行数门禁。
const React = require('react')
const h = React.createElement
const { DEFAULT_SPRITE_URL } = require('./panel-draft.mjs')

function field(key, label, control) {
  return h('label', { key, className: 'sm-panel-field' }, [
    h('span', { key: 'label' }, label),
    control,
  ])
}

/** Bundled static looks — same ids as desktop-pet skins. */
const BUNDLED_LOOKS = [
  {
    id: 'hanfu',
    label: '汉风 · 襦裙',
    preview: '/dsh-soulmate/api/pet/frame?id=pet-idle-01&skin=hanfu',
  },
  {
    id: 'winterboy-chibi',
    label: 'Q版 · 冬装男孩',
    preview: '/dsh-soulmate/api/pet/frame?id=pet-idle-01&skin=winterboy-chibi',
  },
]

/** 皮肤静帧:目录带 preview 就用,否则按 idle 首帧拼 URL(新皮肤无需改前端)。 */
function skinFrameUrl(skin, looks) {
  const id = String(skin || '').trim()
  if (!id) return ''
  const hit = (looks || []).find((item) => item.id === id)
  if (hit && hit.preview) return hit.preview
  return '/dsh-soulmate/api/pet/frame?id=pet-idle-01&skin=' + encodeURIComponent(id)
}

/** 形象 + 桌面小伙伴合并为一张卡:一个预览、一个形象下拉,开关/尺寸/上传都在同一列。 */
function lookPetCard({
  draft, petDraft, patchPet, spriteNote, restoreDefaultSprite,
  selectBundledLook, looks, PetPreview, defaultSpriteUrl,
}) {
  // Dynamic catalog from /api/pet/skins when available; bundled list is the fallback.
  const lookList = (looks && looks.length) ? looks : BUNDLED_LOOKS
  const currentSkin = petDraft.skin || (lookList[0] && lookList[0].id) || 'winterboy-chibi'
  const customSrc = draft.appearance.customSpriteUrl
  const isUpload = !!(draft.appearance.spriteIsUpload && customSrc)
  // 预览/头像跟随当前皮肤:自定义上传图优先;否则皮肤静帧;开启动画时播 idle 视频。
  const skinSrc = skinFrameUrl(currentSkin, lookList)
  const staticSrc = skinSrc || customSrc || defaultSpriteUrl || DEFAULT_SPRITE_URL
  const previewEl = isUpload
    ? h('img', { key: 'preview', className: 'sm-sprite-preview', src: customSrc, alt: '形象' })
    : (petDraft.enabled && PetPreview)
      ? h(PetPreview, { key: 'preview', skin: currentSkin, fallback: staticSrc })
      : h('img', { key: 'preview', className: 'sm-sprite-preview', src: staticSrc, alt: '形象' })
  const skinOptions = lookList.map((s) => h('option', { key: s.id, value: s.id }, s.label || s.id))
  // A saved skin missing from the catalog still renders as a selectable option.
  if (!lookList.some((s) => s.id === currentSkin)) {
    skinOptions.unshift(h('option', { key: currentSkin, value: currentSkin }, currentSkin))
  }
  return h('div', { key: 'lookpet', className: 'sm-panel-card' }, [
    h('h3', { key: 'h', className: 'sm-panel-h3' }, '形象与桌面小伙伴'),
    h('div', { key: 'row', className: 'sm-sprite-row' }, [
      previewEl,
      h('div', { key: 'ops', className: 'sm-sprite-ops sm-pet-ops' }, [
        field('petskin', '已有形象 / 皮肤', h('select', {
          key: 'control', className: 'sm-panel-input',
          value: currentSkin,
          onChange: (event) => {
            const id = event.target.value
            const look = lookList.find((item) => item.id === id)
            if (look && selectBundledLook) selectBundledLook(look)
            else patchPet({ skin: id, skinAuto: false })
          },
        }, skinOptions)),
        h('label', { key: 'on' }, [
          h('input', {
            key: 'i', type: 'checkbox', checked: !!petDraft.enabled,
            onChange: (event) => patchPet({ enabled: event.target.checked }),
          }),
          h('span', { key: 't' }, '开启动画形象'),
        ]),
        h('label', { key: 'win' }, [
          h('input', {
            key: 'i', type: 'checkbox', checked: !!petDraft.windowEnabled,
            onChange: (event) => patchPet({ windowEnabled: event.target.checked }),
          }),
          h('span', { key: 't' }, '桌面独立窗口（透明置顶，可与页内同时开）'),
        ]),
        field('petsize', '尺寸 ' + petDraft.sizePx + ' 像素（高；滚轮也可缩放）', h('input', {
          key: 'control', type: 'range', min: 96, max: 320, step: 4,
          value: Math.min(320, Math.max(96, Number(petDraft.sizePx) || 148)),
          onChange: (event) => patchPet({ sizePx: Number(event.target.value) }),
        })),
        h('button', {
          key: 'restore', type: 'button', className: 'sm-panel-btn',
          onClick: () => restoreDefaultSprite(),
        }, '恢复默认'),
        h('p', { key: 'tip', className: 'sm-panel-muted' },
          spriteNote || '选已有形象会同步页内头像与桌面小伙伴皮肤；「恢复默认」按性别回到默认静图与皮肤。'),
        h('p', { key: 'tip2', className: 'sm-panel-muted' },
          '预览优先播皮肤 idle 透明视频；没有视频才轮播 PNG。开启后右下角会动：可拖动、甩出去弹跳、滚轮缩放。「桌面独立窗口」把同一只小伙伴放到桌面透明置顶窗里，两个形态各有开关、可同时开。切换性别会自动换上对应皮肤；手动选皮肤则固定不跟随。'),
      ]),
    ]),
  ])
}

module.exports = { field, BUNDLED_LOOKS, skinFrameUrl, lookPetCard }
