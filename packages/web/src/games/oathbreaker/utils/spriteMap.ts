// Sprite map for OATHBREAKER characters
// 9 characters from Yie Ar Kung-Fu sprite sheet, pre-cut as individual PNGs

export type Pose = 'idle' | 'attack' | 'hit' | 'victory';

export interface CharacterDef {
  name: string;
  displayName: string;
  /** Base path relative to /assets/oathbreaker/characters/ */
  baseName: string;
}

export const CHARACTERS: CharacterDef[] = [
  { name: 'buchu', displayName: 'Buchu', baseName: 'buchu' },
  { name: 'star', displayName: 'Star', baseName: 'star' },
  { name: 'oolong', displayName: 'Oolong', baseName: 'oolong' },
  { name: 'nuncha', displayName: 'Nuncha', baseName: 'nuncha' },
  { name: 'fan', displayName: 'Fan', baseName: 'fan' },
  { name: 'chain', displayName: 'Chain', baseName: 'chain' },
  { name: 'sword', displayName: 'Sword', baseName: 'sword' },
  { name: 'tonfun', displayName: 'Tonfun', baseName: 'tonfun' },
  { name: 'blues', displayName: 'Blues', baseName: 'blues' },
];

export function getSpritePath(character: string, pose: Pose): string {
  return `/assets/oathbreaker/characters/${character}-${pose}.png`;
}
