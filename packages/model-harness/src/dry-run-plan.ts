import { expandSeatPlan } from './spec.js';
import { isTournamentRun } from './tournament-types.js';
import { backendForModel, type CampaignRun } from './types.js';

export function renderDryRunPlan(runs: readonly CampaignRun[]): string {
  const lines = ['\n=== Run plan (dry run) ===\n'];
  const first = runs[0]?.spec;
  if (first) {
    lines.push(`server:     ${first.server}`);
    lines.push(`identities: ${first.identities}`);
    lines.push(`output:     ${first.output}`);
    lines.push(`analysis:   ${first.analysis ? `enabled (${first.analysis.model})` : '(none)'}`);
  }
  const byLabel = new Map<string, CampaignRun[]>();
  for (const run of runs) {
    const group = byLabel.get(run.baseLabel);
    if (group) group.push(run);
    else byLabel.set(run.baseLabel, [run]);
  }
  lines.push(`\nentries:    ${byLabel.size}  |  total runs: ${runs.length}\n`);
  let maximumModelSessions = 0;
  let hasTournament = false;
  for (const [label, group] of byLabel) {
    const spec = group[0]?.spec;
    if (!spec) continue;
    const seats = expandSeatPlan(spec);
    const mix = seats.reduce<Record<string, number>>((accumulator, seat) => {
      accumulator[seat.backend] = (accumulator[seat.backend] ?? 0) + 1;
      return accumulator;
    }, {});
    const mixText = Object.entries(mix)
      .map(([backend, count]) => `${count} ${backend}`)
      .join(', ');
    if (isTournamentRun(spec)) {
      hasTournament = true;
      const { policy } = spec.tournament;
      maximumModelSessions += group.length * policy.seriesLength * seats.length;
      const tournamentMix = renderTournamentMix(spec);
      lines.push(
        `  ${label.padEnd(26)} kind=tournament game=${spec.game} seriesGames=${policy.seriesLength} ×${group.length}  [${tournamentMix}]`,
      );
      lines.push(
        `    hidden rounds=${policy.minRounds}-${policy.maxRounds} hazard=${policy.hazardNumerator}/${policy.hazardDenominator} maxRounds=${policy.maxRounds}`,
      );
      lines.push(
        `    economics baseEntryCost=${policy.baseEntryCost} carryBps=${policy.carryBps} slashBps=${policy.slashBps}`,
      );
      lines.push(`    seats ${renderSeatMatrix(spec)}`);
      continue;
    }
    maximumModelSessions += group.length * seats.length;
    const teamSize = spec.params.teamSize ?? '?';
    lines.push(
      `  ${label.padEnd(26)} game=${spec.game.padEnd(26)} rounds=${String(spec.rounds).padEnd(3)} teamSize=${String(teamSize).padEnd(3)} ×${group.length}  [${mixText}]`,
    );
  }
  if (hasTournament) lines.push(`\nmaximum model sessions: ${maximumModelSessions}`);
  if (runs.length > 12)
    lines.push(
      `\n  ⚠ ${runs.length} runs will execute sequentially — that's a lot. Ctrl-C to abort.`,
    );
  lines.push('');
  return lines.join('\n');
}

function renderSeatMatrix(spec: CampaignRun['spec']): string {
  return spec.seats
    .map((seat) => {
      if (seat.modelConfig) {
        return `${seat.persona} ×${seat.count} -> profile=${seat.profile ?? seat.model} provider=${seat.modelConfig.provider} model=${seat.modelConfig.model}`;
      }
      return `${seat.persona} ×${seat.count} -> ${seat.model}`;
    })
    .join('; ');
}

function renderTournamentMix(spec: CampaignRun['spec']): string {
  const mix = spec.seats.reduce<Record<string, number>>((accumulator, seat) => {
    const provider = seat.modelConfig?.provider ?? backendForModel(seat.model);
    accumulator[provider] = (accumulator[provider] ?? 0) + seat.count;
    return accumulator;
  }, {});
  return Object.entries(mix)
    .map(([provider, count]) => `${count} ${provider}`)
    .join(', ');
}
