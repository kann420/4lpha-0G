"use client";

import Link from "next/link";
import { Activity, ArrowRight, Bot, Droplets, Shield, Zap } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { ZiaPoweredBadge } from "@/components/agents/lp/ZiaPoweredBadge";

export function OgAgentCreateChoice() {
  const { network, networkId, setNetworkId } = useOgNetwork();

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 overflow-y-auto px-4 py-5 lg:px-8 lg:py-7">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <section className="rounded-2xl border border-line bg-panel-solid-strong/92 px-5 py-5 shadow-[0_22px_70px_rgba(0,0,0,0.24)] lg:px-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl space-y-2.5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Agent create</p>
                <h1 className="text-3xl font-semibold tracking-tight text-foreground lg:text-4xl">Choose agent type</h1>
                <p className="max-w-2xl text-sm leading-6 text-muted">
                  Configure a 0G mainnet agent. Deploy a Trading Agent for buy/sell routes, or an LP Agent for single-sided 0G → Zia Uniswap v3 LP. Each deploy mints a separate Agentic ID record.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs sm:flex sm:flex-wrap sm:justify-end">
                {["0G mainnet", "Policy Vault", "Agentic ID", "Owner reviewed"].map((item) => (
                  <span key={item} className="rounded-lg border border-line bg-panel px-3 py-2 text-center font-semibold text-muted">
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <article className="flex min-h-[23rem] flex-col rounded-2xl border border-line bg-panel-solid-strong/92 p-5 shadow-[0_18px_58px_rgba(0,0,0,0.22)] transition-colors duration-200 hover:border-line-strong">
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/12 text-primary">
                  <Bot className="h-5 w-5" />
                </div>
                <span className="rounded-lg border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-muted">
                  Trading desk
                </span>
              </div>

              <div className="mt-5 space-y-2.5">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">Trading Agent</h2>
                <p className="max-w-xl text-sm leading-6 text-muted">
                  Mainnet route filters, Policy Vault execution, and Agentic ID mint in one deployment flow.
                </p>
              </div>

              <div className="mt-6 divide-y divide-line border-y border-line">
                {[
                  { icon: Activity, label: "Route", value: "0G / ZIA / Oku" },
                  { icon: Shield, label: "Control", value: "Vault policy" },
                  { icon: Zap, label: "Mode", value: "Single-agent runtime" },
                ].map((metric) => (
                  <div key={metric.label} className="grid grid-cols-[1.25rem_minmax(6rem,0.7fr)_minmax(0,1fr)] items-center gap-3 py-3">
                    <metric.icon className="h-4 w-4 text-muted" />
                    <span className="text-xs font-medium text-muted">{metric.label}</span>
                    <span className="min-w-0 text-right text-sm font-semibold text-foreground">{metric.value}</span>
                  </div>
                ))}
              </div>

              <div className="mt-5 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Network</p>
                <div className="inline-flex w-full rounded-full border border-line bg-panel-solid-strong p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:w-fit">
                  <span className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-invert px-4 text-sm font-semibold text-invert-ink shadow-[0_10px_24px_rgba(0,0,0,0.28)] sm:flex-none">
                    0G Mainnet
                  </span>
                </div>
              </div>

              <Link href="/agents/create/trading" className="mt-auto inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96]">
                <span>Open setup</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </article>

            <article className="flex min-h-[23rem] flex-col rounded-2xl border border-line bg-panel-solid-strong/92 p-5 shadow-[0_18px_58px_rgba(0,0,0,0.22)] transition-colors duration-200 hover:border-line-strong">
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/12 text-primary">
                  <Droplets className="h-5 w-5" />
                </div>
                <ZiaPoweredBadge />
              </div>

              <div className="mt-5 space-y-2.5">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">LP Agents</h2>
                <p className="max-w-xl text-sm leading-6 text-muted">
                  Single-sided 0G → Zia Uniswap v3 LP through the Policy Vault. APR filter, pool picker, and automation controls (coming soon).
                </p>
              </div>

              <div className="mt-6 divide-y divide-line border-y border-line">
                {[
                  { icon: Droplets, label: "Pool", value: "W0G-leg Zia v3" },
                  { icon: Shield, label: "Range", value: "Full / narrow" },
                  { icon: Zap, label: "Mode", value: "Single-sided zap" },
                ].map((metric) => (
                  <div key={metric.label} className="grid grid-cols-[1.25rem_minmax(6rem,0.7fr)_minmax(0,1fr)] items-center gap-3 py-3">
                    <metric.icon className="h-4 w-4 text-muted" />
                    <span className="text-xs font-medium text-muted">{metric.label}</span>
                    <span className="min-w-0 text-right text-sm font-semibold text-foreground">{metric.value}</span>
                  </div>
                ))}
              </div>

              <div className="mt-5 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Network</p>
                <div className="inline-flex w-full rounded-full border border-line bg-panel-solid-strong p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:w-fit">
                  <span className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-invert px-4 text-sm font-semibold text-invert-ink shadow-[0_10px_24px_rgba(0,0,0,0.28)] sm:flex-none">
                    0G Mainnet
                  </span>
                </div>
              </div>

              <Link href="/agents/create/lp" className="mt-auto inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96]">
                <span>Open setup</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </article>
          </section>
        </div>
      </main>
    </AppShell>
  );
}
