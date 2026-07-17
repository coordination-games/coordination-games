import { parseTuning, TUNING_KEYS } from './model-profile-schema.js';
import type { NamedModelProfiles, ResolvedModelProfile } from './model-profile-types.js';

export function resolveModelProfile(
  profiles: NamedModelProfiles,
  profileName: string,
  overrides: Record<string, unknown>,
  where: string,
): ResolvedModelProfile {
  const profile = profiles[profileName];
  if (!profile)
    throw new Error(
      `model profiles: ${where}.profile references undefined profile "${profileName}"`,
    );
  for (const key of Object.keys(overrides)) {
    if (!(TUNING_KEYS as readonly string[]).includes(key))
      throw new Error(`model profiles: ${where}.${key} is not allowed`);
  }
  return { ...profile, ...parseTuning(overrides, where) };
}
