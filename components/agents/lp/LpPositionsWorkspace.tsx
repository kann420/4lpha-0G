import { Gift } from "lucide-react";

import { LpPositionCard } from "@/components/agents/lp/LpPositionCard";
import { mockAccountingFor } from "@/lib/agent/lp/mock-lp-data";
import type { OgAgentVaultLpPosition } from "@/lib/agent/single-agent";

export function LpPositionsWorkspace({
  allowStaking,
  isMockAgent,
  maxPositions,
  onMintBootstrap,
  onStakePosition,
  onUnstakePosition,
  onZapOutPosition,
  openLpExposure0G,
  pendingAction,
  positions,
  totalDeployed0G,
}: {
  allowStaking: boolean;
  // Only the explicit mock agent id may render mock accounting numbers; real
  // agents render "—" when real fields are missing.
  isMockAgent: boolean;
  maxPositions: number;
  onMintBootstrap?: () => void;
  onStakePosition: (position: OgAgentVaultLpPosition) => void;
  onUnstakePosition: (position: OgAgentVaultLpPosition) => void;
  onZapOutPosition: (position: OgAgentVaultLpPosition) => void;
  openLpExposure0G: string;
  pendingAction?: string | null;
  positions: readonly OgAgentVaultLpPosition[];
  totalDeployed0G: string;
}) {
  const atMax = positions.length >= maxPositions;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid overflow-hidden rounded-tile border border-line bg-panel md:grid-cols-3">
        <SummaryCell label="Positions" value={`${positions.length} / ${maxPositions}`} tone={atMax ? "warning" : undefined} />
        <SummaryCell label="Total deployed" value={`${totalDeployed0G} 0G`} />
        <SummaryCell label="Open exposure" value={`${openLpExposure0G} 0G`} />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled
          title="The Zia reward-claim / pending-reward API is not available yet. The vault's claimRewards entrypoint reverts RewardsNotConfigured until Zia exposes reward methods."
          className="inline-flex h-9 cursor-not-allowed items-center gap-2 rounded-full border border-line bg-panel px-4 text-xs font-semibold text-muted opacity-60"
        >
          <Gift className="h-3.5 w-3.5" />
          Claim rewards (coming soon)
        </button>
        <span className="text-[11px] text-muted">Zia rewards API not yet available.</span>
      </div>

      {positions.length > 0 ? (
        positions.map((position) => {
          const cardPending = pendingAction
            ? (pendingAction.startsWith(`${position.tokenId}:`)
                ? (pendingAction.slice(position.tokenId.length + 1) as "stake" | "unstake" | "zap-out")
                : null)
            : null;
          return (
            <LpPositionCard
              key={position.tokenId}
              accounting={mockAccountingFor(position.tokenId)}
              allowStaking={allowStaking}
              isMockAgent={isMockAgent}
              pendingAction={cardPending}
              position={position}
              onStake={() => onStakePosition(position)}
              onUnstake={() => onUnstakePosition(position)}
              onZapOut={() => onZapOutPosition(position)}
            />
          );
        })
      ) : (
        <div className="rounded-card border border-line bg-panel p-4">
          <p className="text-sm font-semibold text-foreground">No LP positions yet</p>
          <p className="mt-1 text-sm text-muted">Enable Auto-mint in the policy panel to mint within the fence.</p>
        </div>
      )}
    </div>
  );
}

function SummaryCell({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
  const valueTone = tone === "warning" ? "text-amber" : "text-foreground";
  return (
    <div className="min-h-[4rem] min-w-0 border-b border-r border-line bg-panel-solid-strong px-3 py-2 last:border-r-0 md:border-b-0">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className={`mt-1 truncate font-mono text-sm font-semibold ${valueTone}`} title={value}>
        {value}
      </p>
    </div>
  );
}
