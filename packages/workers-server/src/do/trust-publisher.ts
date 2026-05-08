import type { DurableObjectStorage } from '@cloudflare/workers-types';
import {
  canonicalizeJson,
  keccak256CanonicalJson,
  type TrustEvidenceEnvelopeV1,
} from '@coordination-games/engine';

import type { Env } from '../env.js';

const LIGHTHOUSE_UPLOAD_URL = 'https://upload.lighthouse.storage/api/v0/add?cid-version=1';
const LIGHTHOUSE_GATEWAY_BASE = 'https://gateway.lighthouse.storage/ipfs';
const DEFAULT_GATEWAY_VERIFY_TIMEOUT_MS = 5000;

export type TrustPublishStatus = 'prepared' | 'uploaded' | 'available' | 'failed' | 'skipped';
export type TrustPublishGatewayStatus = 'pending' | 'available' | 'failed';
export type TrustPublisherName = 'none' | 'lighthouse';

export interface TrustEvidenceBundleV1 {
  readonly version: 'trust-evidence-bundle/v1';
  readonly createdAt: string;
  readonly name: string;
  readonly envelopes: readonly TrustEvidenceEnvelopeV1[];
}

export interface TrustPublishRecord {
  readonly status: TrustPublishStatus;
  readonly publisher: TrustPublisherName;
  readonly gameId: string;
  readonly gameType: string;
  readonly progressCounter: number;
  readonly digest: `0x${string}`;
  readonly byteLength: number;
  readonly envelopeCount: number;
  readonly createdAt: string;
  readonly cid?: string;
  readonly uri?: string;
  readonly gatewayUrl?: string;
  readonly gatewayStatus?: TrustPublishGatewayStatus;
  readonly gatewayVerifiedAt?: string;
  readonly error?: string;
}

export interface PublishTrustEvidenceInput {
  readonly storage: DurableObjectStorage;
  readonly env: Pick<
    Env,
    'LIGHTHOUSE_API_KEY' | 'TRUST_IPFS_PUBLISH_ENABLED' | 'TRUST_IPFS_VERIFY_GATEWAY'
  >;
  readonly gameId: string;
  readonly gameType: string;
  readonly progressCounter: number;
  readonly envelopes: readonly TrustEvidenceEnvelopeV1[];
  readonly now?: string;
  readonly fetcher?: typeof fetch;
}

export interface PublishTrustEvidenceOutput {
  readonly bundle: TrustEvidenceBundleV1 | null;
  readonly record: TrustPublishRecord;
}

export const trustPublishRecordKey = (progressCounter: number): string =>
  `trustPublish:${progressCounter}`;

export const trustEvidenceBundleKey = (progressCounter: number): string =>
  `trustEvidenceBundle:${progressCounter}`;

export async function publishTrustEvidenceBundle(
  input: PublishTrustEvidenceInput,
): Promise<PublishTrustEvidenceOutput> {
  const createdAt = input.now ?? new Date().toISOString();
  const bundle = createTrustEvidenceBundle(input, createdAt);

  if (bundle.envelopes.length === 0) {
    const record = createRecord(input, createdAt, 'skipped', 'none', '0x0', 0, 0);
    await input.storage.put(trustPublishRecordKey(input.progressCounter), record);
    return { bundle: null, record };
  }

  const canonicalJson = canonicalizeJson(bundle);
  const digest = keccak256CanonicalJson(bundle);
  const byteLength = new TextEncoder().encode(canonicalJson).byteLength;
  const recordKey = trustPublishRecordKey(input.progressCounter);
  const bundleKey = trustEvidenceBundleKey(input.progressCounter);
  const existing = await input.storage.get<TrustPublishRecord>(recordKey);

  if (existing?.digest === digest && existing.status !== 'failed') {
    return { bundle, record: existing };
  }

  await input.storage.put(bundleKey, { bundle, canonicalJson });

  const lighthouseApiKey = normalizeSecret(input.env.LIGHTHOUSE_API_KEY);

  if (!isEnabled(input.env.TRUST_IPFS_PUBLISH_ENABLED) || !lighthouseApiKey) {
    const record = createRecord(
      input,
      createdAt,
      'prepared',
      'none',
      digest,
      byteLength,
      bundle.envelopes.length,
    );
    await input.storage.put(recordKey, record);
    return { bundle, record };
  }

  const uploaded = await uploadToLighthouse({
    apiKey: lighthouseApiKey,
    canonicalJson,
    digest,
    fetcher: input.fetcher ?? defaultFetcher,
  });

  if (!uploaded.ok) {
    const record = createRecord(
      input,
      createdAt,
      'failed',
      'lighthouse',
      digest,
      byteLength,
      bundle.envelopes.length,
      { error: uploaded.error },
    );
    await input.storage.put(recordKey, record);
    return { bundle, record };
  }

  const gatewayUrl = `${LIGHTHOUSE_GATEWAY_BASE}/${uploaded.cid}`;
  const gateway = isEnabled(input.env.TRUST_IPFS_VERIFY_GATEWAY)
    ? await verifyGateway(gatewayUrl, input.fetcher ?? defaultFetcher)
    : { status: 'pending' as const };
  const status = gateway.status === 'available' ? 'available' : 'uploaded';
  const record = createRecord(
    input,
    createdAt,
    status,
    'lighthouse',
    digest,
    byteLength,
    bundle.envelopes.length,
    {
      cid: uploaded.cid,
      uri: `ipfs://${uploaded.cid}`,
      gatewayUrl,
      gatewayStatus: gateway.status,
      ...(gateway.verifiedAt ? { gatewayVerifiedAt: gateway.verifiedAt } : {}),
    },
  );
  await input.storage.put(recordKey, record);
  return { bundle, record };
}

function createTrustEvidenceBundle(
  input: PublishTrustEvidenceInput,
  createdAt: string,
): TrustEvidenceBundleV1 {
  return {
    version: 'trust-evidence-bundle/v1',
    createdAt,
    name: `coordination-game-${input.gameId}-progress-${input.progressCounter}`,
    envelopes: input.envelopes,
  };
}

function createRecord(
  input: PublishTrustEvidenceInput,
  createdAt: string,
  status: TrustPublishStatus,
  publisher: TrustPublisherName,
  digest: `0x${string}`,
  byteLength: number,
  envelopeCount: number,
  extra: Partial<TrustPublishRecord> = {},
): TrustPublishRecord {
  return {
    status,
    publisher,
    gameId: input.gameId,
    gameType: input.gameType,
    progressCounter: input.progressCounter,
    digest,
    byteLength,
    envelopeCount,
    createdAt,
    ...extra,
  };
}

function isEnabled(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const defaultFetcher: typeof fetch = (input, init) => fetch(input, init);

async function uploadToLighthouse(input: {
  readonly apiKey: string;
  readonly canonicalJson: string;
  readonly digest: `0x${string}`;
  readonly fetcher: typeof fetch;
}): Promise<
  { readonly ok: true; readonly cid: string } | { readonly ok: false; readonly error: string }
> {
  try {
    const form = new FormData();
    const fileName = `trust-evidence-${input.digest.slice(2)}.json`;
    form.append('file', new Blob([input.canonicalJson], { type: 'application/json' }), fileName);

    const response = await input.fetcher(LIGHTHOUSE_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: form,
    });

    if (!response.ok) {
      const details = await readSafeErrorDetails(response);
      const suffix = details ? `: ${details}` : '';
      return { ok: false, error: `Lighthouse upload failed with HTTP ${response.status}${suffix}` };
    }

    const payload = await response.json();
    const cid = readLighthouseCid(payload);
    if (!cid) return { ok: false, error: 'Lighthouse upload response did not include a CID' };
    return { ok: true, cid };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

function readLighthouseCid(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const hash = payload.Hash;
  if (typeof hash === 'string' && hash.length > 0) return hash;
  const data = payload.data;
  if (!isRecord(data)) return null;
  const nestedHash = data.Hash;
  return typeof nestedHash === 'string' && nestedHash.length > 0 ? nestedHash : null;
}

async function verifyGateway(
  gatewayUrl: string,
  fetcher: typeof fetch,
): Promise<{ readonly status: TrustPublishGatewayStatus; readonly verifiedAt?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_GATEWAY_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetcher(gatewayUrl, { method: 'GET', signal: controller.signal });
    return {
      status: response.ok ? 'available' : 'failed',
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    void error;
    return { status: 'failed', verifiedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 200);
  return 'Unknown Lighthouse upload error';
}

async function readSafeErrorDetails(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const fields = ['error', 'details', 'message']
        .map((key) => parsed[key])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim());
      if (fields.length > 0) return fields.join('; ').slice(0, 240);
    }
  } catch {
    // Fall through to a bounded raw preview.
  }

  return text.slice(0, 240);
}
