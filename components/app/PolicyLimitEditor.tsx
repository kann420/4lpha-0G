"use client";

import { vaultPolicy } from "@/lib/mock-data";
import { RiskLimitRow } from "./RiskLimitRow";

export function PolicyLimitEditor({
  slippageBps,
  onSlippageChange,
}: {
  slippageBps: number;
  onSlippageChange: (value: number) => void;
}) {
  return (
    <section className="soft-panel rounded-[24px] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">Policy limits</h2>
          <p className="mt-1 text-sm leading-6 text-slate-400">Vault-enforced demo guardrails.</p>
        </div>
        <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-xs font-semibold text-emerald-100">
          deny-first
        </span>
      </div>
      <div className="mt-4">
        <RiskLimitRow label="Arbitrary target" value={vaultPolicy.arbitraryTarget} />
        <RiskLimitRow label="Executor withdrawal" value={vaultPolicy.executorWithdrawal} />
        <RiskLimitRow label="Raw calldata pass-through" value={vaultPolicy.rawCalldataPassThrough} />
        <RiskLimitRow label="Production mock adapter" value={vaultPolicy.productionMockAdapter} tone="blocked" />
        <RiskLimitRow label="Replay protection" value={vaultPolicy.replayProtection} />
        <RiskLimitRow
          label="Nonzero min-out"
          value={vaultPolicy.minAmountOutRequired ? "required" : "missing"}
          tone={vaultPolicy.minAmountOutRequired ? "ok" : "blocked"}
        />
      </div>
      <label className="mt-4 block">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-sm text-slate-400">Max slippage</span>
          <span className="font-mono text-sm text-cyan-100">{slippageBps} bps</span>
        </div>
        <input
          type="range"
          min="25"
          max="150"
          step="5"
          value={slippageBps}
          onChange={(event) => onSlippageChange(Number(event.target.value))}
          className="w-full accent-cyan-300"
        />
      </label>
    </section>
  );
}
