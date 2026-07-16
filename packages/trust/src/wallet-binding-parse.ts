import { getAddress, isAddress, isHexString } from 'ethers';
import {
  type AtprotoStrongRef,
  type DidPlc,
  type EvmAddress,
  WALLET_BINDING_RECORD_VERSION,
  type WalletBindingLifecycle,
  type WalletBindingRecord,
} from './index.js';
import type {
  WalletBindingRejected,
  WalletBindingSigningRequest,
  WalletBindingStatement,
} from './wallet-binding-types.js';

type ObjectValue = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: ObjectValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDidPlc(value: unknown): value is DidPlc {
  return typeof value === 'string' && /^did:plc:[a-z2-7]{24}$/.test(value);
}

function isEvmAddress(value: unknown): value is EvmAddress {
  return typeof value === 'string' && isAddress(value) && getAddress(value) === value;
}

function isDomain(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(?<host>(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(?<port>[1-9][0-9]{0,4}))?$/.exec(
      value,
    );
  if (match?.groups?.port === undefined) return match !== null;
  return Number(match.groups.port) <= 65_535;
}

function isUri(value: unknown, domain: string): value is string {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const uri = new URL(value);
  return (
    uri.protocol === 'https:' &&
    uri.username === '' &&
    uri.password === '' &&
    uri.hash === '' &&
    uri.host === domain &&
    uri.href === value
  );
}

function isChainId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{8,128}$/.test(value);
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isStrongRef(value: unknown): value is AtprotoStrongRef {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ['uri', 'cid']) &&
    typeof value.uri === 'string' &&
    value.uri.startsWith('at://') &&
    typeof value.cid === 'string' &&
    value.cid.length > 0
  );
}

function isLifecycle(value: unknown): value is WalletBindingLifecycle {
  if (!isObject(value) || typeof value.status !== 'string') return false;
  switch (value.status) {
    case 'active':
      return hasOnlyKeys(value, ['status']);
    case 'revoked':
      return (
        (hasOnlyKeys(value, ['status', 'revokedAt']) ||
          hasOnlyKeys(value, ['status', 'revokedAt', 'revocation'])) &&
        isInstant(value.revokedAt) &&
        (value.revocation === undefined || isStrongRef(value.revocation))
      );
    case 'superseded':
      return (
        hasOnlyKeys(value, ['status', 'supersededAt', 'supersededBy']) &&
        isInstant(value.supersededAt) &&
        isStrongRef(value.supersededBy)
      );
    default:
      return false;
  }
}

export function parseWalletBindingStatement(
  input: unknown,
): { readonly kind: 'parsed'; readonly statement: WalletBindingStatement } | WalletBindingRejected {
  if (
    !isObject(input) ||
    !hasOnlyKeys(input, ['did', 'address', 'domain', 'uri', 'chainId', 'nonce', 'issuedAt'])
  ) {
    return { kind: 'rejected', reason: 'invalid-record' };
  }
  if (
    !isDidPlc(input.did) ||
    !isEvmAddress(input.address) ||
    !isDomain(input.domain) ||
    !isUri(input.uri, input.domain) ||
    !isChainId(input.chainId) ||
    !isNonce(input.nonce) ||
    !isInstant(input.issuedAt)
  ) {
    return { kind: 'rejected', reason: 'invalid-record' };
  }
  return {
    kind: 'parsed',
    statement: {
      did: input.did,
      address: input.address,
      domain: input.domain,
      uri: input.uri,
      chainId: input.chainId,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
    },
  };
}

export function parseWalletBindingRecord(
  input: unknown,
): { readonly kind: 'parsed'; readonly record: WalletBindingRecord } | WalletBindingRejected {
  if (!isObject(input) || typeof input.recordVersion !== 'string') {
    return { kind: 'rejected', reason: 'invalid-record' };
  }
  if (input.recordVersion !== WALLET_BINDING_RECORD_VERSION) {
    return { kind: 'rejected', reason: 'record-version' };
  }
  if (
    !hasOnlyKeys(input, [
      'recordVersion',
      'did',
      'address',
      'domain',
      'uri',
      'chainId',
      'nonce',
      'issuedAt',
      'signature',
      'signatureType',
      'lifecycle',
    ])
  ) {
    return { kind: 'rejected', reason: 'invalid-record' };
  }
  const statement = parseWalletBindingStatement({
    did: input.did,
    address: input.address,
    domain: input.domain,
    uri: input.uri,
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
  });
  if (statement.kind === 'rejected') return statement;
  if (
    !isHexString(input.signature, 65) ||
    (input.signatureType !== 'eip191' && input.signatureType !== 'eip1271') ||
    !isLifecycle(input.lifecycle)
  ) {
    return { kind: 'rejected', reason: 'invalid-record' };
  }
  return {
    kind: 'parsed',
    record: {
      recordVersion: WALLET_BINDING_RECORD_VERSION,
      ...statement.statement,
      signature: input.signature,
      signatureType: input.signatureType,
      lifecycle: input.lifecycle,
    },
  };
}

export function parseWalletBindingSigningRequest(
  input: unknown,
  address: string,
):
  | {
      readonly kind: 'parsed';
      readonly request: WalletBindingSigningRequest;
      readonly statement: WalletBindingStatement;
    }
  | WalletBindingRejected {
  if (
    !isObject(input) ||
    !hasOnlyKeys(input, ['did', 'domain', 'uri', 'chainId', 'nonce', 'issuedAt', 'lifecycle'])
  ) {
    return { kind: 'rejected', reason: 'invalid-record' };
  }
  const statement = parseWalletBindingStatement({
    did: input.did,
    address,
    domain: input.domain,
    uri: input.uri,
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
  });
  if (statement.kind === 'rejected' || !isLifecycle(input.lifecycle)) {
    return { kind: 'rejected', reason: 'invalid-record' };
  }
  return {
    kind: 'parsed',
    request: {
      did: statement.statement.did,
      domain: statement.statement.domain,
      uri: statement.statement.uri,
      chainId: statement.statement.chainId,
      nonce: statement.statement.nonce,
      issuedAt: statement.statement.issuedAt,
      lifecycle: input.lifecycle,
    },
    statement: statement.statement,
  };
}
