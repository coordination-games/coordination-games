/**
 * Credit decimal scaling.
 *
 * Credits are stored on-chain with 6 decimals of precision, matching USDC.
 * Plugin-declared `entryCost` values are in WHOLE credits; the server scales
 * at the settlement boundary before building int256 deltas.
 *
 * Scenario: CtL declares `entryCost: 10`. At settlement, GameRoomDO converts
 * 10 → 10n * CREDIT_SCALE = 10_000_000n raw credit units before handing
 * `computePayouts` an entryCost and relaying deltas to the contract.
 *
 * Consumer-facing surfaces (CLI balance, web balance) DIVIDE by CREDIT_SCALE
 * to display whole credits. Burn input (user types "coga withdraw 100")
 * MULTIPLIES by CREDIT_SCALE to match the contract's raw units.
 *
 * USDC amounts at the mint/topup boundary stay in their own raw units
 * (also 6 decimals, but scaled by the contract's internal `credits = net * 100`
 * conversion — don't conflate the two scales).
 */
export const CREDIT_DECIMALS = 6;
export const CREDIT_SCALE = 10n ** BigInt(CREDIT_DECIMALS);
