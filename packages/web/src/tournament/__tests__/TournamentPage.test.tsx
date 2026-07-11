import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TournamentPage from '../../pages/TournamentPage';

function runningPayload() {
  return {
    tournamentId: 'trn-42',
    gameType: 'tragedy-of-the-commons',
    standings: [
      { playerId: 'alice', cumulativeDelta: '1200', gamesPlayed: 1 },
      { playerId: 'bob', cumulativeDelta: '-300', gamesPlayed: 1 },
    ],
    activePlayerIds: ['alice', 'bob'],
    eliminatedPlayerIds: [],
    currentGameId: 'game-1',
    currentGameIndex: 1,
    gameIds: ['game-0', 'game-1'],
    policy: { baseEntryCost: '1000', carryBps: '250', slashBps: '500' },
    treasuryCarry: '450',
    currentEconomics: {
      baseEntryCost: '1000',
      entryCost: '1000',
      playerCount: 2,
      basePot: '2000',
      incomingCarry: '0',
      releasedCarry: '0',
      carryRemainder: '0',
      carry: '50',
      slash: '100',
      treasuryDelta: '150',
    },
    lastSettlement: null,
    status: 'running',
  };
}

function completedPayload() {
  return {
    ...runningPayload(),
    currentGameId: null,
    activePlayerIds: ['alice'],
    eliminatedPlayerIds: ['bob'],
    currentEconomics: null,
    lastSettlement: {
      gameId: 'game-1',
      gameIndex: 1,
      txHash: '0xabc123def456789000',
      blockNumber: 42,
      entryCost: '1000',
      carry: '50',
      slash: '100',
      treasuryDelta: '150',
    },
    status: 'completed',
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tournaments/trn-42']}>
      <Routes>
        <Route path="/tournaments/:id" element={<TournamentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TournamentPage states', () => {
  it('shows the loading state before the first response resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    renderPage();
    expect(screen.getByText(/Loading tournament/i)).toBeTruthy();
  });

  it('renders a running tournament: header, standings, policy, economics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(runningPayload()), { status: 200 })),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('trn-42')).toBeTruthy());
    expect(screen.getByText('Running')).toBeTruthy();
    // Standings ordered as API: alice before bob.
    const rows = screen.getAllByRole('row');
    expect(rows[1]?.textContent).toContain('alice');
    expect(rows[2]?.textContent).toContain('bob');
    // Policy percentages.
    expect(screen.getByText('2.5%')).toBeTruthy();
    expect(screen.getByText('5%')).toBeTruthy();
    // Economics present, no-receipt note shown.
    expect(screen.getByText('Current economics')).toBeTruthy();
    expect(screen.getByText(/No settlement yet/i)).toBeTruthy();
  });

  it('renders a completed tournament with eliminated player and settlement receipt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(completedPayload()), { status: 200 })),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('Completed')).toBeTruthy());
    expect(screen.getByText('Eliminated')).toBeTruthy();
    // Receipt shortened hash + copy affordance.
    expect(screen.getByText('0xabc123…789000')).toBeTruthy();
    const copyBtn = screen.getByLabelText(/Copy full transaction hash/i);
    expect(copyBtn).toBeTruthy();
  });

  it('shows the error state when the first fetch fails with no prior data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500, statusText: 'Server Error' })),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/Could not load tournament/i)).toBeTruthy());
  });
});
