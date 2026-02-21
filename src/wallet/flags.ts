export interface WalletFeatureFlags {
  readonly identityEnabled: boolean;
  readonly governanceEnabled: boolean;
  readonly autonomousSpendEnabled: boolean;
}

interface WalletFlagsEnv extends NodeJS.ProcessEnv {
  OPENHOMIE_WALLET_IDENTITY_ENABLED?: string;
  OPENHOMIE_WALLET_GOVERNANCE_ENABLED?: string;
  OPENHOMIE_WALLET_AUTONOMOUS_SPEND_ENABLED?: string;
}

const parseBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return fallback;
};

export const loadWalletFeatureFlags = (env: WalletFlagsEnv): WalletFeatureFlags => {
  return {
    identityEnabled: parseBool(env.OPENHOMIE_WALLET_IDENTITY_ENABLED, true),
    governanceEnabled: parseBool(env.OPENHOMIE_WALLET_GOVERNANCE_ENABLED, false),
    autonomousSpendEnabled: parseBool(env.OPENHOMIE_WALLET_AUTONOMOUS_SPEND_ENABLED, false),
  };
};

export const assertWalletFeatureCompatibility = (flags: WalletFeatureFlags): void => {
  if (flags.autonomousSpendEnabled) {
    throw new Error(
      'OPENHOMIE_WALLET_AUTONOMOUS_SPEND_ENABLED is not supported yet. Keep it disabled until autonomous spend runtime wiring is implemented end-to-end.',
    );
  }
};
