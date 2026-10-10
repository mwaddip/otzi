import { vaultPayment } from './bitcoin.js';
import { chainApiUrl } from './esplora.js';
import type { VaultConfig } from './types.js';

export type PublicConfig = Omit<VaultConfig, 'adminPasswordHash'> & {
  hasAdminPassword: boolean;
  chainApiUrl: string;
  vaultAddress?: string;
};

/** Config as served to the frontend: no password hash, plus derived values. */
export function publicConfig(config: VaultConfig): PublicConfig {
  const { adminPasswordHash, ...rest } = config;
  return {
    ...rest,
    hasAdminPassword: !!adminPasswordHash,
    chainApiUrl: chainApiUrl(config),
    ...(config.vault ? { vaultAddress: vaultPayment(config.vault, config.network).address } : {}),
  };
}
