/**
 * Chat scope validation — shared between LobbyDO and GameRoomDO.
 *
 * A relay envelope with `type: 'messaging'` carries a `scope` that may be:
 *   - 'all'                 → broadcast to every participant
 *   - 'team'                → sender's team only
 *   - <player display name> → directed message ('dm')
 *
 * Games declare which kinds they support via `CoordinationGame.chatScopes`.
 * 'all' is always accepted regardless — every game has an implicit
 * everyone-broadcast channel. If 'team' isn't in the list, a team-scoped
 * message is rejected; same for 'dm'.
 */

export type ChatScopeKind = 'all' | 'team' | 'dm';

export function classifyScope(scope: string | undefined): ChatScopeKind {
  if (scope === 'all' || scope === undefined || scope === '') return 'all';
  if (scope === 'team') return 'team';
  return 'dm';
}

/**
 * Returns null if the scope is allowed for this game, or an error message
 * string describing why it was rejected. 'all' is always allowed.
 */
export function validateChatScope(
  scope: string | undefined,
  allowed: ReadonlyArray<ChatScopeKind> | undefined,
): string | null {
  const kind = classifyScope(scope);
  if (kind === 'all') return null;
  if (!allowed || allowed.includes(kind)) return null;
  const allowedList = ['all', ...allowed.filter((k) => k !== 'all')].join(', ');
  if (kind === 'team')
    return `Chat scope "team" is not supported in this game. Allowed scopes: ${allowedList}.`;
  return `Chat scope "${scope}" (DM) is not supported in this game. Allowed scopes: ${allowedList}.`;
}
