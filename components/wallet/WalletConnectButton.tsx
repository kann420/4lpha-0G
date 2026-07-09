"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, LogOut, Wallet } from "lucide-react";
import type { Connector } from "wagmi";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import type { OgNetworkId } from "@/lib/types";
import { ConnectWalletModal } from "./ConnectWalletModal";
import { useWalletConnection } from "./useWalletConnection";

export function WalletConnectButton({
  compact = false,
  networkId,
}: {
  compact?: boolean;
  networkId?: OgNetworkId;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const wallet = useWalletConnection(networkId);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function connect(connector: Connector) {
    setErrorMessage(null);
    dispatchSigmaPetReaction("wallet.connect.start", { force: true });
    try {
      await wallet.connectAsync({ connector });
      dispatchSigmaPetReaction("wallet.connected", { force: true });
      setModalOpen(false);
    } catch (error) {
      dispatchSigmaPetReaction("wallet.connect.fail", { force: true });
      setErrorMessage(sanitizeWalletError(error));
    }
  }

  function handleButtonClick() {
    if (wallet.isConnected) {
      setMenuOpen((current) => !current);
      return;
    }

    setErrorMessage(null);
    setModalOpen(true);
  }

  function disconnect() {
    wallet.disconnect();
    dispatchSigmaPetReaction("wallet.disconnect", { force: true });
    setMenuOpen(false);
  }

  async function switchToOg() {
    try {
      dispatchSigmaPetReaction("wallet.switch.start", { force: true });
      await wallet.switchToOg();
      dispatchSigmaPetReaction("wallet.switch.success", { force: true });
    } catch (error) {
      dispatchSigmaPetReaction("wallet.switch.fail", { force: true });
      setErrorMessage(sanitizeWalletError(error));
    }
  }

  const label = wallet.isConnected
    ? wallet.isWrongChain
      ? "Wrong network"
      : wallet.maskedAddress ?? "Connected"
    : "Connect Wallet";
  const icon = wallet.isConnecting ? (
    <Loader2 className="h-4 w-4 animate-spin" />
  ) : wallet.isWrongChain ? (
    <AlertTriangle className="h-4 w-4" />
  ) : (
    <Wallet className="h-4 w-4" />
  );

  return (
    <div ref={rootRef} className={`relative inline-flex ${menuOpen ? "z-[10000]" : ""}`}>
      <button
        type="button"
        aria-expanded={wallet.isConnected ? menuOpen : undefined}
        aria-haspopup={wallet.isConnected ? "menu" : undefined}
        title={wallet.isConnected ? "Open wallet menu" : "Open wallet connection"}
        onClick={handleButtonClick}
        className={`animate-nav-in inline-flex h-10 items-center gap-2 rounded-full text-sm font-medium hit-area-40 interaction-transition ${
          wallet.isConnected && !wallet.isWrongChain
            ? "border border-green/20 bg-green/10 text-green hover:bg-green/14"
            : wallet.isWrongChain
              ? "border border-amber/20 bg-amber/10 text-amber hover:bg-amber/14"
              : "bg-[var(--pulse-teal)] text-on-primary shadow-[0_0_0_1px_rgba(30,232,197,0.28),0_14px_36px_rgba(30,232,197,0.12)] hover:-translate-y-0.5 hover:shadow-[0_0_0_3px_rgba(30,232,197,0.2),0_18px_46px_rgba(30,232,197,0.22)] hover:brightness-110"
        } ${compact ? "px-3" : "px-4"}`}
      >
        {icon}
        <span className={compact ? "hidden sm:inline" : undefined}>{label}</span>
        {wallet.isConnected ? <ChevronDown className="h-3.5 w-3.5 opacity-75" /> : null}
      </button>

      {wallet.isConnected ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-[9999] w-64 overflow-hidden rounded-[16px] border border-line bg-panel-solid-strong/95 p-2 text-sm text-foreground opacity-100 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl"
          hidden={!menuOpen}
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">
              Connected wallet
            </p>
            <p className="mt-1 truncate font-mono text-[13px] text-foreground">
              {wallet.maskedAddress ?? wallet.address}
            </p>
            {wallet.connectorName ? (
              <p className="mt-1 truncate text-xs text-muted">{wallet.connectorName}</p>
            ) : null}
          </div>

          {wallet.isWrongChain ? (
            <button
              type="button"
              role="menuitem"
              disabled={wallet.isSwitchingChain}
              onClick={() => void switchToOg()}
              className="mt-2 flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-amber interaction-transition hover:bg-amber/10 disabled:cursor-wait disabled:opacity-70"
            >
              <span>Switch to {wallet.targetNetworkName}</span>
              {wallet.isSwitchingChain ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            </button>
          ) : null}

          <button
            type="button"
            role="menuitem"
            onClick={disconnect}
            className="mt-2 flex w-full items-center gap-2 rounded-[12px] px-3 py-2.5 text-left text-rose interaction-transition hover:bg-rose/10"
          >
            <LogOut className="h-4 w-4" />
            Disconnect
          </button>
        </div>
      ) : null}

      <ConnectWalletModal
        connectors={wallet.connectors}
        errorMessage={errorMessage}
        isConnecting={wallet.isConnecting}
        onClose={() => setModalOpen(false)}
        onConnect={connect}
        open={modalOpen}
      />
    </div>
  );
}

function sanitizeWalletError(error: unknown) {
  const message = error instanceof Error ? error.message : "Wallet connection failed.";
  if (message.length > 160) {
    return `${message.slice(0, 157)}...`;
  }
  return message;
}
