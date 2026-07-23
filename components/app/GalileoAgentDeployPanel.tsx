"use client";

import { useCallback, useMemo, useState } from "react";
import { CheckCircle2, Database, Loader2, ShieldCheck } from "lucide-react";
import { useAccount, useSignMessage } from "wagmi";

import { GALILEO_CHAIN_ID } from "@/lib/galileo/constants";
import type {
  GalileoAgentDeployConfig,
  GalileoAgentDeployConsentIssue,
  GalileoAgentDeployResponse,
} from "@/lib/types";
import { useGalileoWalletVault } from "@/components/app/useGalileoWalletVault";

const DEFAULT_NAME = "Galileo Sandbox Agent";
const DEFAULT_FILTERS = "sandbox, 0g-musdc";

/**
 * Owner-driven Galileo agent creation. Three owner-visible steps, each with its
 * own signature: a server-issued deploy consent the wallet signs, the server
 * Storage upload + byte-verify, then the on-chain agent-key enable. The server
 * derives the agent key and reference; this panel never invents either.
 */
export function GalileoAgentDeployPanel({ onDeployed }: { onDeployed?: () => void }) {
  const account = useAccount();
  const signMessage = useSignMessage();
  const vault = useGalileoWalletVault(true);
  const [name, setName] = useState(DEFAULT_NAME);
  const [filtersText, setFiltersText] = useState(DEFAULT_FILTERS);
  const [maxTrade0G, setMaxTrade0G] = useState("0.01");
  const [slippageBps, setSlippageBps] = useState(75);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployed, setDeployed] = useState<{ agentKey: `0x${string}`; agentRef: string; storageRoot?: string } | null>(null);
  const [status, setStatus] = useState("Connect the Galileo owner wallet and deploy an attested vault first.");

  const filters = useMemo(
    () => filtersText.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 4),
    [filtersText],
  );
  const configError = name.trim().length < 3 || name.trim().length > 80
    ? "Agent name must be 3–80 characters."
    : filters.length < 1
      ? "Add at least one filter tag."
      : !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1000
        ? "Slippage must be an integer between 1 and 1000 bps."
        : !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(maxTrade0G.trim())
          ? "Max trade must be a plain decimal amount of 0G."
          : null;
  const canDeploy = Boolean(account.address && vault.vaultAddress && vault.attested && !configError && !isDeploying && !vault.isBusy);

  const deployAgent = useCallback(async () => {
    if (!account.address || !vault.vaultAddress) {
      setStatus("An attested Galileo vault is required before an agent can be created.");
      return;
    }
    setIsDeploying(true);
    setDeployed(null);
    try {
      // The clientRequestId is bound into the signed consent and replayed to the
      // deploy route, so a second click cannot create a second agent record.
      const clientRequestId = newClientRequestId();
      const config: GalileoAgentDeployConfig = {
        filters,
        name: name.trim(),
        runtime: { maxTrade0G: maxTrade0G.trim(), slippageBps },
        vault: vault.vaultAddress,
      };

      setStatus("Requesting a server-issued deploy consent.");
      const consentResponse = await fetch("/api/agents/galileo/consent", {
        body: JSON.stringify({
          action: "deploy",
          chainId: GALILEO_CHAIN_ID,
          clientRequestId,
          config,
          networkId: "testnet",
          owner: account.address,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const consentPayload = await consentResponse.json() as { data?: GalileoAgentDeployConsentIssue; error?: { message: string } };
      if (!consentResponse.ok || !consentPayload.data) throw new Error(consentPayload.error?.message ?? "Galileo deploy consent could not be prepared.");

      setStatus("Sign the deploy consent in your wallet.");
      const signature = await signMessage.signMessageAsync({ message: consentPayload.data.consentMessage });

      setStatus("Uploading redacted agent metadata to 0G Storage and verifying the bytes.");
      const deployResponse = await fetch("/api/agents/galileo/deploy", {
        body: JSON.stringify({
          chainId: GALILEO_CHAIN_ID,
          clientRequestId,
          networkId: "testnet",
          nonce: consentPayload.data.nonce,
          prepareId: consentPayload.data.prepareId,
          wallet: {
            address: account.address,
            chainId: GALILEO_CHAIN_ID,
            message: consentPayload.data.consentMessage,
            signature,
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const deployPayload = await deployResponse.json() as GalileoAgentDeployResponse;
      if (!deployResponse.ok || !deployPayload.data) throw new Error(deployPayload.error?.message ?? "Galileo agent deployment failed.");
      if (deployPayload.data.status === "already_verified") {
        setStatus("This deployment request was already verified; reload the agent roster.");
        onDeployed?.();
        return;
      }

      const agentKey = deployPayload.data.agentKey ?? consentPayload.data.agentKey;
      const agentRef = deployPayload.data.agentRef ?? consentPayload.data.agentRef;
      setDeployed({ agentKey, agentRef, storageRoot: deployPayload.data.storageRoot });
      setStatus("Agent metadata verified on 0G Storage. Enable its key on the vault to let the executor trade for it.");
      onDeployed?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Galileo agent deployment failed.");
    } finally {
      setIsDeploying(false);
    }
  }, [account.address, filters, maxTrade0G, name, onDeployed, signMessage, slippageBps, vault.vaultAddress]);

  const enableAgentKey = useCallback(async () => {
    if (!deployed) return;
    await vault.setAgentKeyEnabled(deployed.agentKey, true);
    onDeployed?.();
  }, [deployed, onDeployed, vault]);

  return (
    <section className="rounded-[24px] border border-line bg-panel-solid-strong p-4 lg:rounded-[30px] lg:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary"><Database className="h-4 w-4" /></span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-primary">Galileo agent</p>
              <h2 className="text-xl font-semibold text-foreground">Create a Storage-verified agent</h2>
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">Sign one deploy consent, the server uploads the redacted metadata bundle to 0G Storage and verifies it byte-for-byte, then you enable the agent key on your vault.</p>
        </div>
        <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-[10px] font-bold tracking-[0.16em] text-primary">GALILEO TESTNET · REAL TX</span>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <label className="grid gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Agent name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className="h-11 min-w-0 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground outline-none focus:border-primary/40" />
        </label>
        <label className="grid gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Filters (comma separated, max 4)</span>
          <input value={filtersText} onChange={(event) => setFiltersText(event.target.value)} className="h-11 min-w-0 rounded-full border border-line bg-panel px-4 text-sm text-foreground outline-none focus:border-primary/40" />
        </label>
        <label className="grid gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Max trade (0G)</span>
          <input value={maxTrade0G} onChange={(event) => setMaxTrade0G(event.target.value)} inputMode="decimal" className="h-11 min-w-0 rounded-full border border-line bg-panel px-4 font-mono text-sm font-semibold text-foreground outline-none focus:border-primary/40" />
        </label>
        <label className="grid gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Runtime slippage (bps)</span>
          <input value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))} type="number" min={1} max={1000} className="h-11 min-w-0 rounded-full border border-line bg-panel px-4 font-mono text-sm font-semibold text-foreground outline-none focus:border-primary/40" />
        </label>
      </div>

      <p className="mt-3 font-mono text-[11px] leading-5 text-muted break-all">Vault: {vault.vaultAddress ?? "none"} · attestation: {vault.attested === null ? "—" : vault.attested ? "verified" : "pending"}</p>
      {configError ? <p className="mt-2 text-xs text-red-400">{configError}</p> : null}
      {!vault.attested ? <p className="mt-2 text-xs leading-5 text-amber">An attested Galileo vault is required. Deploy one on the Vault surface, then have the dedicated attestor attest it.</p> : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void deployAgent()} disabled={!canDeploy} className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-foreground px-4 text-sm font-semibold text-background transition-opacity disabled:cursor-not-allowed disabled:opacity-45">
          {isDeploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Sign consent and deploy agent
        </button>
        {deployed ? (
          <button type="button" onClick={() => void enableAgentKey()} disabled={vault.isBusy || !vault.canWrite} className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 text-sm font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-45">
            <CheckCircle2 className="h-4 w-4" /> Enable agent key on vault
          </button>
        ) : null}
      </div>

      <p className="mt-3 text-sm leading-6 text-muted">{status}</p>
      {deployed ? (
        <div className="mt-3 rounded-card border border-line bg-background/30 p-4 font-mono text-[11px] leading-5 text-muted">
          <p className="break-all">agentRef: {deployed.agentRef}</p>
          <p className="break-all">agentKey: {deployed.agentKey}</p>
          {deployed.storageRoot ? <p className="break-all">storageRoot: {deployed.storageRoot}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function newClientRequestId(): string {
  return `galileo-deploy-${globalThis.crypto.randomUUID()}`;
}
