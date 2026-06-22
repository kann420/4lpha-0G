import type { EvidenceStatus } from "@/lib/types";
import { statusTone } from "@/lib/format";

const LABELS: Record<EvidenceStatus, string> = {
  mock: "Mock-labeled",
  pending: "Pending verify",
  verified: "Verified",
};

export function StatusBadge({ status }: { status: EvidenceStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(status)}`}>
      {LABELS[status]}
    </span>
  );
}
