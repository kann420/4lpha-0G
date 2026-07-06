"use client";

export const SIGMA_PET_STATE_EVENT = "4lpha:sigma-pet-state";
export const SIGMA_PET_GREETING = "Hello. I am Sigma the 4lpha 0G pet";
export const SIGMA_POSITION_STORAGE_KEY = "4lpha:sigma-pet-position";
export const SIGMA_ATLAS_COLUMNS = 8;
export const SIGMA_ATLAS_ROWS = 9;

export const SIGMA_ANIMATIONS = {
  idle: { frames: 6, intervalMs: 180, row: 0 },
  "running-right": { frames: 8, intervalMs: 110, row: 1 },
  "running-left": { frames: 8, intervalMs: 110, row: 2 },
  waving: { frames: 4, intervalMs: 170, row: 3 },
  jumping: { frames: 5, intervalMs: 130, row: 4 },
  failed: { frames: 8, intervalMs: 170, row: 5 },
  waiting: { frames: 6, intervalMs: 190, row: 6 },
  running: { frames: 6, intervalMs: 105, row: 7 },
  review: { frames: 6, intervalMs: 155, row: 8 },
} as const;

export type SigmaPetAnimationState = keyof typeof SIGMA_ANIMATIONS;

export interface SigmaPetStateDetail {
  bubbleText?: string;
  state: SigmaPetAnimationState;
}

export interface SigmaPetMessageLike {
  content: string;
  role: "operator" | "assistant";
  status?: "error" | "pending";
  card?: {
    kind?: string;
    status?: string;
  } | null;
}

export interface SigmaPetStateInput {
  chatError?: string;
  isChatSending: boolean;
  isTradeSubmitting: boolean;
  isTransferSubmitting: boolean;
  messages: SigmaPetMessageLike[];
  tradeError?: string;
}

export function buildSigmaPetState({
  chatError,
  isChatSending,
  isTradeSubmitting,
  isTransferSubmitting,
  messages,
  tradeError,
}: SigmaPetStateInput): SigmaPetStateDetail {
  const errorText = tradeError ?? chatError;
  if (errorText) {
    return {
      bubbleText: truncateSigmaText(errorText),
      state: "failed",
    };
  }

  if (isTradeSubmitting) {
    return { bubbleText: "Executing trade...", state: "running" };
  }

  if (isTransferSubmitting) {
    return { bubbleText: "Sending transfer...", state: "running" };
  }

  if (isChatSending) {
    const latest = messages[messages.length - 1];
    if (latest?.role === "assistant" && latest.content.trim().length > 0) {
      return {
        bubbleText: truncateSigmaText(latest.content),
        state:
          latest.card?.kind === "trade_review" || latest.card?.kind === "transfer_review"
            ? "review"
            : "running",
      };
    }

    return { bubbleText: "Thinking...", state: "waiting" };
  }

  if (messages.length === 0) {
    return { bubbleText: SIGMA_PET_GREETING, state: "waving" };
  }

  const latest = messages[messages.length - 1];
  return {
    state: latest ? resolveSigmaMessageState(latest) : "idle",
  };
}

function resolveSigmaMessageState(message: SigmaPetMessageLike): SigmaPetAnimationState {
  if (message.role !== "assistant") return "idle";
  if (message.status === "error") return "failed";

  const card = message.card;
  if (!card) return "idle";
  if (card.kind === "trade_review" || card.kind === "transfer_review") return "review";

  if (card.kind === "trade_result") {
    if (card.status === "success") return "jumping";
    if (card.status === "failed") return "failed";
  }

  if (card.kind === "transfer_result") {
    if (card.status === "confirmed") return "jumping";
    if (card.status === "failed") return "failed";
  }

  return "idle";
}

function truncateSigmaText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 110) return normalized;
  return `${normalized.slice(0, 107)}...`;
}
