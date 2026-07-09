import {
  ChevronDown,
  CheckCircle2,
  ExternalLink,
  IdCard,
  Layers,
  Percent,
  Shield,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import type { Address, Hex } from "viem";

import { shortHash } from "@/lib/format";
import type { OgAgentDeploymentRecord, OgAgentVaultLpPosition } from "@/lib/agent/single-agent";

const CHAINSCAN_BASE_URL = "https://chainscan.0g.ai";

export interface LpPositionPoolRef {
  label: string;
  poolAddress: Address;
  stakeVault: Address;
}

interface PoolFact {
  icon: LucideIcon;
  label: string;
  tone?: "info" | "neutral";
  value: string;
}

export function LpAgentSidebar({
  adapter,
  aprBand,
  identity,
  maxPositions,
  mode = "mainnet",
  policyVaultV3,
  positionPools,
  positions,
  proofRegistry,
  vault,
}: {
  adapter: Address;
  aprBand: { minAprPct: number; maxAprPct: number };
  identity: {
    address?: Address;
    configured: boolean;
    deployTxHash?: Hex;
    enableTxHash?: Hex;
    note?: string;
    standard: OgAgentDeploymentRecord["standard"] | "Disabled";
    storageRoot?: Hex;
    tokenId?: string;
    vault: Address;
  };
  maxPositions: number;
  mode?: "mainnet" | "testnet-rehearsal";
  policyVaultV3: Address;
  positionPools: readonly LpPositionPoolRef[];
  positions: readonly OgAgentVaultLpPosition[];
  proofRegistry: Address;
  vault: Address;
}) {
  const poolFacts = buildPoolFacts(positions, maxPositions, aprBand, mode);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-card border border-line bg-panel-solid-strong p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Pool Info</p>
        <div className="mt-3 grid gap-2">
          {poolFacts.map((row) => (
            <InfoRow key={row.label} icon={row.icon} label={row.label} tone={row.tone} value={row.value} />
          ))}
        </div>

        {mode === "mainnet" && positionPools.length > 0 ? (
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Zia stake vaults</p>
            {positionPools.map((pool) => (
              <div key={pool.poolAddress} className="space-y-1.5">
                <p className="truncate text-xs font-semibold text-foreground">{pool.label}</p>
                <AddressRow label="Stake vault" value={pool.stakeVault} />
              </div>
            ))}
          </div>
        ) : null}

        <details className="group mt-4 border-t border-line pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
            <span>Contract details</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-3 grid gap-2">
            {mode === "testnet-rehearsal" ? (
              <>
                <IdentityRow label="Vault" value="Mock adapter rehearsal" />
                <IdentityRow label="LP adapter" value="Mock" />
                <IdentityRow label="Proof registry" value="Disabled" />
              </>
            ) : (
              <>
                <AddressRow label="Policy Vault V3" value={policyVaultV3} />
                <AddressRow label="Zia LP adapter" value={adapter} />
                <AddressRow label="Agent vault" value={vault} />
                <AddressRow label="Proof registry" value={proofRegistry} />
              </>
            )}
          </div>
        </details>
      </div>

      <div className="rounded-card border border-line bg-panel-solid-strong p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Agent identity</p>
        <div className="mt-3 flex min-w-0 items-center gap-2">
          <span
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-tile border ${
              identity.configured
                ? "border-primary/20 bg-primary/10 text-primary"
                : "border-amber/20 bg-amber/10 text-amber"
            }`}
          >
            {identity.configured ? <CheckCircle2 className="h-4 w-4" /> : <IdCard className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {identity.tokenId ? `${identity.standard} #${identity.tokenId}` : `${identity.standard} not minted`}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-muted">
              {mode === "testnet-rehearsal"
                ? "Testnet rehearsal only: no on-chain Agentic ID and no 0G Storage metadata."
                : identity.configured
                ? "0G mainnet Agentic ID anchored to vault and audit root."
                : "Connect the owner wallet to load live identity evidence."}
            </p>
          </div>
        </div>

        <div className="mt-3 grid gap-2 text-xs">
          <IdentityRow label="Config" value={mode === "testnet-rehearsal" ? "Disabled" : identity.configured ? "Ready" : "Not loaded"} />
          {identity.tokenId ? <IdentityRow label="Agent ID" value={`#${identity.tokenId}`} mono /> : null}
          {identity.address ? <ExternalRow href={addressUrl(identity.address)} label="Contract" value={shortHash(identity.address)} /> : null}
          {identity.deployTxHash ? <ExternalRow href={txUrl(identity.deployTxHash)} label="Deploy tx" value={shortHash(identity.deployTxHash)} /> : null}
          {identity.enableTxHash ? <ExternalRow href={txUrl(identity.enableTxHash)} label="Enable tx" value={shortHash(identity.enableTxHash)} /> : null}
          {identity.storageRoot ? <IdentityRow label="Metadata root" value={shortHash(identity.storageRoot)} mono /> : null}
          {mode === "testnet-rehearsal" ? (
            <IdentityRow label="Vault" value="Mock adapter" />
          ) : (
            <ExternalRow href={addressUrl(identity.vault)} label="Vault" value={shortHash(identity.vault)} />
          )}
        </div>
      </div>
    </div>
  );
}

function buildPoolFacts(
  positions: readonly OgAgentVaultLpPosition[],
  maxPositions: number,
  aprBand: { minAprPct: number; maxAprPct: number },
  mode: "mainnet" | "testnet-rehearsal",
): PoolFact[] {
  const nftValue = positions.length === 0 ? "None" : positions.length === 1 ? `#${positions[0]!.tokenId}` : `${positions.length} NFTs`;

  return [
    { icon: Layers, label: "Network", value: mode === "testnet-rehearsal" ? "0G Galileo rehearsal" : "0G Mainnet" },
    { icon: Percent, label: "APR band", tone: "info" as const, value: `${aprBand.minAprPct}% - ${aprBand.maxAprPct === Infinity ? "open" : `${aprBand.maxAprPct}%`}` },
    { icon: Shield, label: "LP slots", value: `${positions.length} / ${maxPositions}` },
    { icon: WalletCards, label: "Position NFT", value: nftValue },
  ];
}

function InfoRow({
  icon: Icon,
  label,
  tone = "neutral",
  value,
}: {
  icon: LucideIcon;
  label: string;
  tone?: "info" | "neutral";
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-tile border border-line bg-panel px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-muted">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${tone === "info" ? "text-primary" : ""}`} />
        <span className="truncate text-xs">{label}</span>
      </div>
      <span
        className={`max-w-[12.5rem] truncate text-right font-mono text-xs font-semibold ${tone === "info" ? "text-primary" : "text-foreground"}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function AddressRow({ label, value }: { label: string; value: string }) {
  return <ExternalRow href={addressUrl(value)} label={label} value={shortHash(value)} />;
}

function IdentityRow({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={`truncate text-right text-foreground ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function ExternalRow({ href, label, value }: { href: string; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <a
        className="inline-flex min-w-0 items-center gap-1 font-mono text-foreground transition-colors hover:text-primary"
        href={href}
        rel="noreferrer"
        target="_blank"
        title={href}
      >
        <span className="truncate">{value}</span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    </div>
  );
}

function addressUrl(address: string): string {
  return `${CHAINSCAN_BASE_URL}/address/${address}`;
}

function txUrl(hash: string): string {
  return `${CHAINSCAN_BASE_URL}/tx/${hash}`;
}
