'use strict';
// 整窗穿透判定(纯函数):光标落在宠物身体矩形内(或渲染端正忙)时接住鼠标,否则整窗穿透。
// rect 为渲染端上报的内容区坐标;point 为同坐标系下的光标位置(main 进程换算后传入)。

const BODY_PAD = 6

function pointInRect(rect, point, pad = BODY_PAD) {
  if (!rect || !point) return false
  return point.x >= rect.x - pad && point.x <= rect.x + rect.w + pad
    && point.y >= rect.y - pad && point.y <= rect.y + rect.h + pad
}

/** 下一拍的 ignore 状态:忙(拖拽)时永远接住;否则要求光标既在身体矩形内、
 *  又落在不透明像素上(hit)——包围盒内的透明余量必须穿透到背后内容。 */
function decideIgnore(rect, busy, point, hit) {
  if (busy) return false
  return !(hit && pointInRect(rect, point))
}

module.exports = { pointInRect, decideIgnore, BODY_PAD }