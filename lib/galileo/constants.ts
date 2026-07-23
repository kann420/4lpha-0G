/**
 * Shared Galileo network constants. This module intentionally has NO
 * `server-only` guard so both client components (e.g. GalileoTradePanel) and
 * server modules (config, route boundary, executor) resolve the same single
 * literal instead of redeclaring the chain id.
 */
export const GALILEO_CHAIN_ID = 16602;
export const GALILEO_NETWORK_ID = "testnet" as const;
