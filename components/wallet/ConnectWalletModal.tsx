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
  { id: "metamask", label: "MetaMask", tone: "bg-[#f6851b] text-foreground", mark: "MM" },
  { id: "okx", label: "OKX Wallet", tone: "bg-background text-foreground", mark: "OK" },
  { id: "rabby", label: "Rabby", tone: "bg-[#7c5cff] text-foreground", mark: "RB" },
  { id: "coinbase", label: "Coinbase Wallet", tone: "bg-[#0052ff] text-foreground", mark: "CB" },
  { id: "trust", label: "Trust Wallet", tone: "bg-[#3375bb] text-foreground", mark: "TW" },
  { id: "tokenpocket", label: "TokenPocket", tone: "bg-[#3385ff] text-foreground", mark: "TP" },
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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/70 px-3 py-4 backdrop-blur-md">
      <div className="relative grid h-[min(620px,92svh)] w-full max-w-[760px] overflow-hidden rounded-[24px] border border-line bg-panel-solid-strong shadow-[0_30px_90px_rgba(0,0,0,0.55)] md:grid-cols-[minmax(280px,0.9fr)_1.35fr]">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-panel-strong text-muted interaction-transition hit-area-40 hover:bg-panel-strong hover:text-foreground"
          aria-label="Close wallet dialog"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="min-h-0 border-b border-line bg-panel-solid-strong md:border-b-0 md:border-r md:border-line">
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-5 pb-3 pt-5">
              <h2 className="font-heading text-lg font-semibold text-foreground">Connect a wallet</h2>
              <p className="mt-1 text-xs leading-5 text-muted">
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
                <p className="rounded-[14px] border border-rose/18 bg-rose/10 px-3 py-2 text-xs leading-5 text-rose">
                  {errorMessage}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="hidden min-h-0 flex-col justify-center px-12 py-10 md:flex">
          <div className="mx-auto max-w-[300px]">
            <h3 className="text-center font-heading text-xl font-semibold text-foreground">
              0G vault signing
            </h3>

            <div className="mt-14 grid gap-9">
              <InfoRow
                icon={<Wallet className="h-6 w-6" />}
                title="Control vault funds"
                body="Your wallet signs owner actions such as native 0G deposits, withdrawals, pause, and revoke."
                tone="from-primary to-blue"
              />
              <InfoRow
                icon={<ShieldCheck className="h-6 w-6" />}
                title="Executor stays bounded"
                body="The agent executor can use only the narrow vault policy path; owner withdrawals stay with your wallet."
                tone="from-amber to-primary"
              />
              <InfoRow
                icon={<KeyRound className="h-6 w-6" />}
                title="Keys remain local"
                body="Private keys and wallet material never enter this app or its server routes."
                tone="from-primary to-teal"
              />
            </div>

            <div className="mt-12 flex flex-col items-center gap-4">
              <a
                href="https://metamask.io/download/"
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-on-primary interaction-transition hover:brightness-110"
              >
                Get a wallet
              </a>
              <a
                href="https://docs.0g.ai"
                target="_blank"
                rel="noreferrer"
                className="text-sm font-semibold text-primary interaction-transition hover:text-primary"
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
      <p className="mb-2 px-1 text-[12px] font-semibold text-primary">{title}</p>
      <div className="grid gap-1.5">
        {wallets.map((wallet) => (
          <button
            key={wallet.key}
            type="button"
            disabled={!wallet.connector || isConnecting}
            onClick={() => (wallet.connector ? void onConnect(wallet.connector) : undefined)}
            className="group flex h-11 w-full items-center gap-3 rounded-[12px] px-2.5 text-left text-foreground interaction-transition hover:bg-panel-strong disabled:cursor-not-allowed disabled:opacity-55"
          >
            <WalletIcon option={wallet} />
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{wallet.label}</span>
            {wallet.installed ? <Check className="h-4 w-4 text-primary" /> : null}
            {isConnecting && wallet.installed ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted" />
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
      <div className={`flex h-12 w-12 items-center justify-center rounded-[12px] bg-gradient-to-br ${tone} text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]`}>
        {icon}
      </div>
      <div>
        <p className="text-[15px] font-semibold leading-5 text-foreground">{title}</p>
        <p className="mt-1 text-sm leading-5 text-muted">{body}</p>
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
      tone: "bg-panel-solid-strong text-foreground",
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
