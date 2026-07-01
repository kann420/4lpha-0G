import "server-only";

/**
 * Conservative Copilot intent classification + deterministic responses.
 *
 * The main token-waste problem this solves: without a guard, off-topic prompts
 * ("build a sales website", "write me a python script", etc.) still get sent to
 * the 0G Compute Router, which spends real tokens answering them. The original
 * 4alpha project hit the same issue and fixed it by short-circuiting unsupported
 * intents with a deterministic refusal — no LLM call at all.
 *
 * Design: classify into `on_topic`, `off_topic`, `product_faq`, or
 * `market_analysis`. Only the clearest cases are short-circuited, so legit 0G /
 * product questions are never misrouted:
 *
 * - `off_topic` fires only when the message has a strong off-topic signal AND no
 *   0G / crypto / on-chain anchor keyword. Anchored messages always go to the
 *   LLM (which can still refuse if the request is truly unrelated).
 * - `product_faq` fires only for a tiny set of unambiguous, high-frequency
 *   product questions (who are you, how to create an agent, thanks). Everything
 *   else goes to the LLM with the rich system prompt.
 * - `market_analysis` fires for broad market-overview / regime / sentiment /
 *   trade-day prompts. It is NOT short-circuited — it goes to the 0G Compute
 *   Router with CMC market data injected as context and a Market Decision
 *   Framework system-prompt section so the answer is a structured, falsifiable
 *   market read rather than a plain narrative (Hướng B, data-layer-only CMC).
 */

export type CopilotIntent = "on_topic" | "off_topic" | "product_faq" | "market_analysis";

/** Sentinel model id recorded in the audit bundle for deterministic responses. */
export const COPILOT_POLICY_MODEL = "4lpha-copilot-policy";

// Anchor keywords that indicate the message is plausibly about 0G / 4lpha /
// crypto / on-chain trading. If ANY anchor is present, we never short-circuit as
// off_topic — the LLM handles it (and refuses if it is truly unrelated).
const ANCHOR_RE =
  /\b(0g|0gchain|og chain|compute router|storage|galileo|mainnet|testnet|vault|policy|copilot|agent|agentic|erc[-\s]?7857|trade|trading|swap|dex|buy|sell|deposit|withdraw|executor|proof|audit|on[-\s]?chain|token|crypto|wallet|defi|liquidity|slippage|bridge|nft|smart contract|gas|rpc|indexer|encrypt|session|mint|revoke|pause|kill switch|adapter|router|ai[-\s]?scan|risk|honeypot|approvals|behavior|scan)\b/i;

// Strong off-topic signals. Matched against the lowercased message. These are
// intentionally narrow and high-precision to avoid misrouting.
const OFF_TOPIC_RE =
  /\b(website|web ?site|web ?app|webapp|landing page|trang web|frontend|backend|build a site|build an app|make a website|make an app|code a|write code|coding|program|programming|write a script|write me a script|react|html|css|javascript|python|java script|translate|translation|dịch thuật|essay|homework|bài tập|viết bài|tóm tắt|recipe|how to cook|weather|joke|poem|write a poem|write a story|movie|game recommend|bán hàng|cửa hàng|store|shop online|ecommerce|e-?commerce|marketing|seo|sales website)\b/i;

const FAQ_WHO_ARE_YOU_RE = /\b(who are you|what are you|bạn là ai|you are who|what is this assistant)\b/i;
const FAQ_CREATE_AGENT_RE =
  /\b(how (do|to|can)|cách|làm sao)\b.*\b(create|set up|make|tạo|tạo lập|lập)\b.*\b(agent|trading agent|tác tử)\b/i;
const FAQ_THANKS_RE = /\b(thanks|thank you|thx|ty|cảm ơn|cám ơn)\b/i;

// Market-overview / regime / sentiment / trade-day prompts. These are answered
// through the 0G Compute Router (NOT short-circuited), but with grounded CMC
// market data injected as context and a Market Decision Framework system-prompt
// section (Hướng B). The patterns require an overview/regime/sentiment/trade-day
// signal — the bare word "market" alone does NOT fire, so product-mechanic
// questions ("how does the policy vault market cap work") and specific price
// queries ("what is BTC's market cap") stay on_topic and answer normally.
const MARKET_ANALYSIS_RE =
  /\b(market\s+(overview|summary|snapshot|update|sentiment|regime|state|condition|breadth|outlook|review|strong|weak|bullish|bearish|conflicted|choppy)|today'?s\s+(crypto\s+)?market|market\s+today|how\s+(is|'s|are)\s+(the\s+)?(crypto\s+)?market|crypto\s+market\s+(overview|today|sentiment|update)|overall\s+market|broad\s+market|market\s+look|good\s+day\s+to\s+(trade|take\s+risk|buy|deploy)|should\s+i\s+(trade|buy|deploy|take\s+risk)\s+today|take\s+risks?\s+today|risk\s+(today|appetite|regime|on|off)|risk[-\s]?on\s+(day|market)|is\s+(today|this)\s+a\s+good\s+day)\b/i;
const MARKET_ANALYSIS_RE_VN =
  /(tổng\s+quan\s+(thị\s+trường|crypto)|thị\s+trường\s+(hôm\s+nay|hiện\s+tại|đang\s+(sức\s+)?mạnh|đang\s+yếu|đang\s+mâu\s+thuẫn|đang\s+lên|đang\s+xuống|đang\s+đi\s+xuống|mạnh|mạnh\s+hay\s+yếu|crypto)|tình\s+trạng\s+thị\s+trường|cảm\s+xúc\s+thị\s+trường|đánh\s+giá\s+thị\s+trường|có\s+nên\s+(giao\s+dịch|mua|bán)\s+(hôm\s+nay|bây\s+giờ)|rủi\s+ro\s+(hôm\s+nay|hiện\s+tại|thị\s+trường)|ngày\s+(hôm\s+nay|nay)\s+(có\s+nên|đủ\s+an\s+toàn))/i;

export function classifyCopilotIntent(content: string): CopilotIntent {
  const text = content.trim();
  if (!text) {
    return "on_topic";
  }

  // Order matters: FAQ patterns are specific enough that they win first. The
  // create-agent pattern requires the word "agent", which is also an anchor, so
  // it would otherwise reach the LLM — the deterministic answer just saves tokens.
  if (FAQ_WHO_ARE_YOU_RE.test(text) || FAQ_CREATE_AGENT_RE.test(text) || FAQ_THANKS_RE.test(text)) {
    return "product_faq";
  }

  // Market-overview prompts route to the Router with the decision framework +
  // CMC data (handled in the chat route). Checked before off_topic so a phrase
  // like "good day to trade" (which contains the "trade" anchor and would never
  // be off_topic anyway) is correctly tagged.
  if (MARKET_ANALYSIS_RE.test(text) || MARKET_ANALYSIS_RE_VN.test(text)) {
    return "market_analysis";
  }

  const normalized = text.toLowerCase();
  if (OFF_TOPIC_RE.test(normalized) && !ANCHOR_RE.test(normalized)) {
    return "off_topic";
  }
  return "on_topic";
}

/**
 * Build a deterministic response for an off-topic or product_faq intent. Returns
 * null for `on_topic` so the caller knows to invoke the 0G Compute Router.
 */
export function buildDeterministicCopilotResponse(
  intent: CopilotIntent,
  content: string,
): { content: string; model: string } | null {
  if (intent === "off_topic") {
    return { content: buildOffTopicRefusal(content), model: COPILOT_POLICY_MODEL };
  }
  if (intent === "product_faq") {
    const text = content.trim();
    if (FAQ_CREATE_AGENT_RE.test(text)) {
      return { content: buildCreateAgentAnswer(text), model: COPILOT_POLICY_MODEL };
    }
    if (FAQ_WHO_ARE_YOU_RE.test(text)) {
      return { content: buildWhoAreYouAnswer(text), model: COPILOT_POLICY_MODEL };
    }
    if (FAQ_THANKS_RE.test(text)) {
      return { content: buildThanksAnswer(text), model: COPILOT_POLICY_MODEL };
    }
  }
  return null;
}

function isVietnamese(text: string): boolean {
  return (
    /[à-ỹạ-ựăâđêôơưÀ-ÝẠ-ỰĂÂĐÊÔƠƯ]/i.test(text) ||
    /\b(là|gì|ko|không|nhé|ạ|nào|cách|tạo|viết|làm|được|mình|bạn|hướng dẫn)\b/i.test(text)
  );
}

function buildOffTopicRefusal(content: string): string {
  if (isVietnamese(content)) {
    return [
      "Mình chỉ hỗ trợ các câu hỏi về 0G và sản phẩm 4lpha 0G (Discover, Copilot, Trading Agent, Policy Vault).",
      "Bạn muốn mình giúp phần nào — ví dụ giải thích 0G Compute Router / Storage / Chain, thiết lập Trading Agent, hoặc cơ chế Policy Vault?",
    ].join("\n");
  }
  return [
    "I only help with 0G and the 4lpha 0G product (Discover, Copilot, Trading Agent, Policy Vault).",
    "Which of those can I help with — for example explaining 0G Compute Router / Storage / Chain, setting up a Trading Agent, or how the Policy Vault works?",
  ].join("\n");
}

function buildWhoAreYouAnswer(content: string): string {
  if (isVietnamese(content)) {
    return [
      "Mình là 4lpha 0G Copilot — trợ lý cho sản phẩm 4lpha 0G (demo 0G-native cho 0G Zero Cup).",
      "Mình giải thích được 0G Compute Router, 0G Storage, 0G Chain proof, ERC-7857 Agentic ID, cơ chế Policy Vault (deny-by-default, executor bị giới hạn), và hướng dẫn thiết lập Trading Agent cũng như xem lại bằng chứng audit.",
    ].join("\n");
  }
  return [
    "I'm 4lpha 0G Copilot — the assistant for the 4lpha 0G product (a 0G-native demo for the 0G Zero Cup).",
    "I can explain the 0G Compute Router, 0G Storage, 0G Chain proofs, ERC-7857 Agentic ID, the Policy Vault (deny-by-default, bounded executor), and walk you through Trading Agent setup and audit-evidence review.",
  ].join("\n");
}

function buildCreateAgentAnswer(content: string): string {
  if (isVietnamese(content)) {
    return [
      "Để tạo Trading Agent:",
      "1. Kết nối ví.",
      "2. Mở Fund và nạp 0G vào Policy Vault (chỉ nạp 0G).",
      "3. Mở Agent, chọn Create Agent, rồi tùy chỉnh agent theo ý bạn.",
      "Agent identity được mint trên 0G mainnet theo chuẩn ERC-7857 Agentic ID.",
    ].join("\n");
  }
  return [
    "To create a Trading Agent:",
    "1. Connect your wallet.",
    "2. Open Fund and deposit 0G into your Policy Vault (0G only).",
    "3. Open Agent, choose Create Agent, then customize the agent.",
    "Agent identity is minted on 0G mainnet as a real ERC-7857 Agentic ID.",
  ].join("\n");
}

function buildThanksAnswer(content: string): string {
  if (isVietnamese(content)) {
    return "Rất sẵn lòng hỗ trợ. Mình có thể giải thích thêm một khái niệm 0G hoặc hướng dẫn thiết lập agent / Policy Vault / xem lại trade nhé.";
  }
  return "Happy to help. I can explain another 0G concept or walk through agent setup, Policy Vault controls, or trade review next.";
}