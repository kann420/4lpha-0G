"use client";

import { AppShell } from "@/components/app/AppShell";
import { EmbeddedCopilotRail } from "@/components/app/EmbeddedCopilotRail";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import type { EmbeddedCopilotMessage } from "@/components/app/EmbeddedCopilotRail";

const CHAT_INITIAL_MESSAGES: EmbeddedCopilotMessage[] = [];

export function ChatSurface() {
  const { network, networkId, setNetworkId } = useOgNetwork();

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 overflow-hidden px-3 py-4 lg:px-8">
        <div className="mx-auto h-full min-h-0 w-full max-w-7xl">
          <section className="h-full min-h-0">
            <EmbeddedCopilotRail
              description="Chat with 4lpha Copilot through the selected 0G Compute Router network."
              initialMessages={CHAT_INITIAL_MESSAGES}
              networkId={networkId}
              networkLabel={network.label}
              placeholder="Ask about vault policy, storage evidence, proof anchoring, or an agent run..."
            />
          </section>
        </div>
      </main>
    </AppShell>
  );
}
