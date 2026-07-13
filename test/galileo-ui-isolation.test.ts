import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Galileo UI isolation", () => {
  it("delegates testnet rendering before the existing mainnet panel body", () => {
    const source = read("components/app/AgentRouteTradePanel.tsx");
    const delegate = source.indexOf('if (networkId === "testnet")');
    const mainnetBody = source.indexOf("function AgentRouteTradePanelBody");
    assert.ok(delegate >= 0, "testnet must have an explicit delegate");
    assert.ok(mainnetBody > delegate, "the mainnet panel body must remain behind the testnet delegate");
    assert.match(source, /return <GalileoTradePanel networkLabel=\{networkLabel\} onPreviewChange=\{onPreviewChange\} \/>;/u);
  });

  it("keeps Galileo trade UI and its route descriptor free of mainnet catalog imports", () => {
    const panel = read("components/app/GalileoTradePanel.tsx");
    const route = read("lib/galileo/trade-route.ts");
    assert.doesNotMatch(panel, /from\s+"@\/lib\/(?:agent\/trade-catalog|contracts\/curated-routes|contracts\/policy-vault)"/u);
    assert.doesNotMatch(route, /from\s+"@\/lib\/(?:agent\/single-agent|contracts\/curated-routes|contracts\/policy-vault)"/u);
  });

  it("selects the redacted Galileo roster before importing a mainnet resolver", () => {
    const route = read("app/api/agents/route.ts");
    const testnetBranch = route.indexOf('if (networkId === "testnet")');
    const mainnetImport = route.indexOf('import("@/lib/agent/mainnet-vault-resolver")');
    assert.ok(testnetBranch >= 0 && mainnetImport > testnetBranch);
    assert.match(route, /Cache-Control": "no-store"/u);
  });
});
