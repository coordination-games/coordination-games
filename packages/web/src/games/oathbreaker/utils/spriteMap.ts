// Sprite map for OATHBREAKER characters
// 9 characters from Yie Ar Kung-Fu sprite sheet, pre-cut as individual PNGs

export type Pose = 'idle' | 'attack' | 'hit' | 'victory';

export interface CharacterDef {
  name: string;
  displayName: string;
  baseName: string;
  /** True if the sprite naturally faces right in the PNG */
  facesRight: boolean;
}

export const CHARACTERS: CharacterDef[] = [
  { name: 'buchu', displayName: 'Buchu', baseName: 'buchu', facesRight: true },
  { name: 'star', displayName: 'Star', baseName: 'star', facesRight: false },
  { name: 'oolong', displayName: 'Oolong', baseName: 'oolong', facesRight: false },
  { name: 'nuncha', displayName: 'Nuncha', baseName: 'nuncha', facesRight: false },
  { name: 'fan', displayName: 'Fan', baseName: 'fan', facesRight: false },
  { name: 'chain', displayName: 'Chain', baseName: 'chain', facesRight: false },
  { name: 'sword', displayName: 'Sword', baseName: 'sword', facesRight: false },
  { name: 'tonfun', displayName: 'Tonfun', baseName: 'tonfun', facesRight: false },
  { name: 'blues', displayName: 'Blues', baseName: 'blues', facesRight: false },
];

/** Look up a character's natural facing direction */
export function getFacesRight(characterName: string): boolean {
  return CHARACTERS.find(c => c.name === characterName)?.facesRight ?? true;
}

export function getSpritePath(character: string, pose: Pose): string {
  return `/assets/oathbreaker/characters/${character}-${pose}.png`;
}
