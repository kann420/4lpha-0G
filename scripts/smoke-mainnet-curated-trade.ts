import { main as preflightMainnetTrade } from "./preflight-mainnet-trade";
import { runIfDirect } from "./mainnet-vault-utils";

await runIfDirect(import.meta.url, preflightMainnetTrade);
