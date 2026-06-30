"use client";

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  BrainCircuit,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  History,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Save,
  Send,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useSignMessage } from "wagmi";
import { type Hex } from "viem";
import { WalletConnectButton } from "@/components/wallet";
import { useWalletConnection } from "@/components/wallet/useWalletConnection";
import { AGENT_TRADE_ROUTES } from "@/lib/agent/trade-catalog";
import {
  buildCopilotSessionKeyMessage,
  buildCopilotWalletAccessMessage,
} from "@/lib/copilot/wallet-access";
import {
  bytesToBase64,
  base64ToBytes,
  decryptSessionBytes,
  deriveSessionAesKey,
  encryptSessionBytes,
} from "@/lib/copilot/session-key";
import { parseSessionBundle, serializeSessionBundle } from "@/lib/copilot/session-bundle";
import { shortHash } from "@/lib/format";
import type {
  AgentTradeExecution,
  AgentTradePreview,
  AgentTradeRequest,
  AgentTradeResponse,
  AgentTradeRouteOption,
  CopilotAuditBundle,
  CopilotChatResponse,
  CopilotContextItem,
  CopilotMessage,
  CopilotModelOption,
  CopilotModelsResponse,
  CopilotSessionBundle,
  CopilotSessionMessage,
  CopilotSessionRegistryRecord,
  OgNetworkId,
} from "@/lib/types";

export interface EmbeddedCopilotMessage extends CopilotMessage {
  card?: CopilotTradeCard;
  content: string;
  role: "operator" | "assistant";
  status?: "error" | "pending";
}

type CopilotPermissionMode = "default" | "full_access";
type CopilotSessionMode = "saved" | "privacy";

const SESSION_KEY_STORAGE_PREFIX = "4lpha:copilot:session-key";
const CHAT_SESSION_MODE_STORAGE_KEY = "4lpha:copilot:session-mode";
const COPILOT_ACCESS_STORAGE_PREFIX = "4lpha:copilot:access";

type CopilotWalletProof = {
  address: string;
  chainId: number;
  message: string;
  signature: string;
};

type CopilotTradeRequestDraft = Omit<AgentTradeRequest, "amountIn" | "intent"> & {
  amountIn?: string;
  amountSource?: "balance_percent" | "token_amount";
  requestedPercent?: number;
  sellPercent?: number;
};

interface CopilotTradeReviewCard {
  draftId: string;
  expiresAt: number;
  kind: "trade_review";
  mode: CopilotPermissionMode;
  preview: AgentTradePreview;
  request: CopilotTradeRequestDraft;
}

interface CopilotTradeResultCard {
  error?: string;
  execution?: AgentTradeExecution;
  kind: "trade_result";
  preview?: AgentTradePreview;
  request: CopilotTradeRequestDraft;
  status: "cancelled" | "failed" | "success";
}

type CopilotTradeCard = CopilotTradeReviewCard | CopilotTradeResultCard;

/** Pre-encrypted body for a single auto-save, ready to POST to /sessions/save. */
interface StagedSessionSave {
  sessionId: string;
  createdAt: string;
  ciphertextB64: string;
  ivB64: string;
  messageCount: number;
  model: string;
  label?: string;
}

export interface EmbeddedCopilotRailProps {
  context?: CopilotContextItem[];
  description: string;
  initialMessages: EmbeddedCopilotMessage[];
  isMobile?: boolean;
  networkId: OgNetworkId;
  networkLabel: string;
  onClose?: () => void;
  placeholder: string;
  sendIcon?: "message" | "send";
}

export const COPILOT_MOBILE_PANEL_CLASS =
  "h-[min(82svh,52rem)] max-h-[calc(100svh-2rem)] overflow-hidden rounded-[28px] shadow-[0_30px_80px_rgba(0,0,0,0.45)]";

type NetworkScopedState<T> = Partial<Record<OgNetworkId, T>>;
type ModelCatalogState = {
  defaultModel?: string;
  error?: string;
  models: CopilotModelOption[];
  status: "idle" | "loading" | "ready" | "error";
};

const COPILOT_QUICK_PROMPTS = [
  {
    prompt: "How to create an agent?",
    response:
      "To create an agent:\n1. Connect your wallet.\n2. Open Fund and deposit 0G into your Smart Vault. Deposit only 0G.\n3. Open Agent, choose Create Agent, then customize the agent the way you want.",
  },
  {
    prompt: "What is a Smart Vault?",
    response:
      "A Smart Vault is your wallet-owned 0G vault for agent funds. You deposit 0G, set limits, and let an approved agent run only allowed buy/sell actions. You can pause, revoke, or withdraw whenever needed.",
  },
] as const;

const EMPTY_MODEL_CATALOG: ModelCatalogState = {
  models: [],
  status: "idle",
};

export function EmbeddedCopilotRail({
  context,
  description,
  initialMessages,
  isMobile = false,
  networkId,
  networkLabel,
  onClose,
  placeholder,
  sendIcon = "send",
}: EmbeddedCopilotRailProps) {
  const wallet = useWalletConnection(networkId);
  const signMessage = useSignMessage();
  const [draftByNetwork, setDraftByNetwork] = useState<NetworkScopedState<string>>({});
  const [isSendingByNetwork, setIsSendingByNetwork] = useState<NetworkScopedState<boolean>>({});
  const [messagesByNetwork, setMessagesByNetwork] = useState<NetworkScopedState<EmbeddedCopilotMessage[]>>({
    mainnet: initialMessages,
    testnet: initialMessages,
  });
  const [modelCatalogByNetwork, setModelCatalogByNetwork] = useState<NetworkScopedState<ModelCatalogState>>({});
  const [permissionModeByNetwork, setPermissionModeByNetwork] = useState<NetworkScopedState<CopilotPermissionMode>>({});
  const [selectedModelByNetwork, setSelectedModelByNetwork] = useState<NetworkScopedState<string>>({});
  const [activeTradeDraftIdByNetwork, setActiveTradeDraftIdByNetwork] = useState<NetworkScopedState<string>>({});
  const [isTradeSubmittingByNetwork, setIsTradeSubmittingByNetwork] = useState<NetworkScopedState<boolean>>({});
  const [walletAccessByKey, setWalletAccessByKey] = useState<Record<string, string>>({});
  const [sessionModeByNetwork, setSessionModeByNetwork] = useState<NetworkScopedState<CopilotSessionMode>>({});
  const [sessionIdByNetwork, setSessionIdByNetwork] = useState<NetworkScopedState<string>>({});
  const [savedSessionsByNetwork, setSavedSessionsByNetwork] = useState<NetworkScopedState<CopilotSessionRegistryRecord[]>>({});
  const [auditBundlesByNetwork, setAuditBundlesByNetwork] = useState<NetworkScopedState<CopilotAuditBundle[]>>({});
  const [isSavingSessionByNetwork, setIsSavingSessionByNetwork] = useState<NetworkScopedState<boolean>>({});
  const [isLoadingSessionByNetwork, setIsLoadingSessionByNetwork] = useState<NetworkScopedState<boolean>>({});
  const [sessionKeySignatureByKey, setSessionKeySignatureByKey] = useState<Record<string, string>>({});
  const [isPastSessionsOpen, setIsPastSessionsOpen] = useState(false);
  const [saveErrorByNetwork, setSaveErrorByNetwork] = useState<NetworkScopedState<string>>({});
  // Track which sessionIds have already been saved (one save per session — the
  // ProofRegistry rejects a duplicate actionHash, so updates are not supported).
  const [savedSessionIdsByNetwork, setSavedSessionIdsByNetwork] = useState<NetworkScopedState<Record<string, true>>>({});
  // Pre-encrypted save body for the current session, recomputed (debounced) as
  // the transcript changes. Auto-save on session end sends this via fetch; on
  // page unload it is sent via navigator.sendBeacon so the save survives F5.
  const stagedSaveRef = useRef<StagedSessionSave | null>(null);
  const pendingAutoSaveRef = useRef(false);

  const networkRoutes = useMemo(
    () => AGENT_TRADE_ROUTES.filter((route) => route.networkId === networkId),
    [networkId],
  );
  const draft = draftByNetwork[networkId] ?? "";
  const isSending = isSendingByNetwork[networkId] ?? false;
  const isTradeSubmitting = isTradeSubmittingByNetwork[networkId] ?? false;
  const messages = messagesByNetwork[networkId] ?? initialMessages;
  const modelCatalog = modelCatalogByNetwork[networkId] ?? EMPTY_MODEL_CATALOG;
  const permissionMode = permissionModeByNetwork[networkId] ?? "default";
  const selectedModel = selectedModelByNetwork[networkId] ?? "";
  const chatLocked = !wallet.isConnected || wallet.isWrongChain || !wallet.address;
  const lockMessage = !wallet.isConnected
    ? "Connect your wallet to unlock 0G Copilot chat and protect Policy Vault context."
    : wallet.isWrongChain
      ? `Switch wallet to ${wallet.targetNetworkName} before using this ${networkLabel} Copilot.`
      : undefined;
  const walletAccessKey = wallet.address ? `${networkId}:${wallet.chainId}:${wallet.address.toLowerCase()}` : undefined;
  // Saved Copilot sessions are mainnet-only (0G Storage + ProofRegistry require chain 16661).
  const savedModeAvailable = networkId === "mainnet";
  const rawSessionMode = sessionModeByNetwork[networkId] ?? "saved";
  const sessionMode: CopilotSessionMode = savedModeAvailable ? rawSessionMode : "privacy";
  const sessionId = sessionIdByNetwork[networkId];
  const isSavingSession = isSavingSessionByNetwork[networkId] ?? false;
  const isLoadingSession = isLoadingSessionByNetwork[networkId] ?? false;
  const saveError = saveErrorByNetwork[networkId];
  const savedSessions = savedSessionsByNetwork[networkId] ?? [];
  const hasConversation = (messagesByNetwork[networkId] ?? initialMessages).some(
    (message) => message.role === "operator" || message.role === "assistant",
  );
  const currentSessionSaved = sessionId
    ? Boolean(savedSessionIdsByNetwork[networkId]?.[sessionId])
    : false;

  useEffect(() => {
    setMessagesByNetwork((current) => (current[networkId] ? current : { ...current, [networkId]: initialMessages }));
  }, [initialMessages, networkId]);

  // Restore the per-network Saved/Privacy preference from localStorage on mount
  // and when the network changes. Privacy is forced on testnet regardless.
  useEffect(() => {
    if (!savedModeAvailable) {
      setSessionModeByNetwork((current) => ({ ...current, [networkId]: "privacy" }));
      return;
    }
    try {
      const stored = window.localStorage.getItem(`${CHAT_SESSION_MODE_STORAGE_KEY}:${networkId}`);
      if (stored === "privacy" || stored === "saved") {
        setSessionModeByNetwork((current) => ({ ...current, [networkId]: stored }));
      }
    } catch {
      // localStorage unavailable; default to "saved".
    }
  }, [networkId, savedModeAvailable]);

  // When the wallet connects on mainnet, fetch its saved sessions so the Past
  // Sessions popover is populated immediately.
  useEffect(() => {
    if (!savedModeAvailable || chatLocked || !wallet.address) {
      return;
    }
    void refreshSavedSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedModeAvailable, networkId, wallet.address, wallet.isConnected, wallet.isWrongChain]);

  useEffect(() => {
    let cancelled = false;

    setModelCatalogByNetwork((current) => ({
      ...current,
      [networkId]: {
        defaultModel: current[networkId]?.defaultModel,
        models: current[networkId]?.models ?? [],
        status: "loading",
      },
    }));

    fetch(`/api/copilot/models?networkId=${encodeURIComponent(networkId)}`)
      .then(async (response) => {
        const payload = (await response.json()) as CopilotModelsResponse;
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "Unable to read 0G Router model catalog.");
        }
        return payload.data;
      })
      .then((data) => {
        if (cancelled) {
          return;
        }

        setModelCatalogByNetwork((current) => ({
          ...current,
          [networkId]: {
            defaultModel: data.defaultModel,
            models: data.models,
            status: "ready",
          },
        }));
        setSelectedModelByNetwork((current) => {
          const selected = current[networkId];
          if (!selected || data.models.some((model) => model.id === selected)) {
            return current;
          }

          return { ...current, [networkId]: "" };
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setModelCatalogByNetwork((current) => ({
          ...current,
          [networkId]: {
            error: error instanceof Error ? error.message : "Unable to read 0G Router model catalog.",
            models: [],
            status: "error",
          },
        }));
        setSelectedModelByNetwork((current) => ({ ...current, [networkId]: "" }));
      });

    return () => {
      cancelled = true;
    };
  }, [networkId]);

  async function ensureCopilotWalletProof(connectedAddress: string): Promise<CopilotWalletProof> {
    const accessMessage = buildCopilotWalletAccessMessage({
      address: connectedAddress,
      chainId: wallet.chainId,
      networkId,
    });
    // The access signature is a static, replayable proof of wallet ownership (no
    // nonce by existing design). Cache it in component state AND localStorage so
    // a page refresh can re-list/load saved sessions without re-prompting MetaMask.
    const accessStorageKey = walletAccessKey
      ? `${COPILOT_ACCESS_STORAGE_PREFIX}:${walletAccessKey}`
      : undefined;
    const accessSignature = walletAccessKey ? walletAccessByKey[walletAccessKey] : undefined;
    let signature = accessSignature;
    if (!signature && accessStorageKey) {
      try {
        signature = window.localStorage.getItem(accessStorageKey) ?? undefined;
      } catch {
        signature = undefined;
      }
    }
    if (!signature) {
      signature = await signMessage.signMessageAsync({ message: accessMessage });
    }

    if (walletAccessKey && !accessSignature) {
      setWalletAccessByKey((current) => ({ ...current, [walletAccessKey]: signature as string }));
      if (accessStorageKey) {
        try {
          window.localStorage.setItem(accessStorageKey, signature as string);
        } catch {
          // localStorage unavailable; in-memory cache still works for this session.
        }
      }
    }

    return {
      address: connectedAddress,
      chainId: wallet.chainId,
      message: accessMessage,
      signature,
    };
  }

  // ---- Saved/Privacy Copilot session storage helpers ----
  // The session-key signature is a CLIENT-ONLY secret (never sent to the server,
  // never used for auth). It is cached in component state + localStorage so the
  // same browser can decrypt a past session without re-signing. Cross-device
  // retrieval requires re-signing the same message (works on deterministic
  // wallets - viem local signer + MetaMask; may fail on Ledger/some mobile wallets).

  function generateSessionId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function ensureSessionId(): string {
    const existing = sessionIdByNetwork[networkId];
    if (existing) {
      return existing;
    }
    const id = generateSessionId();
    setSessionIdByNetwork((current) => ({ ...current, [networkId]: id }));
    return id;
  }

  function sessionKeyStateKey(connectedAddress: string, sessionId: string): string {
    return `${networkId}:${wallet.chainId}:${connectedAddress.toLowerCase()}:${sessionId}`;
  }

  function sessionKeyStorageKey(connectedAddress: string, sessionId: string): string {
    return `${SESSION_KEY_STORAGE_PREFIX}:${networkId}:${connectedAddress.toLowerCase()}:${sessionId}`;
  }

  async function ensureSessionKeySignature(connectedAddress: string, sessionId: string): Promise<Hex> {
    const stateKey = sessionKeyStateKey(connectedAddress, sessionId);
    const cached = sessionKeySignatureByKey[stateKey];
    if (cached) {
      return cached as Hex;
    }
    let fromStorage: string | undefined;
    try {
      fromStorage = window.localStorage.getItem(sessionKeyStorageKey(connectedAddress, sessionId)) ?? undefined;
    } catch {
      fromStorage = undefined;
    }
    if (fromStorage) {
      setSessionKeySignatureByKey((current) => ({ ...current, [stateKey]: fromStorage }));
      return fromStorage as Hex;
    }
    const message = buildCopilotSessionKeyMessage({
      address: connectedAddress,
      chainId: wallet.chainId,
      networkId,
      sessionId,
    });
    const signature = await signMessage.signMessageAsync({ message });
    setSessionKeySignatureByKey((current) => ({ ...current, [stateKey]: signature }));
    try {
      window.localStorage.setItem(sessionKeyStorageKey(connectedAddress, sessionId), signature);
    } catch {
      // localStorage may be unavailable (private mode); state cache still works for this session.
    }
    return signature as Hex;
  }

  async function refreshSavedSessions() {
    if (!wallet.address || !savedModeAvailable || chatLocked) {
      return;
    }
    try {
      const proof = await ensureCopilotWalletProof(wallet.address);
      const res = await fetch("/api/copilot/sessions/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: proof, networkId }),
      });
      const payload = (await res.json()) as { data?: { sessions?: CopilotSessionRegistryRecord[] } };
      if (payload.data?.sessions) {
        setSavedSessionsByNetwork((current) => ({ ...current, [networkId]: payload.data!.sessions! }));
      }
    } catch {
      // Listing is best-effort; surface nothing on transient failure.
    }
  }

  function toSessionMessage(message: EmbeddedCopilotMessage): CopilotSessionMessage {
    const out: CopilotSessionMessage = { content: message.content, role: message.role };
    if (message.status) {
      out.status = message.status;
    }
    if (message.card) {
      out.card = message.card;
    }
    return out;
  }

  function fromSessionMessage(message: CopilotSessionMessage): EmbeddedCopilotMessage {
    const out: EmbeddedCopilotMessage = { content: message.content, role: message.role };
    if (message.status) {
      out.status = message.status;
    }
    if (message.card) {
      out.card = message.card as CopilotTradeCard;
    }
    return out;
  }

  function deriveSessionLabel(messages: EmbeddedCopilotMessage[]): string | undefined {
    const first = messages.find((message) => message.role === "operator");
    return first ? first.content.slice(0, 80) : undefined;
  }

  async function saveCurrentSession() {
    if (chatLocked || isSavingSession || !wallet.address) {
      return;
    }
    const transcript = messagesByNetwork[networkId] ?? initialMessages;
    if (!transcript.some((message) => message.role === "operator")) {
      return;
    }
    const id = ensureSessionId();
    const createdAt = new Date().toISOString();
    const auditBundles = auditBundlesByNetwork[networkId] ?? [];
    setIsSavingSessionByNetwork((current) => ({ ...current, [networkId]: true }));
    setSaveErrorByNetwork((current) => {
      const next = { ...current };
      delete next[networkId];
      return next;
    });
    try {
      const bundle: CopilotSessionBundle = {
        schemaVersion: 1,
        kind: "copilot-session",
        sessionId: id,
        wallet: { address: wallet.address, chainId: wallet.chainId, networkId },
        createdAt,
        updatedAt: createdAt,
        mode: "saved",
        model: selectedModel || "auto",
        networkLabel,
        messages: transcript.map(toSessionMessage),
        auditBundles,
      };
      const plaintext = serializeSessionBundle(bundle);
      const signature = await ensureSessionKeySignature(wallet.address, id);
      const key = await deriveSessionAesKey(signature);
      const { iv, ciphertext } = await encryptSessionBytes(plaintext, key);
      const proof = await ensureCopilotWalletProof(wallet.address);
      const res = await fetch("/api/copilot/sessions/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: proof,
          sessionId: id,
          networkId,
          ciphertextB64: bytesToBase64(ciphertext),
          ivB64: bytesToBase64(iv),
          messageCount: transcript.length,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(deriveSessionLabel(transcript) ? { label: deriveSessionLabel(transcript) } : {}),
          createdAt,
        }),
      });
      const payload = (await res.json()) as {
        data?: { rootHash: string; proofTxHash: string; storageRef: string };
        error?: { message: string };
      };
      if (!res.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Failed to save Copilot session to 0G Storage.");
      }
      appendSaveResultMessage(payload.data);
      await refreshSavedSessions();
    } catch (error) {
      setSaveErrorByNetwork((current) => ({
        ...current,
        [networkId]: error instanceof Error ? error.message : "Failed to save Copilot session.",
      }));
    } finally {
      setIsSavingSessionByNetwork((current) => ({ ...current, [networkId]: false }));
    }
  }

  function appendSaveResultMessage(result: { rootHash: string; proofTxHash: string; storageRef: string }) {
    setMessagesByNetwork((current) => ({
      ...current,
      [networkId]: [
        ...(current[networkId] ?? initialMessages),
        {
          content:
            `Saved this session to 0G Storage (encrypted, anchored on-chain).\nStorage root: ${shortHash(result.rootHash)}\nProof tx: ${shortHash(result.proofTxHash)}`,
          role: "assistant",
        },
      ],
    }));
  }

  async function loadSavedSession(record: CopilotSessionRegistryRecord) {
    if (chatLocked || isLoadingSession || !wallet.address) {
      return;
    }
    setIsLoadingSessionByNetwork((current) => ({ ...current, [networkId]: true }));
    setIsPastSessionsOpen(false);
    try {
      const id = record.sessionId;
      const signature = await ensureSessionKeySignature(wallet.address, id);
      const key = await deriveSessionAesKey(signature);
      const proof = await ensureCopilotWalletProof(wallet.address);
      const res = await fetch("/api/copilot/sessions/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: proof, sessionId: id }),
      });
      const payload = (await res.json()) as {
        data?: { ciphertextB64: string; ivB64: string };
        error?: { message: string };
      };
      if (!res.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Failed to load Copilot session.");
      }
      const ciphertext = base64ToBytes(payload.data.ciphertextB64);
      const iv = base64ToBytes(payload.data.ivB64);
      const plaintext = await decryptSessionBytes({ iv, ciphertext }, key);
      const bundle = parseSessionBundle(plaintext);
      setSessionIdByNetwork((current) => ({ ...current, [networkId]: bundle.sessionId }));
      setMessagesByNetwork((current) => ({ ...current, [networkId]: bundle.messages.map(fromSessionMessage) }));
      setAuditBundlesByNetwork((current) => ({ ...current, [networkId]: bundle.auditBundles }));
    } catch (error) {
      setMessagesByNetwork((current) => ({
        ...current,
        [networkId]: [
          ...(current[networkId] ?? initialMessages),
          {
            content: error instanceof Error ? error.message : "Failed to decrypt / load this session.",
            role: "assistant",
            status: "error",
          },
        ],
      }));
    } finally {
      setIsLoadingSessionByNetwork((current) => ({ ...current, [networkId]: false }));
    }
  }

  function startNewSession() {
    setMessagesByNetwork((current) => ({ ...current, [networkId]: initialMessages }));
    setAuditBundlesByNetwork((current) => {
      const next = { ...current };
      delete next[networkId];
      return next;
    });
    setSessionIdByNetwork((current) => {
      const next = { ...current };
      delete next[networkId];
      return next;
    });
    setSaveErrorByNetwork((current) => {
      const next = { ...current };
      delete next[networkId];
      return next;
    });
  }

  function handleClosePanel() {
    // Privacy mode is ephemeral: clear the transcript and any collected audit
    // bundles before closing so nothing persists beyond the session.
    if (sessionMode === "privacy") {
      setMessagesByNetwork((current) => ({ ...current, [networkId]: initialMessages }));
      setAuditBundlesByNetwork((current) => {
        const next = { ...current };
        delete next[networkId];
        return next;
      });
      setSessionIdByNetwork((current) => {
        const next = { ...current };
        delete next[networkId];
        return next;
      });
    }
    onClose?.();
  }

  async function requestCopilotTrade(
    intent: "preview" | "execute",
    tradeRequest: CopilotTradeRequestDraft,
    walletProof: CopilotWalletProof,
  ): Promise<NonNullable<AgentTradeResponse["data"]>> {
    const response = await fetch("/api/copilot/trade", {
      body: JSON.stringify({
        intent,
        request: tradeRequest,
        wallet: walletProof,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const payload = (await response.json()) as AgentTradeResponse;

    if (!payload.data) {
      throw new Error(payload.error?.message ?? "Copilot trade route failed.");
    }

    return payload.data;
  }

  async function submitPrompt(value: string) {
    const content = value.trim();
    if (!content || isSending) {
      return;
    }

    if (chatLocked) {
      setMessagesByNetwork((current) => ({
        ...current,
        [networkId]: [
          ...(current[networkId] ?? initialMessages),
          {
            content: lockMessage ?? "Connect your wallet to unlock 0G Copilot chat.",
            role: "assistant",
            status: "error",
          },
        ],
      }));
      return;
    }

    const connectedAddress = wallet.address;
    if (!connectedAddress) {
      return;
    }

    // Saved mode: lazily assign a sessionId for this conversation so per-turn
    // audit bundles can be associated with the session that gets uploaded.
    if (savedModeAvailable && sessionMode === "saved") {
      ensureSessionId();
    }

    const quickPromptResponse = resolveQuickPromptResponse(content);
    if (quickPromptResponse) {
      const operatorMessage: EmbeddedCopilotMessage = { content, role: "operator" };
      setMessagesByNetwork((current) => ({
        ...current,
        [networkId]: [
          ...(current[networkId] ?? initialMessages),
          operatorMessage,
          {
            content: quickPromptResponse,
            role: "assistant",
          },
        ],
      }));
      setDraftByNetwork((current) => ({ ...current, [networkId]: "" }));
      return;
    }

    setIsSendingByNetwork((current) => ({ ...current, [networkId]: true }));

    let pendingMessage: EmbeddedCopilotMessage | undefined;

    try {
      const operatorMessage: EmbeddedCopilotMessage = { content, role: "operator" };
      const tradeCommand = resolveCopilotTradeCommand(content, networkId, networkRoutes);

      if (tradeCommand?.kind === "clarify") {
        setMessagesByNetwork((current) => ({
          ...current,
          [networkId]: [
            ...(current[networkId] ?? initialMessages),
            operatorMessage,
            {
              content: tradeCommand.message,
              role: "assistant",
            },
          ],
        }));
        setDraftByNetwork((current) => ({ ...current, [networkId]: "" }));
        return;
      }

      pendingMessage = {
        content: tradeCommand
          ? permissionMode === "full_access"
            ? "Preparing allowlisted route quote and bypass execution..."
            : "Preparing allowlisted route review..."
          : "Routing through 0G Compute Router...",
        role: "assistant",
        status: "pending",
      };
      const currentMessages = messagesByNetwork[networkId] ?? initialMessages;
      const routeMessages = [...currentMessages, operatorMessage].map((message) => ({
        content: message.content,
        role: message.role,
      }));

      setMessagesByNetwork((current) => ({
        ...current,
        [networkId]: [...(current[networkId] ?? initialMessages), operatorMessage, pendingMessage],
      }));
      setDraftByNetwork((current) => ({ ...current, [networkId]: "" }));

      const walletProof = await ensureCopilotWalletProof(connectedAddress);

      if (tradeCommand?.kind === "trade") {
        const previewData = await requestCopilotTrade("preview", tradeCommand.request, walletProof);
        const resolvedRequest = resolvePreviewTradeRequest(tradeCommand.request, previewData.preview);
        const draftId = createDraftId();
        const reviewCard: CopilotTradeReviewCard = {
          draftId,
          expiresAt: parseExpiresAt(previewData.preview.quote.expiresAt),
          kind: "trade_review",
          mode: permissionMode,
          preview: previewData.preview,
          request: resolvedRequest,
        };

        if (permissionMode === "default" || previewData.preview.proofBundle.policyDecision !== "allow") {
          setMessagesByNetwork((current) => ({
            ...current,
            [networkId]: [
              ...(current[networkId] ?? initialMessages).filter((item) => item !== pendingMessage),
              {
                card: reviewCard,
                content:
                  previewData.preview.proofBundle.policyDecision === "allow"
                    ? "Review this 0G Policy Vault trade before execution."
                    : "Route preview needs review before execution. I will not bypass a non-allow policy decision.",
                role: "assistant",
              },
            ],
          }));
          return;
        }

        const executeData = await requestCopilotTrade("execute", resolvedRequest, walletProof);
        const execution = executeData.execution;
        const resultCard: CopilotTradeResultCard = {
          execution,
          kind: "trade_result",
          preview: executeData.preview,
          request: tradeCommand.request,
          status: isSuccessfulTradeExecution(execution) ? "success" : "failed",
          ...(execution?.reason && !isSuccessfulTradeExecution(execution) ? { error: execution.reason } : {}),
        };

        setMessagesByNetwork((current) => ({
          ...current,
          [networkId]: [
            ...(current[networkId] ?? initialMessages).filter((item) => item !== pendingMessage),
            {
              card: resultCard,
              content: isSuccessfulTradeExecution(execution)
                ? "Bypass mode executed the allowlisted 0G Policy Vault trade."
                : "Bypass mode stopped because the vault executor returned a blocked result.",
              role: "assistant",
              ...(isSuccessfulTradeExecution(execution) ? {} : { status: "error" as const }),
            },
          ],
        }));
        return;
      }

      const response = await fetch("/api/copilot/chat", {
        body: JSON.stringify({
          context,
          messages: routeMessages,
          mode: sessionMode,
          ...(selectedModel ? { model: selectedModel } : {}),
          networkId,
          wallet: {
            address: walletProof.address,
            chainId: walletProof.chainId,
            message: walletProof.message,
            signature: walletProof.signature,
          },
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json()) as CopilotChatResponse;

      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "0G Compute Router request failed.");
      }

      const { message, auditBundle } = payload.data;
      setMessagesByNetwork((current) => ({
        ...current,
        [networkId]: [
          ...(current[networkId] ?? initialMessages).filter((item) => item !== pendingMessage),
          {
            content: message.content,
            role: "assistant",
          },
        ],
      }));
      // Saved mode: collect the per-turn audit bundle so the saved session
      // transcript can include the verifiable evidence. Privacy mode: server
      // omits the audit bundle and we collect nothing.
      if (sessionMode === "saved" && auditBundle) {
        const collected = auditBundle;
        setAuditBundlesByNetwork((current) => ({
          ...current,
          [networkId]: [...(current[networkId] ?? []), collected],
        }));
      }
    } catch (error) {
      setMessagesByNetwork((current) => ({
        ...current,
        [networkId]: [
          ...(current[networkId] ?? initialMessages).filter((item) => item !== pendingMessage),
          {
            content: error instanceof Error ? error.message : "0G Compute Router request failed.",
            role: "assistant",
            status: "error",
          },
        ],
      }));
    } finally {
      setIsSendingByNetwork((current) => ({ ...current, [networkId]: false }));
    }
  }

  async function confirmTrade(draftId: string) {
    if (chatLocked || isTradeSubmitting) {
      return;
    }

    const connectedAddress = wallet.address;
    if (!connectedAddress) {
      return;
    }

    const reviewCard = findTradeReviewCard(messagesByNetwork[networkId] ?? initialMessages, draftId);
    if (!reviewCard) {
      return;
    }

    setActiveTradeDraftIdByNetwork((current) => ({ ...current, [networkId]: draftId }));
    setIsTradeSubmittingByNetwork((current) => ({ ...current, [networkId]: true }));

    try {
      const walletProof = await ensureCopilotWalletProof(connectedAddress);
      const executeData = await requestCopilotTrade("execute", reviewCard.request, walletProof);
      const execution = executeData.execution;
      const resultCard: CopilotTradeResultCard = {
        execution,
        kind: "trade_result",
        preview: executeData.preview,
        request: reviewCard.request,
        status: isSuccessfulTradeExecution(execution) ? "success" : "failed",
        ...(execution?.reason && !isSuccessfulTradeExecution(execution) ? { error: execution.reason } : {}),
      };

      replaceTradeReviewCard(draftId, {
        card: resultCard,
        content: isSuccessfulTradeExecution(execution)
          ? "Confirmed. The 0G Policy Vault trade request was accepted."
          : "Confirmed, but the vault executor blocked the trade.",
        role: "assistant",
        ...(isSuccessfulTradeExecution(execution) ? {} : { status: "error" as const }),
      });
    } catch (error) {
      const resultCard: CopilotTradeResultCard = {
        error: error instanceof Error ? error.message : "Copilot trade execution failed.",
        kind: "trade_result",
        preview: reviewCard.preview,
        request: reviewCard.request,
        status: "failed",
      };

      replaceTradeReviewCard(draftId, {
        card: resultCard,
        content: "Trade execution failed before the vault accepted it.",
        role: "assistant",
        status: "error",
      });
    } finally {
      setActiveTradeDraftIdByNetwork((current) => {
        const next = { ...current };
        delete next[networkId];
        return next;
      });
      setIsTradeSubmittingByNetwork((current) => ({ ...current, [networkId]: false }));
    }
  }

  function cancelTrade(draftId: string) {
    const reviewCard = findTradeReviewCard(messagesByNetwork[networkId] ?? initialMessages, draftId);
    if (!reviewCard) {
      return;
    }

    replaceTradeReviewCard(draftId, {
      card: {
        kind: "trade_result",
        preview: reviewCard.preview,
        request: reviewCard.request,
        status: "cancelled",
      },
      content: "Canceled. No 0G Policy Vault trade was submitted.",
      role: "assistant",
    });
  }

  function replaceTradeReviewCard(draftId: string, replacement: EmbeddedCopilotMessage) {
    setMessagesByNetwork((current) => ({
      ...current,
      [networkId]: (current[networkId] ?? initialMessages).map((message) =>
        message.card?.kind === "trade_review" && message.card.draftId === draftId ? replacement : message,
      ),
    }));
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (chatLocked || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    void submitPrompt(draft);
  }

  return (
    <section
      className={`relative flex h-full max-h-full min-h-0 flex-col overflow-hidden border border-line bg-panel-solid-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${
        isMobile ? "rounded-[28px]" : "rounded-[24px]"
      }`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top,rgba(30,232,197,0.14),transparent_58%)]" />

      <header className="relative z-20 shrink-0 border-b border-line bg-panel px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/20 bg-primary/15 text-primary">
                <Bot className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-lg font-bold text-foreground">4lpha Agent</h2>
                <p className="text-sm leading-5 text-muted">{description}</p>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <SessionModeToggle
                mode={sessionMode}
                disabled={!savedModeAvailable}
                onChange={(mode) => {
                  setSessionModeByNetwork((current) => ({ ...current, [networkId]: mode }));
                  if (savedModeAvailable) {
                    try {
                      window.localStorage.setItem(`${CHAT_SESSION_MODE_STORAGE_KEY}:${networkId}`, mode);
                    } catch {
                      // localStorage unavailable; keep in-memory default.
                    }
                  }
                  // Switching to privacy drops any collected audit bundles.
                  if (mode === "privacy") {
                    setAuditBundlesByNetwork((current) => {
                      const next = { ...current };
                      delete next[networkId];
                      return next;
                    });
                  }
                }}
              />
              <button
                type="button"
                onClick={() => setIsPastSessionsOpen((value) => !value)}
                disabled={chatLocked || !savedModeAvailable || savedSessions.length === 0}
                title={
                  !savedModeAvailable
                    ? "Saved sessions require 0G mainnet storage"
                    : savedSessions.length === 0
                      ? "No saved sessions yet"
                      : "Browse saved Copilot sessions"
                }
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-panel-solid-strong px-2.5 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-line-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Past sessions"
              >
                <History className="h-3.5 w-3.5" />
                {savedSessions.length > 0 ? savedSessions.length : "Past"}
              </button>
              <span className="min-w-0 flex-1 truncate rounded-[10px] border border-line bg-panel-solid-strong px-2.5 py-1.5 text-xs font-semibold text-foreground">
                {networkLabel}
              </span>
            </div>
            {isPastSessionsOpen && savedModeAvailable ? (
              <PastSessionsPopover
                sessions={savedSessions}
                isLoading={isLoadingSession}
                onClose={() => setIsPastSessionsOpen(false)}
                onLoad={loadSavedSession}
              />
            ) : null}
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="relative flex h-10 min-w-0 items-center gap-2 rounded-[12px] border border-line bg-panel-solid-strong px-3 text-xs font-semibold text-foreground">
                <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="sr-only">LLM model</span>
                <select
                  value={selectedModel}
                  onChange={(event) =>
                    setSelectedModelByNetwork((current) => ({ ...current, [networkId]: event.target.value }))
                  }
                  disabled={modelCatalog.status === "loading"}
                  className="min-w-0 flex-1 appearance-none truncate bg-transparent pr-6 text-xs font-semibold text-foreground outline-none disabled:text-muted"
                  aria-label="LLM model"
                >
                  <option className="bg-panel-solid-strong text-foreground" value="">
                    {modelCatalog.defaultModel ? `Auto: ${shortModelLabel(modelCatalog.defaultModel)}` : "Auto Router model"}
                  </option>
                  {modelCatalog.models.map((model) => (
                    <option key={model.id} className="bg-panel-solid-strong text-foreground" value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 h-3.5 w-3.5 text-muted" />
              </label>
              <span
                className={`inline-flex h-10 items-center rounded-[12px] border px-2.5 text-xs font-semibold ${
                  modelCatalog.status === "error"
                    ? "border-amber/20 bg-amber/10 text-amber"
                    : "border-line bg-panel-solid-strong text-muted"
                }`}
                title={modelCatalog.error}
              >
                {modelStatusLabel(modelCatalog)}
              </span>
            </div>
            {chatLocked ? (
              <div className="mt-3 flex flex-col gap-3 rounded-[14px] border border-amber/20 bg-amber/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 gap-2">
                  <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
                  <p className="text-sm leading-5 text-amber">
                    {lockMessage}
                  </p>
                </div>
                <WalletConnectButton compact networkId={networkId} />
              </div>
            ) : null}
          </div>

          {onClose ? (
            <button
              type="button"
              onClick={handleClosePanel}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-panel text-muted transition-colors hover:border-line-strong hover:text-foreground"
              aria-label="Close copilot"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="scrollbar-subtle relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`rounded-[18px] border p-3 text-sm leading-6 ${
                message.role === "operator"
                  ? "ml-8 border-primary/20 bg-primary/10 text-primary"
                  : message.status === "error"
                    ? "mr-8 border-rose/20 bg-rose/10 text-rose"
                    : "mr-8 border-line bg-panel-solid-strong text-muted"
              }`}
            >
              <div className="flex gap-2">
                {message.status === "pending" ? (
                  <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-primary" />
                ) : null}
                <p className="whitespace-pre-line">{message.content}</p>
              </div>
              {message.card?.kind === "trade_review" ? (
                <TradeReviewCardView
                  card={message.card}
                  isSubmitting={
                    isTradeSubmitting && activeTradeDraftIdByNetwork[networkId] === message.card.draftId
                  }
                  onCancel={cancelTrade}
                  onConfirm={confirmTrade}
                />
              ) : null}
              {message.card?.kind === "trade_result" ? <TradeResultCardView card={message.card} /> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-panel-solid-strong px-4 py-3">
        <div className="rounded-[22px] border border-line bg-panel-solid-strong p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="mb-3 flex flex-wrap gap-2">
            {COPILOT_QUICK_PROMPTS.map((item) => (
              <button
                key={item.prompt}
                type="button"
                onClick={() => void submitPrompt(item.prompt)}
                disabled={chatLocked || isSending}
                className="inline-flex min-h-10 items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 text-xs font-semibold text-primary transition-[background-color,border-color,color,transform] hover:border-primary/30 hover:bg-primary/15 hover:text-foreground active:scale-[0.96] disabled:cursor-not-allowed disabled:border-line disabled:bg-panel disabled:text-muted"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                {item.prompt}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="mb-2 block text-xs font-bold uppercase tracking-[0.18em] text-muted">
              Operator request
            </span>
            <textarea
              value={draft}
              onChange={(event) => setDraftByNetwork((current) => ({ ...current, [networkId]: event.target.value }))}
              onKeyDown={handleDraftKeyDown}
              placeholder={chatLocked ? "Connect wallet to use 0G Copilot chat..." : placeholder}
              disabled={chatLocked}
              className="min-h-[72px] w-full resize-none bg-transparent text-base leading-7 text-foreground placeholder:text-muted focus:outline-none disabled:cursor-not-allowed disabled:text-muted"
            />
          </label>

          {(saveError || (sessionMode === "saved" && savedModeAvailable && hasConversation)) ? (
            <div className="mt-3 rounded-[12px] border border-line bg-panel-solid-strong px-3 py-2 text-xs">
              {saveError ? (
                <p className="text-rose">Save failed: {saveError}</p>
              ) : (
                <p className="text-muted">
                  Saved mode: this transcript is encrypted with your wallet key and uploaded to 0G Storage when you press
                  Save.
                </p>
              )}
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <PermissionModeDropdown
                mode={permissionMode}
                onChange={(mode) => setPermissionModeByNetwork((current) => ({ ...current, [networkId]: mode }))}
              />
              {sessionMode === "saved" && savedModeAvailable ? (
                <button
                  type="button"
                  onClick={() => void saveCurrentSession()}
                  disabled={chatLocked || isSavingSession || !hasConversation}
                  title="Encrypt this transcript with your wallet key and save it to 0G Storage"
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary transition-[background-color,border-color,color,transform] hover:border-primary/30 hover:bg-primary/15 active:scale-[0.96] disabled:cursor-not-allowed disabled:border-line disabled:bg-panel disabled:text-muted"
                >
                  {isSavingSession ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  {isSavingSession ? "Saving..." : "Save to 0G"}
                </button>
              ) : null}
              {hasConversation ? (
                <button
                  type="button"
                  onClick={startNewSession}
                  disabled={isSavingSession || isSending}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-xs font-semibold text-muted transition-colors hover:border-line-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  New session
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void submitPrompt(draft)}
              disabled={chatLocked || !draft.trim() || isSending}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--pulse-teal)] text-background transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send"
            >
              {isSending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : sendIcon === "message" ? (
                <MessageSquare className="h-3.5 w-3.5" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function modelStatusLabel(catalog: ModelCatalogState): string {
  if (catalog.status === "loading") {
    return "Loading";
  }

  if (catalog.status === "error") {
    return "Config needed";
  }

  if (catalog.status === "ready") {
    return catalog.models.length === 1 ? "1 model" : `${catalog.models.length} models`;
  }

  return "Catalog";
}

function resolveQuickPromptResponse(content: string): string | undefined {
  const normalized = normalizeSearchText(content);
  return COPILOT_QUICK_PROMPTS.find((item) => normalizeSearchText(item.prompt) === normalized)?.response;
}

function shortModelLabel(modelId: string): string {
  if (modelId.length <= 34) {
    return modelId;
  }

  return `${modelId.slice(0, 16)}...${modelId.slice(-14)}`;
}

function PermissionModeDropdown({
  mode,
  onChange,
}: {
  mode: CopilotPermissionMode;
  onChange: (mode: CopilotPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isFullAccess = mode === "full_access";

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-[background-color,border-color,color,transform] active:scale-[0.96] ${
          isFullAccess
            ? "border-amber/30 bg-amber/10 text-amber hover:bg-amber/20"
            : "border-line bg-panel text-muted hover:border-line-strong hover:text-foreground"
        }`}
      >
        {isFullAccess ? <ShieldAlert className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
        {isFullAccess ? "Bypass Approvals" : "Default Approvals"}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-56 overflow-hidden rounded-[14px] border border-line bg-panel-solid-strong shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
          <button
            type="button"
            onClick={() => {
              onChange("default");
              setOpen(false);
            }}
            className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-panel ${
              !isFullAccess ? "text-foreground" : "text-muted"
            }`}
          >
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green" />
            <span>
              <span className="block text-[11px] font-semibold leading-none">Default Approvals</span>
              <span className="mt-1 block text-[10px] leading-4 text-muted">Confirm before execution</span>
            </span>
          </button>
          <div className="mx-3 border-t border-line" />
          <button
            type="button"
            onClick={() => {
              onChange("full_access");
              setOpen(false);
            }}
            className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-panel ${
              isFullAccess ? "text-amber" : "text-muted"
            }`}
          >
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" />
            <span>
              <span className="block text-[11px] font-semibold leading-none">Bypass Approvals</span>
              <span className="mt-1 block text-[10px] leading-4 text-muted">Auto-execute allowed previews</span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SessionModeToggle({
  mode,
  disabled,
  onChange,
}: {
  mode: CopilotSessionMode;
  disabled?: boolean;
  onChange: (mode: CopilotSessionMode) => void;
}) {
  const isSaved = mode === "saved";
  return (
    <div
      className={`inline-flex rounded-[10px] border border-line bg-panel-solid-strong p-0.5 ${
        disabled ? "opacity-60" : ""
      }`}
      title={disabled ? "Saved mode requires 0G mainnet storage" : "Choose how this chat session is handled"}
    >
      <button
        type="button"
        onClick={() => onChange("saved")}
        disabled={disabled}
        className={`rounded-[8px] px-2.5 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
          isSaved ? "bg-panel-strong text-foreground" : "text-muted hover:text-foreground"
        }`}
      >
        Saved
      </button>
      <button
        type="button"
        onClick={() => onChange("privacy")}
        className={`inline-flex items-center gap-1 rounded-[8px] px-2.5 py-1 text-xs font-semibold transition-colors ${
          !isSaved ? "bg-panel-strong text-foreground" : "text-muted hover:text-foreground"
        }`}
      >
        Privacy
      </button>
    </div>
  );
}

function PastSessionsPopover({
  sessions,
  isLoading,
  onClose,
  onLoad,
}: {
  sessions: CopilotSessionRegistryRecord[];
  isLoading: boolean;
  onClose: () => void;
  onLoad: (session: CopilotSessionRegistryRecord) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-50 mt-1.5 max-h-[60svh] w-80 overflow-hidden rounded-[14px] border border-line bg-panel-solid-strong shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted">Past sessions</span>
        <span className="text-[10px] text-muted">{sessions.length}</span>
      </div>
      <div className="max-h-[52svh] overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">No saved sessions yet.</p>
        ) : (
          sessions.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              onClick={() => onLoad(session)}
              disabled={isLoading}
              className="flex w-full flex-col items-start gap-1 border-b border-line px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-panel disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="line-clamp-1 w-full text-xs font-semibold text-foreground">
                {session.label ?? session.sessionId}
              </span>
              <span className="text-[10px] text-muted">
                {new Date(session.createdAt).toLocaleString()} - {session.messageCount} msgs
              </span>
              <span className="text-[10px] text-muted">root {shortHash(session.rootHash)}</span>
              <span className="text-[10px] text-muted">proof {shortHash(session.proofTxHash)}</span>
            </button>
          ))
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-[10px] text-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> Decrypting & loading...
        </div>
      ) : null}
    </div>
  );
}

function TradeReviewCardView({
  card,
  isSubmitting,
  onCancel,
  onConfirm,
}: {
  card: CopilotTradeReviewCard;
  isSubmitting: boolean;
  onCancel: (draftId: string) => void;
  onConfirm: (draftId: string) => void | Promise<void>;
}) {
  const now = Date.now();
  const isExpired = card.expiresAt <= now;
  const decision = card.preview.proofBundle.policyDecision;
  const canConfirm = !isSubmitting && !isExpired && decision === "allow";
  const quote = card.preview.quote;

  return (
    <div className="mt-3 rounded-[18px] border border-primary/20 bg-panel-solid-strong p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.22em] text-primary/70">
            {card.request.side === "buy" ? "Buy review" : "Sell review"}
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-foreground">{quote.routeLabel}</p>
          <p className="mt-1 truncate text-xs text-muted">
            {quote.venue} - {card.preview.route.outputToken}
          </p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${tradeDecisionTone(decision, isExpired)}`}>
          {isSubmitting ? "Executing" : isExpired ? "Expired" : decision === "allow" ? "Review" : decision}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-muted sm:grid-cols-2">
        <TradeMetric label="Input" value={`${quote.amountIn} ${quote.inputToken}`} />
        <TradeMetric label="Expected out" value={`${quote.expectedAmountOut} ${quote.outputToken}`} />
        <TradeMetric label="Min out" value={`${quote.amountOutMin} ${quote.outputToken}`} />
        <TradeMetric label="Slippage" value={formatBps(quote.slippageBps)} />
        <TradeMetric label="Expires" value={formatRelativeTime(card.expiresAt, now)} />
        <TradeMetric label="Price impact" value={formatBps(quote.priceImpactBps)} />
      </div>

      <div className="mt-3 rounded-[16px] border border-line bg-panel px-3 py-2 text-xs text-muted">
        <ProofLine label="Policy hash" value={card.preview.proofBundle.policyDecisionHash} />
        <ProofLine label="Storage root" value={card.preview.proofBundle.storageRoot} />
        <ProofLine label="Route hash" value={quote.routeHash} />
      </div>

      {quote.warnings.length > 0 || decision !== "allow" ? (
        <div className="mt-3 flex gap-2 rounded-[16px] border border-amber/20 bg-amber/10 px-3 py-2 text-xs leading-5 text-amber">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{quote.warnings[0] ?? "Policy decision is not allow; execution requires review."}</span>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!canConfirm}
          onClick={() => void onConfirm(card.draftId)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--pulse-teal)] px-3 py-1.5 text-xs font-semibold text-background transition-[filter,transform] hover:brightness-105 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
          Confirm
        </button>
        <button
          type="button"
          disabled={isSubmitting || isExpired}
          onClick={() => onCancel(card.draftId)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-muted transition-[background-color,border-color,color,transform] hover:border-line-strong hover:text-foreground active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        {card.mode === "full_access" && decision !== "allow" ? (
          <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-amber/20 bg-amber/10 px-3 py-1.5 text-[11px] text-amber">
            <CircleAlert className="h-3.5 w-3.5" />
            Bypass blocked by policy
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TradeResultCardView({ card }: { card: CopilotTradeResultCard }) {
  const success = card.status === "success";
  const cancelled = card.status === "cancelled";
  const quote = card.preview?.quote;
  const executionTxHash = card.execution?.txHash;
  const proofTxHash = card.execution?.proofBundle.proofTxHash ?? card.preview?.proofBundle.proofTxHash ?? "pending";
  const executionTxUrl = transactionExplorerUrl(card.request.networkId, executionTxHash);
  const proofTxUrl = transactionExplorerUrl(card.request.networkId, proofTxHash);

  return (
    <div
      className={`mt-3 rounded-[18px] border p-3 ${
        success
          ? "border-green/20 bg-panel-solid-strong"
          : cancelled
            ? "border-line bg-panel"
            : "border-rose/20 bg-panel-solid-strong"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.22em] text-muted">Trade result</p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {success ? "Accepted" : cancelled ? "Canceled" : "Failed"}
          </p>
          <p className="mt-1 truncate text-xs text-muted">
            {quote?.routeLabel ?? shortHash(card.request.routeId)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${
            success
              ? "border-green/20 bg-green/10 text-green"
              : cancelled
                ? "border-line bg-panel text-muted"
                : "border-rose/20 bg-rose/10 text-rose"
          }`}
        >
          {success ? card.execution?.status ?? "success" : cancelled ? "canceled" : "blocked"}
        </span>
      </div>

      {card.error ? (
        <div className="mt-3 rounded-[14px] border border-line bg-panel px-3 py-2 text-xs leading-5 text-muted">
          {card.error}
        </div>
      ) : null}

      <div className="mt-3 grid gap-2 text-xs text-muted sm:grid-cols-2">
        <TradeMetric label="Amount" value={quote ? `${quote.amountIn} ${quote.inputToken}` : card.request.amountIn ?? "--"} />
        <TradeMetric label="Receive" value={quote ? `${quote.expectedAmountOut} ${quote.outputToken}` : "--"} />
        <TradeMetric label="Policy" value={card.execution?.proofBundle.policyDecision ?? card.preview?.proofBundle.policyDecision ?? "--"} />
        <TradeMetric label="Submitted" value={card.execution?.submittedAt ? formatDateTime(card.execution.submittedAt) : "--"} />
      </div>

      <div className="mt-3 rounded-[16px] border border-line bg-panel px-3 py-2 text-xs text-muted">
        <ProofLine label="Proof tx" value={proofTxHash} href={proofTxUrl} />
        <ProofLine label="Quote hash" value={card.execution?.proofBundle.quoteHash ?? card.preview?.proofBundle.quoteHash ?? "--"} />
        <ProofLine label="Tx hash" value={executionTxHash ?? "--"} href={executionTxUrl} />
      </div>

      {success && (executionTxUrl || proofTxUrl) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {executionTxUrl ? <ExplorerLink href={executionTxUrl} label="View execution tx" /> : null}
          {proofTxUrl ? <ExplorerLink href={proofTxUrl} label="View proof tx" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function TradeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[14px] border border-line bg-panel px-3 py-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted">{label}</span>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-foreground" title={value}>
        {value}
      </p>
    </div>
  );
}

function ProofLine({ href, label, value }: { href?: string; label: string; value: string }) {
  const display = value.startsWith("0x") ? shortHash(value) : value;

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-1">
      <span className="text-muted">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center justify-end gap-1.5 truncate text-right font-mono font-semibold text-primary hover:text-foreground"
          title={value}
        >
          <span className="truncate">{display}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <span className="min-w-0 truncate text-right font-mono font-semibold text-foreground" title={value}>
          {display}
        </span>
      )}
    </div>
  );
}

function ExplorerLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary transition-colors hover:border-primary/30 hover:bg-primary/15 hover:text-foreground"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {label}
    </a>
  );
}

type TradeCommandResolution =
  | {
      kind: "clarify";
      message: string;
    }
  | {
      kind: "trade";
      request: CopilotTradeRequestDraft;
    };

export function resolveCopilotTradeCommand(
  content: string,
  networkId: OgNetworkId,
  routes: AgentTradeRouteOption[],
): TradeCommandResolution | undefined {
  const normalized = normalizeSearchText(content);
  const commandMatch = normalized.match(/^\s*(buy|sell|swap|mua|ban)\b/u);
  if (!commandMatch) {
    return undefined;
  }

  const command = commandMatch[1];
  const side = command === "sell" || command === "ban" ? "sell" : resolveSwapSide(normalized);
  const afterCommand = content.slice(commandMatch[0].length);
  const requestedPercent = side === "sell" ? extractSellPercent(content.trim().toLowerCase()) : undefined;
  const amountMatch = requestedPercent === undefined
    ? afterCommand.match(/(?:^|\s)(\d+(?:\.\d{1,18})?)(?=\s|$|%)/u)
    : null;
  if (!amountMatch && requestedPercent === undefined) {
    return {
      kind: "clarify",
      message: `Tell me the ${side === "buy" ? "0G spend" : "token amount"} first. Example: ${side} ${
        routes[0]?.defaultAmountIn ?? "0.001"
      } ${routes[0]?.outputToken ?? "USDC.e"}.`,
    };
  }

  const routeResolution = resolveRouteFromCommand(normalized, side, routes);
  if (routeResolution.kind === "clarify") {
    return routeResolution;
  }

  const route = routeResolution.route;
  if (requestedPercent !== undefined) {
    return {
      kind: "trade",
      request: {
        agentId: route.agentId,
        amountSource: "balance_percent",
        auditId: route.auditId,
        networkId,
        requestedPercent,
        routeId: route.id,
        sellPercent: requestedPercent,
        side: "sell",
        slippageBps: 75,
      },
    };
  }

  const amountIn = amountMatch?.[1];
  if (!amountIn) {
    return {
      kind: "clarify",
      message: "Use an exact decimal amount for this 0G Policy Vault trade command.",
    };
  }

  const amount = parseDecimal(amountIn);
  const maxAmount = parseDecimal(route.maxAmountIn);
  if (amount === undefined || maxAmount === undefined || amount <= 0) {
    return {
      kind: "clarify",
      message: "Use a positive decimal amount for 0G Policy Vault trade commands.",
    };
  }
  if (amount > maxAmount) {
    return {
      kind: "clarify",
      message: `Amount exceeds the ${route.maxAmountIn} ${side === "buy" ? route.inputToken : route.outputToken} Copilot route cap. Try: ${side} ${route.defaultAmountIn} ${route.outputToken}.`,
    };
  }

  return {
    kind: "trade",
    request: {
      agentId: route.agentId,
      amountIn,
      amountSource: "token_amount",
      auditId: route.auditId,
      networkId,
      routeId: route.id,
      side,
      slippageBps: 75,
    },
  };
}

function resolveSwapSide(normalized: string): "buy" | "sell" {
  if (/\bto\s+0g\b/u.test(normalized) || /\bfor\s+0g\b/u.test(normalized)) {
    return "sell";
  }

  return "buy";
}

function resolveRouteFromCommand(
  normalizedContent: string,
  side: "buy" | "sell",
  routes: AgentTradeRouteOption[],
):
  | {
      kind: "clarify";
      message: string;
    }
  | {
      kind: "route";
      route: AgentTradeRouteOption;
    } {
  const scoredRoutes = routes
    .map((route) => ({ route, score: scoreRouteMatch(normalizedContent, route) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scoredRoutes.length > 0) {
    return { kind: "route", route: scoredRoutes[0].route };
  }

  const sideReadyRoutes = routes.filter((route) => route.defaultSide === side && route.readiness !== "blocked");
  if (sideReadyRoutes.length === 1) {
    return { kind: "route", route: sideReadyRoutes[0] };
  }

  return {
    kind: "clarify",
    message: `Which allowlisted ${side} route should I use on this 0G network? Available: ${formatRouteChoices(routes, side)}.`,
  };
}

function scoreRouteMatch(content: string, route: AgentTradeRouteOption): number {
  const routeId = normalizeSearchText(route.id);
  const label = normalizeSearchText(route.label);
  const inputToken = normalizeSearchText(route.inputToken);
  const outputToken = normalizeSearchText(route.outputToken);
  const tokenAddress = route.tokenAddress ? normalizeSearchText(route.tokenAddress) : "";
  let score = 0;

  if (routeId && content.includes(routeId)) {
    score += 100;
  }
  if (tokenAddress && content.includes(tokenAddress)) {
    score += 90;
  }
  if (outputToken !== "0g" && hasTokenWord(content, outputToken)) {
    score += 60;
  }
  if (inputToken !== "0g" && hasTokenWord(content, inputToken)) {
    score += 50;
  }
  if (label && label.split(" ").some((word) => word.length > 2 && hasTokenWord(content, word))) {
    score += 12;
  }

  return score;
}

function hasTokenWord(content: string, token: string): boolean {
  if (!token) {
    return false;
  }

  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "u").test(content);
}

function formatRouteChoices(routes: AgentTradeRouteOption[], side: "buy" | "sell"): string {
  const preferred = routes.filter((route) => route.readiness !== "blocked" && route.defaultSide === side);
  const candidates = preferred.length > 0 ? preferred : routes.filter((route) => route.readiness !== "blocked");
  return candidates
    .slice(0, 6)
    .map((route) => `${route.outputToken} (${route.label})`)
    .join(", ");
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractSellPercent(normalizedContent: string): number | undefined {
  if (hasTokenWord(normalizedContent, "all") || hasTokenWord(normalizedContent, "max") || hasTokenWord(normalizedContent, "full")) {
    return 100;
  }

  const percentMatch = normalizedContent.match(/(?:^|\s)(\d+(?:\.\d{1,4})?)\s*(?:%|percent)(?=\s|$)/u);
  if (!percentMatch) {
    return undefined;
  }

  const value = Number(percentMatch[1]);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    return undefined;
  }

  return value;
}

function parseDecimal(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolvePreviewTradeRequest(
  request: CopilotTradeRequestDraft,
  preview: AgentTradePreview,
): CopilotTradeRequestDraft {
  if (request.amountSource !== "balance_percent") {
    return request;
  }

  return {
    agentId: request.agentId,
    amountIn: preview.quote.amountIn,
    amountSource: "token_amount",
    auditId: request.auditId,
    networkId: request.networkId,
    requestedPercent: request.requestedPercent,
    routeId: request.routeId,
    side: request.side,
    slippageBps: request.slippageBps,
  };
}

function findTradeReviewCard(messages: EmbeddedCopilotMessage[], draftId: string): CopilotTradeReviewCard | undefined {
  return messages.find((message) => message.card?.kind === "trade_review" && message.card.draftId === draftId)?.card as
    | CopilotTradeReviewCard
    | undefined;
}

function createDraftId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `trade-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseExpiresAt(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now() + 90_000;
}

function isSuccessfulTradeExecution(execution: AgentTradeExecution | undefined): boolean {
  return execution?.status === "submitted" || execution?.status === "stubbed" || execution?.status === "queued";
}

function tradeDecisionTone(decision: AgentTradePreview["proofBundle"]["policyDecision"], isExpired: boolean): string {
  if (isExpired || decision === "reject") {
    return "border-rose/20 bg-rose/10 text-rose";
  }

  if (decision === "review") {
    return "border-amber/20 bg-amber/10 text-amber";
  }

  return "border-primary/20 bg-primary/10 text-primary";
}

function formatBps(value: number): string {
  const percent = value / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((timestamp - now) / 1000));
  if (seconds <= 0) {
    return "Expired";
  }

  return `${seconds}s`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function explorerBaseUrl(networkId: OgNetworkId): string {
  return networkId === "mainnet" ? "https://chainscan.0g.ai" : "https://chainscan-galileo.0g.ai";
}

function transactionExplorerUrl(networkId: OgNetworkId, hash: string | undefined): string | undefined {
  if (!hash || !/^0x[a-fA-F0-9]{64}$/u.test(hash)) {
    return undefined;
  }

  return `${explorerBaseUrl(networkId)}/tx/${hash}`;
}
