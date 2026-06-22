import { OgAgentDetailPage } from "@/components/agents/OgAgentDetailPage";

export default async function AgentDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OgAgentDetailPage agentId={id} />;
}
