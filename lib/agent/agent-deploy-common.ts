import { encodeAbiParameters, keccak256, type Hex } from "viem";

import type { OgAgentDeploymentRecord } from "@/lib/agent/single-agent";

export class OgAgentDeployError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function agentKeyForDeployment(deployment: Pick<OgAgentDeploymentRecord, "identityAddress" | "tokenId">): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "identityAddress", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
      [deployment.identityAddress, BigInt(deployment.tokenId)],
    ),
  );
}
