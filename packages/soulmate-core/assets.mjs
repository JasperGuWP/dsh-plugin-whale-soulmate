// Bundled asset locations (paths only — no I/O). Resolved relative to this file,
// so moving the assembly around never breaks the packaged assets/ directory.

import { fileURLToPath } from 'node:url';

/** Bundled default sticker — always named 小鲸.png in the user's soulmate home. */
export const BUNDLED_SPRITE = fileURLToPath(new URL('../../assets/小鲸.png', import.meta.url));
export const DEFAULT_SPRITE_URL = '/dsh-soulmate/api/sprite';
/** Bundled male default sticker — legacy full-body JPG, kept for migration only. */
export const BUNDLED_SPRITE_MALE = fileURLToPath(new URL('../../assets/小鲸-male.jpg', import.meta.url));
export const DEFAULT_SPRITE_MALE_URL = '/dsh-soulmate/api/sprite-male';
/** Bundled male default sticker — Q版 winter-boy drag pose (gender-linked default). */
export const BUNDLED_SPRITE_CHIBI = fileURLToPath(new URL('../../assets/pet-winterboy-chibi/pet-drag.png', import.meta.url));
/** Bundled female default sticker — hanfu ruqun girl drag pose (gender-linked default). */
export const BUNDLED_SPRITE_HANFU = fileURLToPath(new URL('../../assets/pet-hanfu/pet-drag.png', import.meta.url));
/** Gender → desktop-pet skin: the corner companion follows the chosen gender. */
export const GENDER_PET_SKIN = Object.freeze({ female: 'hanfu', male: 'winterboy-chibi' });
/** Bundled desktop-pet sprite pack: transparent PNG frames + pet.json state-machine config.
 *  Two skins ship: the chibi winter boy (default) and the hanfu ruqun girl; retired
 *  skins (classic/underwater/winterboy) were archived out and alias in asset-routes. */
export const PET_WINTERBOY_CHIBI_DIR = fileURLToPath(new URL('../../assets/pet-winterboy-chibi/', import.meta.url));
export const PET_HANFU_DIR = fileURLToPath(new URL('../../assets/pet-hanfu/', import.meta.url));
export const PET_SKINS = { 'winterboy-chibi': PET_WINTERBOY_CHIBI_DIR, hanfu: PET_HANFU_DIR };
export const PET_FRAME_ID = /^pet-[a-z0-9-]+$/;
/** Pet video assets: basename whitelist + MIME for the transparent-video route. */
export const PET_VIDEO_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const PET_VIDEO_MIME = { webm: 'video/webm', mov: 'video/quicktime' };
