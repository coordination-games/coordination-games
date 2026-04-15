import { useState, useEffect, useRef } from 'react';
import type { SpriteFrame } from '../utils/spriteFrames';

/**
 * Cycles through sprite frames at a fixed FPS (default 8fps for retro feel).
 * Returns the current frame to render.
 *
 * When `frames` changes, resets to the first frame.
 * When `loop` is false, stops on the last frame.
 */
export function useFrameAnimation(
  frames: SpriteFrame[],
  options: { fps?: number; loop?: boolean; paused?: boolean } = {},
): SpriteFrame {
  const { fps = 8, loop = true, paused = false } = options;
  const [frameIndex, setFrameIndex] = useState(0);
  const framesRef = useRef(frames);

  // Reset when frames change
  useEffect(() => {
    framesRef.current = frames;
    setFrameIndex(0);
  }, [frames]);

  useEffect(() => {
    if (paused || frames.length <= 1) return;

    const interval = setInterval(() => {
      setFrameIndex(prev => {
        const next = prev + 1;
        if (next >= frames.length) {
          return loop ? 0 : prev; // stop on last frame if not looping
        }
        return next;
      });
    }, 1000 / fps);

    return () => clearInterval(interval);
  }, [frames.length, fps, loop, paused]);

  return frames[Math.min(frameIndex, frames.length - 1)] ?? frames[0];
}
