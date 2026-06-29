export function shortHash(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 3) {
    return value;
  }

  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function statusTone(status: "verified" | "pending" | "mock"): string {
  switch (status) {
    case "verified":
      return "border-green/20 bg-green/10 text-green";
    case "pending":
      return "border-amber/20 bg-amber/10 text-amber";
    default:
      return "border-primary/20 bg-primary/10 text-primary";
  }
}
