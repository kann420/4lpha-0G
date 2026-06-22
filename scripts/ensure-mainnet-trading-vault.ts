import { main as createMainnetVault } from "./create-mainnet-vault";
import { runIfDirect } from "./mainnet-vault-utils";

await runIfDirect(import.meta.url, createMainnetVault);
