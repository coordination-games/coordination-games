import { parseWalletBindingStatement } from './wallet-binding-parse.js';
import { WALLET_BINDING_PURPOSE, type WalletBindingMessageResult } from './wallet-binding-types.js';

export function buildWalletBindingMessage(input: unknown): WalletBindingMessageResult {
  const parsed = parseWalletBindingStatement(input);
  if (parsed.kind === 'rejected') return parsed;
  const { address, chainId, did, domain, issuedAt, nonce, uri } = parsed.statement;
  return {
    kind: 'built',
    message: `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nBind this Ethereum account to the listed DID.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nResources:\n- ${WALLET_BINDING_PURPOSE}\n- ${did}`,
  };
}
