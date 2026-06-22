"use client";

import Link from "next/link";
import { Activity, ArrowRight, Bot, Lock, Settings2, Shield, Zap } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { useOgNetwork } from "@/components/app/useOgNetwork";

export function OgAgentCreateChoice() {
  const { network, networkId, setNetworkId } = useOgNetwork();

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 overflow-y-auto px-4 py-5 lg:px-8 lg:py-7">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <section className="rounded-2xl border border-white/8 bg-[#101720]/92 px-5 py-5 shadow-[0_22px_70px_rgba(0,0,0,0.24)] lg:px-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl space-y-2.5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Agent create</p>
                <h1 className="text-3xl font-semibold tracking-tight text-white lg:text-4xl">Choose agent type</h1>
                <p className="max-w-2xl text-sm leading-6 text-slate-400">
                  Configure a 0G mainnet trading agent. Each deploy mints a separate Agentic ID record; multi-role desks stay locked for the next phase.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs sm:flex sm:flex-wrap sm:justify-end">
                {["0G mainnet", "Policy Vault", "Agentic ID", "Owner reviewed"].map((item) => (
                  <span key={item} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-center font-semibold text-slate-300">
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <article className="flex min-h-[23rem] flex-col rounded-2xl border border-white/8 bg-[#101720]/92 p-5 shadow-[0_18px_58px_rgba(0,0,0,0.22)] transition-colors duration-200 hover:border-white/14">
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-200/10 bg-cyan-300/12 text-[var(--pulse-teal)]">
                  <Bot className="h-5 w-5" />
                </div>
                <span className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-400">
                  Trading desk
                </span>
              </div>

              <div className="mt-5 space-y-2.5">
                <h2 className="text-2xl font-semibold tracking-tight text-white">Trading Agent</h2>
                <p className="max-w-xl text-sm leading-6 text-slate-400">
                  Mainnet route filters, Policy Vault execution, and Agentic ID mint in one deployment flow.
                </p>
              </div>

              <div className="mt-6 divide-y divide-white/8 border-y border-white/8">
                {[
                  { icon: Activity, label: "Route", value: "0G / ZIA / Oku" },
                  { icon: Shield, label: "Control", value: "Vault policy" },
                  { icon: Zap, label: "Mode", value: "Single-agent runtime" },
                ].map((metric) => (
                  <div key={metric.label} className="grid grid-cols-[1.25rem_minmax(6rem,0.7fr)_minmax(0,1fr)] items-center gap-3 py-3">
                    <metric.icon className="h-4 w-4 text-slate-500" />
                    <span className="text-xs font-medium text-slate-500">{metric.label}</span>
                    <span className="min-w-0 text-right text-sm font-semibold text-slate-100">{metric.value}</span>
                  </div>
                ))}
              </div>

              <div className="mt-5 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Network</p>
                <div className="inline-flex w-full rounded-full border border-white/10 bg-[#080d12] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:w-fit">
                  <span className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-slate-50 px-4 text-sm font-semibold text-[#071015] shadow-[0_10px_24px_rgba(0,0,0,0.28)] sm:flex-none">
                    0G Mainnet
                  </span>
                </div>
              </div>

              <Link href="/agents/create/trading" className="mt-auto inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--pulse-teal)] px-4 text-sm font-semibold text-[#041015] transition-[filter,transform] hover:brightness-105 active:scale-[0.96]">
                <span>Open setup</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </article>

            <article className="flex min-h-[23rem] flex-col rounded-2xl border border-white/8 bg-[#101720]/70 p-5 opacity-75 shadow-[0_18px_58px_rgba(0,0,0,0.18)]">
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-300">
                  <Settings2 className="h-5 w-5" />
                </div>
                <span className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-400">
                  Coming soon
                </span>
              </div>
              <div className="mt-5 space-y-2.5">
                <h2 className="text-2xl font-semibold tracking-tight text-white">Multi-Agent Desk</h2>
                <p className="max-w-xl text-sm leading-6 text-slate-400">
                  Specialist safety, social, and gatekeeper roles will be added after the single-agent runtime is verified.
                </p>
              </div>
              <div className="mt-6 rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm text-slate-400">
                <Lock className="mb-2 h-4 w-4" />
                Locked for this build.
              </div>
            </article>
          </section>
        </div>
      </main>
    </AppShell>
  );
}
