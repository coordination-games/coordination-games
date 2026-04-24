export function SpectatorPendingPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center px-8 py-6">
        <div className="text-5xl md:text-6xl mb-4">🦞</div>
        <div className="text-xl md:text-2xl font-bold text-gray-200 mb-2">{title}</div>
        <div className="text-sm md:text-base text-gray-400">
          Spectator view is delayed — waiting for first turns to resolve...
        </div>
      </div>
    </div>
  );
}
