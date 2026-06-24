"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { Check, KeyRound, Loader2, ShieldCheck, Wallet, X } from "lucide-react";
import type { Connector } from "wagmi";

interface ConnectWalletModalProps {
  connectors: readonly Connector[];
  errorMessage?: string | null;
  isConnecting: boolean;
  onClose: () => void;
  onConnect: (connector: Connector) => void | Promise<void>;
  open: boolean;
}

const RECOMMENDED_WALLETS = [
  { id: "metamask", label: "MetaMask", tone: "bg-[#f6851b] text-white", mark: "MM" },
  { id: "okx", label: "OKX Wallet", tone: "bg-black text-white", mark: "OK" },
  { id: "rabby", label: "Rabby", tone: "bg-[#7c5cff] text-white", mark: "RB" },
  { id: "coinbase", label: "Coinbase Wallet", tone: "bg-[#0052ff] text-white", mark: "CB" },
  { id: "trust", label: "Trust Wallet", tone: "bg-[#3375bb] text-white", mark: "TW" },
  { id: "tokenpocket", label: "TokenPocket", tone: "bg-[#3385ff] text-white", mark: "TP" },
] as const;

export function ConnectWalletModal({
  connectors,
  errorMessage,
  isConnecting,
  onClose,
  onConnect,
  open,
}: ConnectWalletModalProps) {
  const { installed, recommended } = useMemo(
    () => groupWallets(connectors),
    [connectors],
  );

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-3 py-4 backdrop-blur-md">
      <div className="relative grid h-[min(620px,92svh)] w-full max-w-[760px] overflow-hidden rounded-[24px] border border-white/10 bg-[#0b1117] shadow-[0_30px_90px_rgba(0,0,0,0.55)] md:grid-cols-[minmax(280px,0.9fr)_1.35fr]">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-slate-300 interaction-transition hit-area-40 hover:bg-white/16 hover:text-white"
          aria-label="Close wallet dialog"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="min-h-0 border-b border-white/8 bg-[#0e141b] md:border-b-0 md:border-r md:border-white/8">
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-5 pb-3 pt-5">
              <h2 className="font-heading text-lg font-semibold text-white">Connect a wallet</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Use an EVM wallet on 0G Mainnet.
              </p>
            </div>

            <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 pb-5">
              {installed.length > 0 ? (
                <WalletGroup
                  title="Installed"
                  wallets={installed}
                  isConnecting={isConnecting}
                  onConnect={onConnect}
                />
              ) : null}

              <WalletGroup
                title="Recommended"
                wallets={recommended}
                isConnecting={isConnecting}
                onConnect={onConnect}
              />

              {errorMessage ? (
                <p className="rounded-[14px] border border-rose-300/18 bg-rose-300/10 px-3 py-2 text-xs leading-5 text-rose-100">
                  {errorMessage}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="hidden min-h-0 flex-col justify-center px-12 py-10 md:flex">
          <div className="mx-auto max-w-[300px]">
            <h3 className="text-center font-heading text-xl font-semibold text-white">
              0G vault signing
            </h3>

            <div className="mt-14 grid gap-9">
              <InfoRow
                icon={<Wallet className="h-6 w-6" />}
                title="Control vault funds"
                body="Your wallet signs owner actions such as native 0G deposits, withdrawals, pause, and revoke."
                tone="from-[#1ee8c5] to-[#4d7cff]"
              />
              <InfoRow
                icon={<ShieldCheck className="h-6 w-6" />}
                title="Executor stays bounded"
                body="The agent executor can use only the narrow vault policy path; owner withdrawals stay with your wallet."
                tone="from-[#ffd166] to-[#1ee8c5]"
              />
              <InfoRow
                icon={<KeyRound className="h-6 w-6" />}
                title="Keys remain local"
                body="Private keys and wallet material never enter this app or its server routes."
                tone="from-[#8b66ff] to-[#62f5d0]"
              />
            </div>

            <div className="mt-12 flex flex-col items-center gap-4">
              <a
                href="https://metamask.io/download/"
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-[var(--pulse-teal)] px-5 py-2 text-sm font-semibold text-[#041015] interaction-transition hover:brightness-110"
              >
                Get a wallet
              </a>
              <a
                href="https://docs.0g.ai"
                target="_blank"
                rel="noreferrer"
                className="text-sm font-semibold text-cyan-100 interaction-transition hover:text-cyan-50"
              >
                0G docs
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function WalletGroup({
  title,
  wallets,
  isConnecting,
  onConnect,
}: {
  title: string;
  wallets: WalletOption[];
  isConnecting: boolean;
  onConnect: (connector: Connector) => void | Promise<void>;
}) {
  if (wallets.length === 0) return null;

  return (
    <div className="mb-5">
      <p className="mb-2 px-1 text-[12px] font-semibold text-[var(--pulse-teal)]">{title}</p>
      <div className="grid gap-1.5">
        {wallets.map((wallet) => (
          <button
            key={wallet.key}
            type="button"
            disabled={!wallet.connector || isConnecting}
            onClick={() => (wallet.connector ? void onConnect(wallet.connector) : undefined)}
            className="group flex h-11 w-full items-center gap-3 rounded-[12px] px-2.5 text-left text-white interaction-transition hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-55"
          >
            <WalletIcon option={wallet} />
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{wallet.label}</span>
            {wallet.installed ? <Check className="h-4 w-4 text-[var(--pulse-teal)]" /> : null}
            {isConnecting && wallet.installed ? (
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function InfoRow({
  body,
  icon,
  title,
  tone,
}: {
  body: string;
  icon: ReactNode;
  title: string;
  tone: string;
}) {
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-5">
      <div className={`flex h-12 w-12 items-center justify-center rounded-[12px] bg-gradient-to-br ${tone} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]`}>
        {icon}
      </div>
      <div>
        <p className="text-[15px] font-semibold leading-5 text-white">{title}</p>
        <p className="mt-1 text-sm leading-5 text-slate-500">{body}</p>
      </div>
    </div>
  );
}

function WalletIcon({ option }: { option: WalletOption }) {
  if (option.icon) {
    return (
      <span
        aria-hidden="true"
        className="h-8 w-8 shrink-0 rounded-[8px] bg-cover bg-center"
        style={{ backgroundImage: `url("${option.icon}")` }}
      />
    );
  }

  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[10px] font-black ${option.tone}`}>
      {option.mark}
    </span>
  );
}

interface WalletOption {
  connector?: Connector;
  icon?: string;
  installed: boolean;
  key: string;
  label: string;
  mark: string;
  tone: string;
}

function groupWallets(connectors: readonly Connector[]): {
  installed: WalletOption[];
  recommended: WalletOption[];
} {
  const remaining = [...connectors];
  const installed: WalletOption[] = [];

  for (const descriptor of RECOMMENDED_WALLETS) {
    const index = remaining.findIndex((connector) => matchesWallet(connector.name, descriptor.id));
    if (index >= 0) {
      const [connector] = remaining.splice(index, 1);
      installed.push({
        connector,
        icon: readConnectorIcon(connector),
        installed: true,
        key: connector.uid,
        label: descriptor.label,
        mark: descriptor.mark,
        tone: descriptor.tone,
      });
    }
  }

  for (const connector of remaining) {
    installed.push({
      connector,
      icon: readConnectorIcon(connector),
      installed: true,
      key: connector.uid,
      label: connector.name,
      mark: connector.name.slice(0, 2).toUpperCase(),
      tone: "bg-[#202a34] text-white",
    });
  }

  const recommended = RECOMMENDED_WALLETS
    .filter((descriptor) => !installed.some((wallet) => matchesWallet(wallet.label, descriptor.id)))
    .map((descriptor) => ({
      installed: false,
      key: descriptor.id,
      label: descriptor.label,
      mark: descriptor.mark,
      tone: descriptor.tone,
    }));

  return { installed, recommended };
}

function matchesWallet(name: string, id: string): boolean {
  const normalized = name.toLowerCase().replace(/\s+/gu, "");
  if (id === "metamask") return normalized.includes("metamask");
  if (id === "okx") return normalized.includes("okx");
  if (id === "rabby") return normalized.includes("rabby");
  if (id === "coinbase") return normalized.includes("coinbase");
  if (id === "trust") return normalized.includes("trust");
  if (id === "tokenpocket") return normalized.includes("tokenpocket");
  return false;
}

function readConnectorIcon(connector: Connector): string | undefined {
  const icon = (connector as Connector & { icon?: unknown }).icon;
  return typeof icon === "string" && icon.length > 0 ? icon : undefined;
}
