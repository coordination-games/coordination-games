import { useState, useEffect } from 'react';
import { getSpritePath, getFacesRight, type Pose } from '../utils/spriteMap';

interface CharacterSpriteProps {
  character: string;
  pose: Pose;
  /** Which direction the sprite should face in the scene */
  faceRight?: boolean;
  scale?: number;
  tint?: string | null;
  className?: string;
}

export function CharacterSprite({
  character,
  pose,
  faceRight = true,
  scale = 4,
  tint = null,
  className,
}: CharacterSpriteProps) {
  const [loaded, setLoaded] = useState(false);
  const src = getSpritePath(character, pose);

  // Determine if we need to flip: if natural direction differs from desired
  const naturallyFacesRight = getFacesRight(character);
  const needsFlip = faceRight !== naturallyFacesRight;

  useEffect(() => {
    setLoaded(false);
    const img = new Image();
    img.onload = () => setLoaded(true);
    img.src = src;
  }, [src]);

  return (
    <div
      className={className}
      style={{
        display: 'inline-block',
        transform: `scale(${needsFlip ? -scale : scale}, ${scale})`,
        transformOrigin: 'center bottom',
        imageRendering: 'pixelated',
        filter: tint ?? undefined,
        opacity: loaded ? 1 : 0,
        transition: 'opacity 0.2s',
      }}
    >
      <img
        src={src}
        alt={`${character} ${pose}`}
        style={{
          display: 'block',
          imageRendering: 'pixelated',
        }}
        draggable={false}
      />
    </div>
  );
}
