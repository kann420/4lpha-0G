"use client";

export const SIGMA_PET_STATE_EVENT = "4lpha:sigma-pet-state";
export const SIGMA_PET_GREETING = "Hello. I am Sigma the 4lpha 0G pet";
export const SIGMA_POSITION_STORAGE_KEY = "4lpha:sigma-pet-position";
export const SIGMA_ATLAS_COLUMNS = 8;
export const SIGMA_ATLAS_ROWS = 9;
const SIGMA_REACTION_COOLDOWN_MS = 45_000;

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

export type SigmaPetReactionId =
  | "agent.arm.start"
  | "agent.arm.success"
  | "agent.create.choice"
  | "agent.create.form"
  | "agent.deploy.fail"
  | "agent.deploy.start"
  | "agent.deploy.success"
  | "agent.detail"
  | "agent.pause.start"
  | "agent.pause.success"
  | "agent.remove.start"
  | "agent.remove.success"
  | "agent.sell.fail"
  | "agent.sell.start"
  | "agent.sell.success"
  | "app.idle"
  | "app.network"
  | "app.theme"
  | "chat.answer"
  | "chat.cancel-trade"
  | "chat.clarify"
  | "chat.confirm-trade"
  | "chat.enter"
  | "chat.model"
  | "chat.new-session"
  | "chat.past-sessions"
  | "chat.privacy"
  | "chat.saved"
  | "chat.session-load"
  | "chat.session-saved"
  | "chat.submit"
  | "chat.thinking"
  | "chat.trade-blocked"
  | "chat.trade-detected"
  | "chat.trade-failed"
  | "chat.trade-review"
  | "chat.trade-submitted"
  | "lp.auto-mint.off"
  | "lp.auto-mint.on"
  | "lp.create.form"
  | "lp.deploy.fail"
  | "lp.deploy.mint"
  | "lp.deploy.no-mint"
  | "lp.deploy.start"
  | "lp.detail"
  | "lp.manual-mint.open"
  | "lp.mint.fail"
  | "lp.mint.start"
  | "lp.mint.success"
  | "lp.mint.staked"
  | "lp.pause.start"
  | "lp.pause.success"
  | "lp.refresh"
  | "lp.remove.clean"
  | "lp.remove.positions"
  | "lp.resume.start"
  | "lp.resume.success"
  | "lp.stake.fail"
  | "lp.stake.start"
  | "lp.stake.success"
  | "lp.unstake.start"
  | "lp.unstake.fail"
  | "lp.unstake.success"
  | "lp.zap.fail"
  | "lp.zap.start"
  | "lp.zap.success"
  | "scan.enter"
  | "scan.fail"
  | "scan.sample"
  | "scan.start"
  | "scan.success"
  | "sigma.click"
  | "sigma.drag"
  | "trade.execute.start"
  | "trade.quote.ready"
  | "trade.quote.start"
  | "vault.create.start"
  | "vault.create.success"
  | "vault.deposit.fail"
  | "vault.deposit.start"
  | "vault.deposit.success"
  | "vault.enter"
  | "vault.migrate.start"
  | "vault.migrate.success"
  | "vault.pause"
  | "vault.refresh"
  | "vault.resume"
  | "vault.revoke"
  | "vault.withdraw.all"
  | "vault.withdraw.fail"
  | "vault.withdraw.start"
  | "vault.withdraw.success"
  | "wallet.connect.fail"
  | "wallet.connect.start"
  | "wallet.connected"
  | "wallet.disconnect"
  | "wallet.owner-mismatch"
  | "wallet.signature.pending"
  | "wallet.signature.rejected"
  | "wallet.switch.fail"
  | "wallet.switch.start"
  | "wallet.switch.success"
  | "wallet.wrong-network";

export const SIGMA_REACTIONS: Record<SigmaPetReactionId, SigmaPetStateDetail> = {
  "agent.arm.start": { bubbleText: "Arming agent. Controlled chaos is back online.", state: "running" },
  "agent.arm.success": { bubbleText: "Agent armed. Still fenced, still supervised.", state: "jumping" },
  "agent.create.choice": { bubbleText: "Choose the agent type. Buy/sell brain or LP chaos energy.", state: "waving" },
  "agent.create.form": { bubbleText: "Trading agent: buys and sells, but policy holds the leash.", state: "review" },
  "agent.deploy.fail": { bubbleText: "Deploy failed. Better stop here than mint cursed paperwork.", state: "failed" },
  "agent.deploy.start": { bubbleText: "Deploying agent. Minting ID and attaching the leash.", state: "running" },
  "agent.deploy.success": { bubbleText: "Agent deployed. It has an ID and adult supervision.", state: "jumping" },
  "agent.detail": { bubbleText: "Agent detail. Status, positions, receipts. No mystery meat.", state: "review" },
  "agent.pause.start": { bubbleText: "Pausing agent. The brain can nap now.", state: "waiting" },
  "agent.pause.success": { bubbleText: "Agent paused. Funds stay put; runtime sits down.", state: "waving" },
  "agent.remove.start": { bubbleText: "Removing agent. History stays, runtime gets benched.", state: "waiting" },
  "agent.remove.success": { bubbleText: "Agent removed. Receipts remain, drama retired.", state: "jumping" },
  "agent.sell.fail": { bubbleText: "Sell failed. Exit route tripped a wire.", state: "failed" },
  "agent.sell.start": { bubbleText: "Owner-approved sell. Exiting without cowboy nonsense.", state: "running" },
  "agent.sell.success": { bubbleText: "Sell submitted. Position is heading for the door.", state: "jumping" },
  "app.idle": { bubbleText: "Still here. Judging risk quietly.", state: "idle" },
  "app.network": { bubbleText: "Network changed. Same Sigma, different playground.", state: "waving" },
  "app.theme": { bubbleText: "Theme flipped. Sigma has range.", state: "waving" },
  "chat.answer": { bubbleText: "Answer landed. Verify before you flex.", state: "waving" },
  "chat.cancel-trade": { bubbleText: "Canceled. No funds were harmed in this drama.", state: "waving" },
  "chat.clarify": { bubbleText: "Need exact amount. Vibes are not valid calldata.", state: "review" },
  "chat.confirm-trade": { bubbleText: "Confirmed. Sending it through the policy tunnel.", state: "running" },
  "chat.enter": { bubbleText: "Good. Copilot turns questions into checked actions.", state: "waving" },
  "chat.model": { bubbleText: "Model set. Bigger brain, same leash.", state: "review" },
  "chat.new-session": { bubbleText: "Fresh session. Old chaos goes to storage therapy.", state: "waving" },
  "chat.past-sessions": { bubbleText: "Past sessions. Receipts, but encrypted. Classy.", state: "review" },
  "chat.privacy": { bubbleText: "Privacy mode. Poof after close, like responsible nonsense.", state: "waving" },
  "chat.saved": { bubbleText: "Saved mode. Encrypted memory, not gossip.", state: "waving" },
  "chat.session-load": { bubbleText: "Decrypting history. Hope past-you was coherent.", state: "waiting" },
  "chat.session-saved": { bubbleText: "Session anchored. Receipts secured on 0G.", state: "jumping" },
  "chat.submit": { bubbleText: "Reading. Precise prompts make fewer cursed trades.", state: "waiting" },
  "chat.thinking": { bubbleText: "Thinking. Small smoke from tiny brain engine.", state: "waiting" },
  "chat.trade-blocked": { bubbleText: "Blocked. Policy said no, and policy has hands.", state: "failed" },
  "chat.trade-detected": { bubbleText: "Trade intent spotted. Sigma is tightening the seatbelt.", state: "review" },
  "chat.trade-failed": { bubbleText: "Trade failed. Better blocked than broke.", state: "failed" },
  "chat.trade-review": { bubbleText: "Review this. The vault hates freestyle nonsense.", state: "review" },
  "chat.trade-submitted": { bubbleText: "Trade submitted. Chain gobbled the paperwork.", state: "jumping" },
  "lp.auto-mint.off": { bubbleText: "Auto-mint off. No surprise LP babies.", state: "waving" },
  "lp.auto-mint.on": { bubbleText: "Auto-mint on. Worker may mint inside the fence.", state: "running" },
  "lp.create.form": { bubbleText: "LP agent: mint, stake, exit. APR is not free candy.", state: "review" },
  "lp.deploy.fail": { bubbleText: "LP deploy failed. No shame; cursed pools are real.", state: "failed" },
  "lp.deploy.mint": { bubbleText: "LP agent live. First mint fired without tripping.", state: "jumping" },
  "lp.deploy.no-mint": { bubbleText: "LP agent live. First scan returned empty-handed.", state: "waving" },
  "lp.deploy.start": { bubbleText: "Deploying LP agent. Minting ID, then hunting a pool.", state: "running" },
  "lp.detail": { bubbleText: "LP detail. Positions, staking, exits, receipts.", state: "review" },
  "lp.manual-mint.open": { bubbleText: "Manual mint. Pick size; vault checks the leash.", state: "review" },
  "lp.mint.fail": { bubbleText: "Mint failed. Pool, cap, or RPC got spicy.", state: "failed" },
  "lp.mint.start": { bubbleText: "Minting LP NFT. Single-sided zap doing kitchen math.", state: "running" },
  "lp.mint.success": { bubbleText: "Minted. Stake next if you want the APR candy.", state: "jumping" },
  "lp.mint.staked": { bubbleText: "Minted and staked. APR can start doing its thing.", state: "jumping" },
  "lp.pause.start": { bubbleText: "LP pause incoming. Worker loop goes to timeout.", state: "waiting" },
  "lp.pause.success": { bubbleText: "LP paused. Worker loop is in timeout.", state: "waving" },
  "lp.refresh": { bubbleText: "Refreshing logs. Receipts should not be stale.", state: "waiting" },
  "lp.remove.clean": { bubbleText: "Removing LP agent. Clean bench, no open positions.", state: "waiting" },
  "lp.remove.positions": { bubbleText: "Close-all first. Sigma refuses orphaned NFTs.", state: "review" },
  "lp.resume.start": { bubbleText: "LP resume incoming. Keep the fence, wake the worker.", state: "running" },
  "lp.resume.success": { bubbleText: "LP resumed. Still fenced, still supervised.", state: "jumping" },
  "lp.stake.fail": { bubbleText: "Stake failed. NFT still exists, retry calmly.", state: "failed" },
  "lp.stake.start": { bubbleText: "Staking NFT. APR machine wants the ticket.", state: "running" },
  "lp.stake.success": { bubbleText: "Staked. Now it can chase rewards properly.", state: "jumping" },
  "lp.unstake.start": { bubbleText: "Unstaking. Pulling the NFT back to vault custody.", state: "running" },
  "lp.unstake.fail": { bubbleText: "Unstake failed. NFT did not leave staking custody.", state: "failed" },
  "lp.unstake.success": { bubbleText: "Unstaked. Ready for zap-out or another plan.", state: "jumping" },
  "lp.zap.fail": { bubbleText: "Zap-out failed. Funds stay put; inspect the reason.", state: "failed" },
  "lp.zap.start": { bubbleText: "Zap-out. Turning position back toward 0G.", state: "running" },
  "lp.zap.success": { bubbleText: "Zapped out. Position left the pool with receipts.", state: "jumping" },
  "scan.enter": { bubbleText: "Scan first, ape later. Revolutionary concept.", state: "waving" },
  "scan.fail": { bubbleText: "Scan failed. Even Sigma needs a clean endpoint.", state: "failed" },
  "scan.sample": { bubbleText: "Sample loaded. Fake danger, real checklist.", state: "review" },
  "scan.start": { bubbleText: "Scanning. Let the bad vibes confess on paper.", state: "running" },
  "scan.success": { bubbleText: "Report ready. Risk got dragged into daylight.", state: "jumping" },
  "sigma.click": { bubbleText: "Hey, why you touch me?", state: "waving" },
  "sigma.drag": { bubbleText: "Are you moving me somewhere?", state: "running" },
  "trade.execute.start": { bubbleText: "Triggering trade. Policy tunnel, no side quests.", state: "running" },
  "trade.quote.ready": { bubbleText: "Quote ready. Check min-out before getting brave.", state: "review" },
  "trade.quote.start": { bubbleText: "Quoting route. Min-out better not be zero.", state: "waiting" },
  "vault.create.start": { bubbleText: "Creating vault. Building a box for controlled chaos.", state: "running" },
  "vault.create.success": { bubbleText: "Vault created. Your agent now has guardrails.", state: "jumping" },
  "vault.deposit.fail": { bubbleText: "Deposit failed. Wallet/RPC drama detected.", state: "failed" },
  "vault.deposit.start": { bubbleText: "Depositing 0G. Feeding the vault, not the agent.", state: "running" },
  "vault.deposit.success": { bubbleText: "Deposit confirmed. Funds now wear a helmet.", state: "jumping" },
  "vault.enter": { bubbleText: "Vault time. Funds go in, chaos stays outside.", state: "waving" },
  "vault.migrate.start": { bubbleText: "Migrating vault. Keep tab open, no heroic refreshing.", state: "running" },
  "vault.migrate.success": { bubbleText: "Migration done. Old vault got retired politely.", state: "jumping" },
  "vault.pause": { bubbleText: "Paused. Agent hands off the buttons.", state: "waiting" },
  "vault.refresh": { bubbleText: "Refreshing vault state. Trust, but poke the RPC.", state: "waiting" },
  "vault.resume": { bubbleText: "Resumed. Agent may move, still inside policy.", state: "jumping" },
  "vault.revoke": { bubbleText: "Executor revoked. Nuclear brake pulled nicely.", state: "failed" },
  "vault.withdraw.all": { bubbleText: "All selected. Bold, but at least honest.", state: "review" },
  "vault.withdraw.fail": { bubbleText: "Withdraw failed. Vault refused the exit paperwork.", state: "failed" },
  "vault.withdraw.start": { bubbleText: "Withdrawing. Owner gets paid, executor watches sadly.", state: "running" },
  "vault.withdraw.success": { bubbleText: "Withdraw confirmed. Funds escaped correctly.", state: "jumping" },
  "wallet.connect.fail": { bubbleText: "Wallet connect failed. Extension said nah.", state: "failed" },
  "wallet.connect.start": { bubbleText: "Wallet handshake. Please do not rage-click.", state: "waiting" },
  "wallet.connected": { bubbleText: "Wallet connected. Sigma sees the signer.", state: "jumping" },
  "wallet.disconnect": { bubbleText: "Disconnected. Sigma returns to spectator mode.", state: "waving" },
  "wallet.owner-mismatch": { bubbleText: "Nice wallet, wrong owner. Vault is not impressed.", state: "failed" },
  "wallet.signature.pending": { bubbleText: "Waiting for signature. Read it, then sign it.", state: "waiting" },
  "wallet.signature.rejected": { bubbleText: "Rejected. No shame. Suspicion is a feature.", state: "waving" },
  "wallet.switch.fail": { bubbleText: "Network switch failed. Wallet said nope.", state: "failed" },
  "wallet.switch.start": { bubbleText: "Switching to 0G. Finally, the correct playground.", state: "running" },
  "wallet.switch.success": { bubbleText: "0G selected. Now the buttons mean something.", state: "jumping" },
  "wallet.wrong-network": { bubbleText: "Wrong network. Wrong chain, wrong circus.", state: "failed" },
};

const lastReactionAt = new Map<string, number>();

export function dispatchSigmaPetReaction(
  reactionId: SigmaPetReactionId,
  options: { cooldownMs?: number; force?: boolean } = {},
) {
  if (typeof window === "undefined") return;

  const reaction = SIGMA_REACTIONS[reactionId];
  if (!reaction) return;

  const now = Date.now();
  const cooldownMs = options.cooldownMs ?? SIGMA_REACTION_COOLDOWN_MS;
  const lastAt = lastReactionAt.get(reactionId) ?? 0;
  if (!options.force && now - lastAt < cooldownMs) return;

  lastReactionAt.set(reactionId, now);
  window.dispatchEvent(
    new CustomEvent<SigmaPetStateDetail>(SIGMA_PET_STATE_EVENT, {
      detail: reaction,
    }),
  );
}

export function sigmaReactionForPathname(pathname: string): SigmaPetReactionId | undefined {
  if (pathname === "/" || pathname === "/scan" || pathname === "/discover") return "scan.enter";
  if (pathname === "/chat") return "chat.enter";
  if (pathname === "/fund" || pathname === "/vault") return "vault.enter";
  if (pathname === "/agents/create") return "agent.create.choice";
  if (pathname === "/agents/create/trading") return "agent.create.form";
  if (pathname === "/agents/create/lp") return "lp.create.form";
  if (pathname.startsWith("/agents/lp/")) return "lp.detail";
  if (pathname.startsWith("/agents/") && pathname !== "/agents") return "agent.detail";
  if (pathname === "/agents") return "agent.create.choice";
  return undefined;
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
    return SIGMA_REACTIONS["trade.execute.start"];
  }

  if (isTransferSubmitting) {
    return { bubbleText: "Sending transfer. Tiny paperwork treadmill.", state: "running" };
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

    return SIGMA_REACTIONS["chat.thinking"];
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
