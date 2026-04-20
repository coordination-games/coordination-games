interface ScrubberSliderProps {
  currentTurn: number;
  totalTurns: number;
  onSeek: (turn: number) => void;
  onPrev: () => void;
  onNext: () => void;
}

export function ScrubberSlider({
  currentTurn,
  totalTurns,
  onSeek,
  onPrev,
  onNext,
}: ScrubberSliderProps) {
  const max = Math.max(0, totalTurns - 1);
  return (
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <button
        type="button"
        onClick={onPrev}
        disabled={currentTurn === 0}
        className="px-2 py-1 text-sm rounded bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Previous turn (Left arrow)"
      >
        &#9664;
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={currentTurn >= max}
        className="px-2 py-1 text-sm rounded bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Next turn (Right arrow)"
      >
        &#9654;
      </button>
      <input
        type="range"
        min={0}
        max={max}
        value={Math.min(currentTurn, max)}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-gray-700
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-4
          [&::-webkit-slider-thumb]:h-4
          [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-emerald-500
          [&::-webkit-slider-thumb]:hover:bg-emerald-400
          [&::-webkit-slider-thumb]:transition-colors
          [&::-moz-range-thumb]:w-4
          [&::-moz-range-thumb]:h-4
          [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:bg-emerald-500
          [&::-moz-range-thumb]:border-0
          [&::-moz-range-thumb]:hover:bg-emerald-400"
      />
      <span className="text-xs text-gray-400 tabular-nums w-14 text-right shrink-0">
        {currentTurn}/{max}
      </span>
    </div>
  );
}
