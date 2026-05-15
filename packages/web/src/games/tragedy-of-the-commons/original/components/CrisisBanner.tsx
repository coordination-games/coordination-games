import { useGameStore } from '../store';

export function CrisisBanner() {
  const activeCrisis = useGameStore((state) => state.gameState.activeCrisis);

  if (!activeCrisis) return null;

  return (
    <div className="w-full px-4 py-2.5 rounded-xl border border-[rgba(217,113,99,0.28)] shadow-[0_4px_12px_rgba(0,0,0,0.24)] bg-[linear-gradient(135deg,rgba(106,42,36,0.9),rgba(52,18,18,0.9))] backdrop-blur-[10px] overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="font-mono text-[9px] tracking-[0.16em] uppercase text-[#efc0b8]">
          Commons Warning
        </div>
        <div className="font-serif text-[15px] text-[#fff4ec]">
          {activeCrisis.name || activeCrisis.type || 'Active crisis'}
        </div>
      </div>
      <div className="mt-1 text-[11px] leading-[1.35] text-[#e8cfc9]">
        {activeCrisis.description || ''}
      </div>
    </div>
  );
}
