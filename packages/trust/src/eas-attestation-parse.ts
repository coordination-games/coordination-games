import { getAddress, isAddress, isHexString } from 'ethers';
import type { Bytes32, EasAttestation, HexData } from './promise-outcome-types.js';

type ObjectValue = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: ObjectValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isBytes32(value: unknown): value is Bytes32 {
  return typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
}

function isAddressValue(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && isAddress(value) && getAddress(value) === value;
}

function isHexData(value: unknown): value is HexData {
  return typeof value === 'string' && isHexString(value);
}

export function parseEasAttestation(input: unknown): EasAttestation | null {
  if (
    !isObject(input) ||
    !hasOnlyKeys(input, [
      'uid',
      'schema',
      'time',
      'expirationTime',
      'revocationTime',
      'refUid',
      'recipient',
      'attester',
      'revocable',
      'data',
    ]) ||
    !isBytes32(input.uid) ||
    !isBytes32(input.schema) ||
    !isBytes32(input.refUid) ||
    typeof input.time !== 'bigint' ||
    typeof input.expirationTime !== 'bigint' ||
    typeof input.revocationTime !== 'bigint' ||
    input.time < 0n ||
    input.expirationTime < 0n ||
    input.revocationTime < 0n ||
    !isAddressValue(input.recipient) ||
    !isAddressValue(input.attester) ||
    typeof input.revocable !== 'boolean' ||
    !isHexData(input.data)
  ) {
    return null;
  }
  return {
    uid: input.uid,
    schema: input.schema,
    time: input.time,
    expirationTime: input.expirationTime,
    revocationTime: input.revocationTime,
    refUid: input.refUid,
    recipient: input.recipient,
    attester: input.attester,
    revocable: input.revocable,
    data: input.data,
  };
}
