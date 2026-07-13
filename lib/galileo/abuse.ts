import "server-only";

import { isAddress, type Address } from "viem";

import { GalileoLedgerError, recordGalileoRateHit, type GalileoLedgerOptions } from "@/lib/galileo/ledger";

/** Server-controlled canary + bounded relay budget, checked before any key or Storage work.
 *  The 5/wallet · 20/ip · 50/global-per-minute budget is enforced by a durable, cross-process
 *  sliding-window store (not per-process memory), so a horizontally-scaled deploy shares it. */
export function assertGalileoExecutionQuota(request: Request, owner: Address, env: Readonly<Record<string, string | undefined>> = process.env, options?: GalileoLedgerOptions): void {
  const enrolled = (env.GALILEO_CANARY_OWNERS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter((value) => isAddress(value as `0x${string}`, { strict: true }));
  if (!enrolled.includes(owner.toLowerCase())) throw new GalileoLedgerError("canary_required", "Galileo execution is limited to enrolled canary wallets.", 403);
  if (env.GALILEO_TRUSTED_PROXY !== "true") throw new GalileoLedgerError("proxy_unconfigured", "Galileo execution relay is unavailable.", 503);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip || ip.length > 64) throw new GalileoLedgerError("ip_unavailable", "Galileo execution relay is unavailable.", 503);
  const result = recordGalileoRateHit({ owner, ip }, options);
  if (!result.allowed) throw new GalileoLedgerError("rate_limited", "Galileo execution is rate limited.", 429);
}
