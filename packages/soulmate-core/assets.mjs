// Bundled asset locations (paths only — no I/O). Resolved relative to this file,
// so moving the assembly around never breaks the packaged assets/ directory.

import { fileURLToPath } from 'node:url';

/** Bundled default sticker — always named 小鲸.png in the user's soulmate home. */
export const BUNDLED_SPRITE = fileURLToPath(new URL('../../assets/小鲸.png', import.meta.url));
export const DEFAULT_SPRITE_URL = '/dsh-soulmate/api/sprite';
/** Bundled male default sticker — copied to ~/.dsh/soulmate/小鲸-male.jpg on bootstrap. */
export const BUNDLED_SPRITE_MALE = fileURLToPath(new URL('../../assets/小鲸-male.jpg', import.meta.url));
export const DEFAULT_SPRITE_MALE_URL = '/dsh-soulmate/api/sprite-male';
/** Bundled desktop-pet sprite pack: transparent PNG frames + pet.json state-machine config.
 *  Only the chibi winter boy ships now; retired skins (classic/underwater/hanfu/winterboy)
 *  were archived out of the repo and alias to this skin in asset-routes. */
export const PET_WINTERBOY_CHIBI_DIR = fileURLToPath(new URL('../../assets/pet-winterboy-chibi/', import.meta.url));
export const PET_SKINS = { 'winterboy-chibi': PET_WINTERBOY_CHIBI_DIR };
export const PET_FRAME_ID = /^pet-[a-z0-9-]+$/;
/** Pet video assets: basename whitelist + MIME for the transparent-video route. */
export const PET_VIDEO_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const PET_VIDEO_MIME = { webm: 'video/webm', mov: 'video/quicktime' };
