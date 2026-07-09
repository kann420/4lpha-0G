export type TestnetRehearsalKind = "trading" | "lp";

export interface TestnetRehearsalRecord {
  adapter: "mock";
  chainId: 16602;
  createdAt: string;
  detailHref: string;
  id: string;
  identity: "disabled";
  kind: TestnetRehearsalKind;
  name: string;
  networkId: "testnet";
  storage: "disabled";
}

const STORAGE_KEY = "4lpha-0g:testnet-rehearsals";
export const TESTNET_TRADING_REHEARSAL_AGENT_ID = "agent-aura";
export const TESTNET_LP_REHEARSAL_AGENT_ID = "lp-mock-001";

export function readTestnetRehearsals(): TestnetRehearsalRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isTestnetRehearsalRecord) : [];
  } catch {
    return [];
  }
}

export function saveTestnetRehearsalRecord(input: {
  kind: TestnetRehearsalKind;
  name: string;
}): TestnetRehearsalRecord {
  const record = makeTestnetRehearsalRecord(input);
  if (typeof window === "undefined") return record;
  const next = [
    record,
    ...readTestnetRehearsals().filter((item) => item.kind !== input.kind),
  ];
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("4lpha-0g-testnet-rehearsal-change"));
  return record;
}

function makeTestnetRehearsalRecord({
  kind,
  name,
}: {
  kind: TestnetRehearsalKind;
  name: string;
}): TestnetRehearsalRecord {
  const trimmedName = name.trim();
  const id = kind === "lp" ? TESTNET_LP_REHEARSAL_AGENT_ID : TESTNET_TRADING_REHEARSAL_AGENT_ID;
  return {
    adapter: "mock",
    chainId: 16602,
    createdAt: new Date().toISOString(),
    detailHref: kind === "lp" ? `/agents/lp/${id}` : "/agents",
    id,
    identity: "disabled",
    kind,
    name: trimmedName || (kind === "lp" ? "Galileo LP rehearsal" : "Galileo trading rehearsal"),
    networkId: "testnet",
    storage: "disabled",
  };
}

function isTestnetRehearsalRecord(value: unknown): value is TestnetRehearsalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TestnetRehearsalRecord>;
  return (
    (record.kind === "trading" || record.kind === "lp") &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    record.networkId === "testnet" &&
    record.chainId === 16602 &&
    record.adapter === "mock" &&
    record.identity === "disabled" &&
    record.storage === "disabled" &&
    typeof record.createdAt === "string" &&
    typeof record.detailHref === "string"
  );
}
