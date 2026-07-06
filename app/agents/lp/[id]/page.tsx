import { LpAgentDetailPage } from "@/components/agents/lp/LpAgentDetailPage";

// Next 16 dynamic route — params is a Promise. Mirrors app/agents/[id]/page.tsx.
export default async function LpAgentDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LpAgentDetailPage agentId={id} />;
}