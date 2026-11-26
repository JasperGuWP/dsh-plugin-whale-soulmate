// Tool assembly: every model tool is defined in its domain module; this file only
// gathers them in registration order and exposes the route-facing facades.

import { memoryTools } from './memory-tools.mjs';
import { personaTools } from './persona-tools.mjs';
import { videoTools } from './video-tools.mjs';
import { imTools } from './im-tools.mjs';
import { qqTools } from './qq-tools.mjs';
import { weatherTools } from './weather-tools.mjs';

export { personaBrief } from './persona-tools.mjs';

export function buildTools(deps) {
  const memory = memoryTools(deps);
  const persona = personaTools(deps);
  const video = videoTools(deps);
  const im = imTools(deps);
  const qq = qqTools(deps);
  const weather = weatherTools(deps);
  return {
    tools: [...memory, ...persona.tools, ...video.tools, ...im.tools, ...qq.tools, ...weather],
    evolveOrReset: persona.evolveOrReset,
    videoWatch: video.videoWatch,
    videoSurf: video.videoSurf,
    videoShare: video.videoShare,
    videoConsent: video.videoConsent,
    biliAuthManage: video.biliAuthManage,
    imNet: im.imNet,
    mountIm: im.mountIm,
  };
}
