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
/** Assets root: extra pet-<id>/ packs copied here are discovered at request time. */
export const PET_ASSETS_ROOT = fileURLToPath(new URL('../../assets/', import.meta.url));
/** Optional packs are published as GitHub Release assets, never as npm payload. */
export const PET_PACK_RELEASE_TAG = 'pet-packs-v2';
export const PET_PACK_BASE_URL = 'https://github.com/JasperGuWP/dsh-plugin-whale-soulmate/releases/download/' + PET_PACK_RELEASE_TAG + '/';
/**
 * Downloadable skin registry. `bytes` and `sha256` are filled by
 * `node scripts/pack-pet-skins.mjs` after the release archives are built.
 * Keep the ids/labels in sync with the source folders in assets/.
 */
export const PET_DOWNLOADABLE_SKINS = Object.freeze({
  'blue-winter': {
    label: '蓝色冬装',
    filename: 'pet-blue-winter.tar.gz',
    bytes: 8504827,
    sha256: 'f9a0bacff7c39634aacdaedcd521cb167a4e64ac1688514744935e4236c6cefe',
  },
  'butler-cool': {
    label: '高冷眼镜执事',
    filename: 'pet-butler-cool.tar.gz',
    bytes: 9738605,
    sha256: 'e609fc7d3e5b7d2da82fb8c7f78861ca4591a1dba79ac5ad5dd643540fda4a77',
  },
  'maid-deepsea': {
    label: '深海经典',
    filename: 'pet-maid-deepsea.tar.gz',
    bytes: 13643680,
    sha256: '26d8178473d1b993056c8ef751c109ad3ecaf634c7863707aff8c70f5cee9d88',
  },
  'maid-soda': {
    label: '海盐苏打',
    filename: 'pet-maid-soda.tar.gz',
    bytes: 14217790,
    sha256: 'd599018b993c785ab01ef6547e9d8fbdab57baf008eced7146cae4203daef57e',
  },
  'maid-starnight': {
    label: '午夜星空',
    filename: 'pet-maid-starnight.tar.gz',
    bytes: 15826592,
    sha256: '83440d8dbac8c49577c119eb026adde3cb36480aa763fb715f1e5a7fe998f4df',
  },
});
/** Skin id whitelist for discovered packs (folder name must be 'pet-' + id). */
export const PET_SKIN_ID = /^[a-z0-9][a-z0-9-]*$/;
export const PET_FRAME_ID = /^pet-[a-z0-9-]+$/;
/** Pet video assets: basename whitelist + MIME for the transparent-video route. */
export const PET_VIDEO_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const PET_VIDEO_MIME = { webm: 'video/webm', mov: 'video/quicktime' };
