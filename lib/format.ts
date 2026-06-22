export function shortHash(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 3) {
    return value;
  }

  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function statusTone(status: "verified" | "pending" | "mock"): string {
  switch (status) {
    case "verified":
      return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
    case "pending":
      return "border-amber-300/20 bg-amber-300/10 text-amber-100";
    default:
      return "border-cyan-300/20 bg-cyan-300/10 text-cyan-100";
  }
}
