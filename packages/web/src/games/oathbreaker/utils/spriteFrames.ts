/**
 * Frame-by-frame animation data extracted from sprites-original.png (616×608).
 * Background color: RGB(245, 186, 254).
 *
 * Each frame is { x, y, w, h } — pixel coordinates in the sprite sheet.
 * Characters have actions: idle (2-3 frames looping), attack (3-4 frames),
 * hit (2 frames), victory (1-2 frames).
 */

export interface SpriteFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CharacterFrames {
  idle: SpriteFrame[];
  attack: SpriteFrame[];
  hit: SpriteFrame[];
  victory: SpriteFrame[];
}

export const SPRITE_SHEET = '/assets/oathbreaker/sprites.png';
export const SPRITE_SHEET_WIDTH = 616;
export const SPRITE_SHEET_HEIGHT = 608;

// Background color for transparency masking (not needed with CSS clip, but noted)
export const BG_COLOR = { r: 245, g: 186, b: 254 };

/**
 * Frame map per character. Frames are ordered as animation sequences.
 *
 * Mapping methodology:
 * - Row boundaries detected automatically from the sprite sheet
 * - Character-to-row assignment verified by comparing with existing static PNGs
 * - Action classification based on visual frame analysis and Yie Ar Kung-Fu move sets
 *
 * Row assignments:
 *   buchu: rows 0-1 | star: row 2 | oolong: rows 3, 12
 *   nuncha: row 4   | fan: rows 5, 7 | chain: rows 6, 11
 *   sword: row 8    | tonfun: row 9  | blues: row 10
 */
export const CHARACTER_FRAMES: Record<string, CharacterFrames> = {
  buchu: {
    // Row 0: y=8, h=33 — 10 frames (idle stance, walk, grab)
    // Row 1: y=48, h=32 — 8 frames (attacks, hit, jump)
    idle: [
      { x: 8, y: 8, w: 30, h: 33 }, // standing stance 1
      { x: 48, y: 8, w: 25, h: 33 }, // standing stance 2 (slight shift)
      { x: 80, y: 8, w: 29, h: 33 }, // standing stance 3
    ],
    attack: [
      { x: 200, y: 8, w: 32, h: 33 }, // wind-up (arms wide)
      { x: 240, y: 8, w: 28, h: 33 }, // grab
      { x: 280, y: 8, w: 28, h: 33 }, // squeeze
      { x: 8, y: 48, w: 32, h: 32 }, // slam
    ],
    hit: [
      { x: 200, y: 48, w: 41, h: 32 }, // recoil
      { x: 248, y: 48, w: 29, h: 32 }, // stumble
    ],
    victory: [
      { x: 320, y: 8, w: 32, h: 33 }, // arms raised
      { x: 360, y: 8, w: 31, h: 33 }, // victory pose
    ],
  },

  star: {
    // Row 2: y=88, h=32 — 9 frames (acrobatic poses, star throws)
    idle: [
      { x: 8, y: 88, w: 26, h: 32 }, // stance 1
      { x: 48, y: 88, w: 30, h: 32 }, // stance 2
    ],
    attack: [
      { x: 88, y: 88, w: 31, h: 32 }, // wind-up
      { x: 128, y: 88, w: 32, h: 32 }, // throw
      { x: 168, y: 88, w: 28, h: 32 }, // follow-through
    ],
    hit: [
      { x: 248, y: 88, w: 32, h: 32 }, // hit recoil
      { x: 288, y: 88, w: 30, h: 32 }, // stumble
    ],
    victory: [
      { x: 208, y: 88, w: 32, h: 32 }, // pose
    ],
  },

  oolong: {
    // Row 3: y=128, h=40 — 9 frames (player character, punches, kicks)
    // Row 12: y=496, h=32 — 11 frames (more moves)
    idle: [
      { x: 8, y: 128, w: 32, h: 40 }, // fighting stance 1
      { x: 48, y: 128, w: 32, h: 40 }, // fighting stance 2
      { x: 88, y: 128, w: 30, h: 40 }, // stance 3
    ],
    attack: [
      { x: 128, y: 128, w: 48, h: 40 }, // kick wind-up
      { x: 184, y: 128, w: 32, h: 40 }, // kick
      { x: 224, y: 128, w: 32, h: 40 }, // punch
      { x: 264, y: 128, w: 32, h: 40 }, // follow-through
    ],
    hit: [
      { x: 304, y: 128, w: 32, h: 40 }, // hit
      { x: 344, y: 128, w: 32, h: 40 }, // recoil
    ],
    victory: [
      { x: 8, y: 496, w: 32, h: 32 }, // victory stance
      { x: 48, y: 496, w: 29, h: 32 }, // arms up
    ],
  },

  nuncha: {
    // Row 4: y=176, h=32 — 14 frames (nunchaku moves, fast character)
    idle: [
      { x: 8, y: 176, w: 24, h: 32 }, // stance 1
      { x: 40, y: 176, w: 24, h: 32 }, // stance 2
      { x: 72, y: 176, w: 24, h: 32 }, // stance 3
    ],
    attack: [
      { x: 136, y: 176, w: 25, h: 32 }, // swing up
      { x: 168, y: 176, w: 25, h: 32 }, // swing across
      { x: 200, y: 176, w: 31, h: 32 }, // strike
      { x: 240, y: 176, w: 26, h: 32 }, // follow-through
    ],
    hit: [
      { x: 392, y: 176, w: 20, h: 32 }, // hit
      { x: 424, y: 176, w: 30, h: 32 }, // recoil
    ],
    victory: [
      { x: 280, y: 176, w: 31, h: 32 }, // spin
      { x: 320, y: 176, w: 24, h: 32 }, // pose
    ],
  },

  fan: {
    // Row 5: y=216, h=32 — 13 frames
    // Row 7: y=296, h=32 — 14 frames (fan weapon throws)
    idle: [
      { x: 8, y: 216, w: 30, h: 32 }, // stance 1
      { x: 48, y: 216, w: 26, h: 32 }, // stance 2
    ],
    attack: [
      { x: 128, y: 216, w: 29, h: 32 }, // wind-up
      { x: 168, y: 216, w: 29, h: 32 }, // swing
      { x: 208, y: 216, w: 29, h: 32 }, // strike
      { x: 248, y: 216, w: 31, h: 32 }, // follow-through
    ],
    hit: [
      { x: 440, y: 216, w: 24, h: 32 }, // hit
      { x: 472, y: 216, w: 28, h: 32 }, // stumble
    ],
    victory: [
      { x: 88, y: 216, w: 29, h: 32 }, // pose
    ],
  },

  chain: {
    // Row 6: y=256, h=32 — 12 frames
    // Row 11: y=456, h=32 — 9 frames (extended chain attacks)
    idle: [
      { x: 8, y: 256, w: 32, h: 32 }, // stance 1
      { x: 48, y: 256, w: 32, h: 32 }, // stance 2
      { x: 88, y: 256, w: 32, h: 32 }, // stance 3
    ],
    attack: [
      { x: 168, y: 256, w: 30, h: 32 }, // swing up
      { x: 208, y: 256, w: 29, h: 32 }, // swing across
      { x: 248, y: 256, w: 32, h: 32 }, // chain strike
      { x: 328, y: 256, w: 41, h: 32 }, // extended reach
    ],
    hit: [
      { x: 416, y: 256, w: 48, h: 32 }, // hit (wide)
      { x: 472, y: 256, w: 32, h: 32 }, // recoil
    ],
    victory: [
      { x: 128, y: 256, w: 30, h: 32 }, // chain swirl
      { x: 288, y: 256, w: 32, h: 32 }, // pose
    ],
  },

  sword: {
    // Row 8: y=336, h=32 — 8 frames
    idle: [
      { x: 8, y: 336, w: 32, h: 32 }, // stance
      { x: 48, y: 336, w: 32, h: 32 }, // slight shift
    ],
    attack: [
      { x: 88, y: 336, w: 32, h: 32 }, // raise sword
      { x: 129, y: 336, w: 31, h: 32 }, // swing
      { x: 168, y: 336, w: 48, h: 32 }, // slash (wide)
    ],
    hit: [
      { x: 264, y: 336, w: 32, h: 32 }, // hit
      { x: 304, y: 336, w: 32, h: 32 }, // stumble
    ],
    victory: [
      { x: 224, y: 336, w: 32, h: 32 }, // sword raised
    ],
  },

  tonfun: {
    // Row 9: y=376, h=32 — 9 frames
    idle: [
      { x: 8, y: 376, w: 23, h: 32 }, // stance 1
      { x: 40, y: 376, w: 26, h: 32 }, // stance 2
    ],
    attack: [
      { x: 112, y: 376, w: 28, h: 32 }, // wind-up
      { x: 152, y: 376, w: 28, h: 32 }, // swing
      { x: 192, y: 376, w: 32, h: 32 }, // tonfa strike
    ],
    hit: [
      { x: 272, y: 376, w: 32, h: 32 }, // hit
      { x: 312, y: 376, w: 31, h: 32 }, // recoil
    ],
    victory: [
      { x: 232, y: 376, w: 30, h: 32 }, // pose
    ],
  },

  blues: {
    // Row 10: y=416, h=32 — 13 frames (boss, many attack types)
    idle: [
      { x: 8, y: 416, w: 32, h: 32 }, // stance 1
      { x: 48, y: 416, w: 30, h: 32 }, // stance 2
    ],
    attack: [
      { x: 144, y: 416, w: 32, h: 32 }, // wind-up
      { x: 184, y: 416, w: 48, h: 32 }, // flying kick
      { x: 240, y: 416, w: 48, h: 32 }, // strike
      { x: 296, y: 416, w: 32, h: 32 }, // follow-through
    ],
    hit: [
      { x: 456, y: 416, w: 32, h: 32 }, // hit
      { x: 496, y: 416, w: 31, h: 32 }, // stumble
    ],
    victory: [
      { x: 88, y: 416, w: 48, h: 32 }, // arms wide
      { x: 536, y: 416, w: 32, h: 32 }, // final pose
    ],
  },
};
