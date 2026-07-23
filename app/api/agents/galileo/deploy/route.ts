import { NextResponse } from "next/server";
import { z } from "zod";

import { assertGalileoStackIntegrity } from "@/lib/galileo/attestation";
import { assertGalileoRequestBoundary, verifyGalileoConsent } from "@/lib/galileo/consent";
import { resolveGalileoWriteConfig } from "@/lib/galileo/config";
import { claimDeployAndConsume, GalileoLedgerError, markGalileoDeployment, persistVerifiedGalileoAgent } from "@/lib/galileo/ledger";
import { buildGalileoAgentMetadata } from "@/lib/galileo/metadata";
import { downloadAndVerifyGalileoBytes, uploadGalileoBytes } from "@/lib/galileo/storage";

export const runtime = "nodejs";
const wallet = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/u), chainId: z.literal(16602), message: z.string().min(1).max(2_000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/u).max(200) });
const schema = z.object({ chainId: z.literal(16602), clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,96}$/u), networkId: z.literal("testnet"), nonce: z.string().regex(/^[0-9a-fA-F]{64}$/u), prepareId: z.string().uuid(), wallet });

export async function POST(request: Request) {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) return error("invalid_request", "Galileo deploy request was not valid.", 400);
  try {
    assertGalileoRequestBoundary(request, parsed.data);
    const consent = await verifyGalileoConsent({ action: "deploy", nonce: parsed.data.nonce, prepareId: parsed.data.prepareId, wallet: parsed.data.wallet });
    if (consent.config?.clientRequestId !== parsed.data.clientRequestId) return error("idempotency_conflict", "clientRequestId does not match the signed Galileo deployment consent.", 409);
    const claim = claimDeployAndConsume({ nonce: parsed.data.nonce, owner: consent.owner, prepareId: parsed.data.prepareId });
    if (claim.replay) {
      if (claim.deployment.state === "verified") return NextResponse.json({ data: { status: "already_verified" }, meta: { chainId: 16602, networkId: "testnet" } }, { headers: { "Cache-Control": "no-store" } });
      return error("deployment_in_progress", "This Galileo deployment request is already being processed.", 409);
    }
    const config = resolveGalileoWriteConfig();
    await assertGalileoStackIntegrity(config, claim.prepare.config!.vault);
    const metadata = buildGalileoAgentMetadata({
      agentKey: claim.prepare.agentKey!, agentRef: claim.prepare.agentRef!, authorizationDigest: claim.prepare.configDigest!, configurationDigest: claim.prepare.configDigest!, createdAt: new Date().toISOString(), filters: claim.prepare.config!.filters, name: claim.prepare.config!.name, owner: claim.prepare.owner, runtime: claim.prepare.config!.runtime, vault: claim.prepare.config!.vault!, adapter: config.addresses.adapter, executor: config.signers.executor.address, proofRegistry: config.addresses.proofRegistry,
    });
    const upload = await uploadGalileoBytes(metadata.bytes, config);
    if (!await downloadAndVerifyGalileoBytes(upload.storageRef, metadata.bytes, config)) throw new Error("Galileo Storage bytes did not verify.");
    persistVerifiedGalileoAgent({ agentKey: claim.prepare.agentKey!, agentRef: claim.prepare.agentRef!, chainId: 16602, createdAt: new Date().toISOString(), owner: claim.prepare.owner, storageRef: upload.storageRef, storageRoot: upload.rootHash, storageVerified: true, vault: claim.prepare.config!.vault!, adapter: config.addresses.adapter, executor: config.signers.executor.address, proofRegistry: config.addresses.proofRegistry, modelMetadata: { algorithm: "sha256", digest: metadata.digest, provider: "4lpha-galileo-canonical-v1" }, storageTxHash: upload.txHash, storageTxSeq: upload.txSeq });
    markGalileoDeployment({ clientRequestId: parsed.data.clientRequestId, owner: claim.prepare.owner, state: "verified" });
    return NextResponse.json({ data: { agentKey: claim.prepare.agentKey, agentRef: claim.prepare.agentRef, storageRef: upload.storageRef, storageRoot: upload.rootHash, storageVerified: true }, meta: { chainId: 16602, networkId: "testnet" } }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof GalileoLedgerError) return error(cause.code, cause.message, cause.status);
    // If a claim exists we deliberately preserve a blocked checkpoint, but
    // never return provider/configuration detail to the browser.
    return error("galileo_deploy_unavailable", "Galileo deployment could not complete; no unverified agent record was created.", 503);
  }
}
async function readJson(request: Request): Promise<unknown> { try { return await request.json(); } catch { return undefined; } }
function error(code: string, message: string, status: number) { return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } }); }
