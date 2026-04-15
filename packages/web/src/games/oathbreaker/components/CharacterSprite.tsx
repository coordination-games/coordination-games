import { useState, useEffect, useMemo } from 'react';
import { getSpritePath, getFacesRight, type Pose } from '../utils/spriteMap';
import { CHARACTER_FRAMES, SPRITE_SHEET, SPRITE_SHEET_WIDTH, SPRITE_SHEET_HEIGHT } from '../utils/spriteFrames';
import { useFrameAnimation } from '../hooks/useFrameAnimation';

interface CharacterSpriteProps {
  character: string;
  pose: Pose;
  /** Which direction the sprite should face in the scene */
  faceRight?: boolean;
  scale?: number;
  tint?: string | null;
  className?: string;
  /** Use animated sprite sheet frames instead of static PNGs. */
  animated?: boolean;
}

export function CharacterSprite({
  character,
  pose,
  faceRight = true,
  scale = 4,
  tint = null,
  className,
  animated = false,
}: CharacterSpriteProps) {
  const naturallyFacesRight = getFacesRight(character);
  const needsFlip = faceRight !== naturallyFacesRight;

  // Get animation frames for this character + pose
  const charFrames = CHARACTER_FRAMES[character];
  const frames = useMemo(() => {
    if (!animated || !charFrames) return null;
    return charFrames[pose] ?? charFrames.idle;
  }, [animated, charFrames, pose]);

  const currentFrame = useFrameAnimation(
    frames ?? [{ x: 0, y: 0, w: 32, h: 32 }],
    { loop: pose === 'idle', paused: !animated || !frames },
  );

  // Static PNG fallback
  const [loaded, setLoaded] = useState(false);
  const src = getSpritePath(character, pose);

  useEffect(() => {
    if (animated && frames) return; // skip PNG loading in animated mode
    setLoaded(false);
    const img = new Image();
    img.onload = () => setLoaded(true);
    img.src = src;
  }, [src, animated, frames]);

  const transform = `scale(${needsFlip ? -scale : scale}, ${scale})`;

  // Animated mode: render via sprite sheet background clipping
  if (animated && frames && currentFrame) {
    return (
      <div
        className={className}
        style={{
          display: 'inline-block',
          width: currentFrame.w,
          height: currentFrame.h,
          backgroundImage: `url(${SPRITE_SHEET})`,
          backgroundPosition: `-${currentFrame.x}px -${currentFrame.y}px`,
          backgroundSize: `${SPRITE_SHEET_WIDTH}px ${SPRITE_SHEET_HEIGHT}px`,
          backgroundRepeat: 'no-repeat',
          transform,
          transformOrigin: 'center bottom',
          imageRendering: 'pixelated',
          filter: tint ?? undefined,
        }}
        role="img"
        aria-label={`${character} ${pose}`}
      />
    );
  }

  // Static PNG mode (fallback)
  return (
    <div
      className={className}
      style={{
        display: 'inline-block',
        transform,
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
