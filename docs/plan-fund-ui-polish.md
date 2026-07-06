# Plan — /fund UI polish (4lpha vibe, no rebuild)

> Status: awaiting Codex adversarial audit (`/codex:adversarial-review`, gpt-5.5 xhigh) before execution.
> Scope confirmed with user: "Visual + small UX". No data-flow / hook / contract / API changes.

## Context

`/fund` (`app/fund/page.tsx` → `components/surfaces/VaultSurface.tsx`, 891 lines) + right rail
`components/app/VaultActionPanel.tsx` (698 lines) already uses the 4lpha design language (semantic
tokens, `bg-panel-solid-strong` hero, eyebrow labels, `font-mono tabular-nums` numerics). But it has
drifted from the rest of the app: 6 different arbitrary radii, 8+ ad-hoc amber alpha stops, repeated
non-tokenized heavy shadows, two button heights, two stat-tile recipes that look unlike each other,
and several rough UX spots (truncated errors with no tooltip, no per-field input validation, "--" as
the only loading cue, full hex address `break-all` on narrow widths).

Goal: visual polish + small UX improvements that make /fund feel as cohesive and operational as
`/agents` and `/discover`, **without** changing data flow, contracts, hooks, or adding new features.
Keep the dense dark operational 4lpha vibe.

## Files modified

- `app/globals.css` — add 3 radius tokens + 1 hero-shadow token (dark + light).
- `components/surfaces/VaultSurface.tsx` — tile-recipe unify, radius/shadow/alpha consolidation, address display, entrance animation.
- `components/app/VaultActionPanel.tsx` — input validation states, status tooltip, "All" button spacing, loading shimmer, radius/alpha/button-height consolidation.

No changes to: `useWalletPolicyVault.ts`, `useOgNetwork.ts`, `lib/contracts/*`, `AppShell.tsx`,
route files, contract ABIs, or any data/API path. No new dependencies.

## Changes

### 1. Token additions in `app/globals.css`

In `@theme inline`, add radius keys (Tailwind v4 turns `--radius-*` into `rounded-*` utilities):
```
--radius-tile: 0.875rem;   /* 14px  → small rows, pills */
--radius-card: 1.25rem;    /* 20px  → cards, tiles */
--radius-hero: 1.5rem;     /* 24px  → hero / panels (lg: 30px stays arbitrary on hero only) */
```
Add a hero shadow token in the dark `:root` block and the `:root.light` block (light gets a softer,
lighter drop):
```
/* dark */  --shadow-hero: 0 28px 100px rgba(0, 0, 0, 0.24);
/* light */ --shadow-hero: 0 18px 60px rgba(80, 70, 120, 0.18);
```
Wire it into `@theme inline` mirroring `--shadow-panel`. Use via `shadow-[var(--shadow-hero)]` or the
generated `shadow-hero` utility (confirm exact Tailwind v4 wiring during impl).

### 2. Stat-tile recipe unify (`VaultSurface.tsx`)

Merge `HeaderMetric` (lines 190–210) and `FundBalanceTile` (239–269) into one local component
`StatTile({ icon, label, value, detail?, tone })` with `tone: "amber" | "emerald" | "teal" | "white"`.
Shared: `rounded-card border border-line bg-panel px-4 py-3`, label
`text-[10px] uppercase tracking-[0.22em] text-muted`, value
`mt-2 font-mono text-lg font-semibold tabular-nums` (tone-colored), optional `detail` muted line.
Makes the hero's 3 metrics and the 2 balance tiles read as one family (today they differ in bg,
radius, value font, and tone mapping). Keep both sections where they are — no layout change.

### 3. Radius / shadow / alpha consolidation (both files)

- Radii → use the 3 tokens: tiles/rows `rounded-tile`, cards/tiles `rounded-card`, hero/panels
  `rounded-hero` (hero keeps `lg:rounded-[30px]`). Replace `rounded-[14px]/[16px]/[18px]/[20px]/[24px]`
  occurrences in both files with the nearest token.
- Shadows → replace `shadow-[0_28px_100px_rgba(0,0,0,0.24)]` (FundRouteHeader) and
  `shadow-[0_24px_80px_rgba(0,0,0,0.22)]` (FundManualDepositPanel) with the `--shadow-hero` token.
  Leave the auto-applied `--shadow-section` (globals.css already applies it to bordered sections) for
  the rest.
- Amber alpha → collapse to 3 stops: soft fill `bg-amber/[0.06]`, medium fill `bg-amber/[0.1]`,
  border `border-amber/20`. Replace scattered `/[0.07] /[0.08] /[0.16] /18 /24 /35 /14` with the
  nearest of these. Same for `rose`/`green`/`primary` where they drift (`bg-rose/12`, `bg-amber/12`,
  `bg-amber/15` → `bg-rose/[0.1]`, `bg-amber/[0.1]`).

### 4. Button consistency (both files)

- One height: action buttons + inputs stay `h-11`; change the `h-10` buttons in `VaultSurface`
  (Refresh, Create Wallet Vault, Copy) to `h-11`.
- One primary-CTA recipe: solid `bg-amber text-background` for the page's main action. The
  "Create Wallet Vault" button stays a ghost amber outline but unify its alpha to the 3-stop set
  (→ `border-amber/20 bg-amber/[0.1] text-amber`, hover `bg-amber/[0.16]`).

### 5. Action-panel UX (`VaultActionPanel.tsx`)

- **Status tooltip**: add `title={statusText}` to the truncated `<p>` in `VaultRailStatus` (line 467)
  so long errors survive truncation.
- **Inline input validation**: compute `depositValid` / `withdrawValid` with the existing
  `parsePositiveAmount` regex (`/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/`). When invalid (non-empty & not
  matching), set input border to `border-rose/40` and show a 1-line rose helper under the input.
  Keep `runOwnerAction` as the final authority; pre-flight UI only. No new throws.
- **"All" button spacing**: move the `All` chip to `ml-auto` inside the input shell with `px-2.5
  py-1` and `gap-2` so it isn't squeezed against the suffix.
- **Balance loading shimmer**: while `refreshVault` is in flight (track a `refreshing` boolean),
  show a subtle pulsing skeleton (`animate-pulse` on a `h-4 w-20 rounded-full bg-panel-strong`) in the
  Balance `RailStatus` row instead of `"--"`. Keep `"--"` only when no vault address.

### 6. Vault address display (`VaultSurface.tsx`, manual-deposit "Policy Vault address" sub-card)

Replace the `break-all font-mono text-sm` full-hex block (line 495) with a 2-line layout:
`shortAddress(vaultAddress)` prominent (`font-mono text-base text-amber`) + the full address in a
`truncate font-mono text-[11px] text-amber/70` line with `title={vaultAddress}`. Keep the existing
`copyVaultAddress` Copy button. Inline the 6-char/4-char slice in `VaultSurface.tsx` (do not add a
new import dependency).

### 7. Entrance animation (`VaultSurface.tsx`)

Wrap the 4 left-column sections + the action rail with `animate-feed-reveal` (already defined in
`globals.css`) and staggered `style={{ animationDelay }}` (60ms steps), matching the entrance feel on
`/agents`. `prefers-reduced-motion` is already handled globally in `globals.css`.

## Reused existing pieces

- `--shadow-panel / --shadow-section` tokens, `animate-feed-reveal` keyframe, `--radius` token pattern
  — all in `app/globals.css`.
- `shortAddress` / `shortHash` helpers — `VaultActionPanel.tsx` / `lib/format.ts`.
- `parsePositiveAmount` regex — reuse for inline validation (`VaultActionPanel.tsx` line 670).
- Tone recipe `border-X/20 bg-X/10 text-X` — matches `TONE_CLASS` in `DiscoverSurface.tsx` and
  `statusTone` in `lib/format.ts`.

## Out of scope (noted, not done)

- Consolidating the two balance sources (wagmi `useBalance` in `VaultSurface` vs viem `getBalance`
  in `VaultActionPanel`) — behavior change.
- Surfacing new "redacted evidence" (storage root, audit verification state) per AGENTS.md — needs
  data plumbing, not visual polish.
- `ZeroGNetworkSwitch` hardcoded to mainnet — separate issue.
- Any contract / hook / API change.

## Verification

1. `npx tsc --noEmit` — no new type errors.
2. `npm run build` — production build clean.
3. Browser (desktop + mobile width 375px):
   - `/fund` renders, hero + balance tiles + manual deposit + action rail all visible.
   - Toggle dark/light (header) — tokens resolve in both; hero shadow + amber fills look right.
   - Tiles (hero metrics + balances) look like one family.
   - Deposit/withdraw: type invalid (`abc`, `0.0`) → rose border + helper; type valid → normal;
     action still executes.
   - "All" chip fills withdraw from vault balance.
   - Vault address shown as short + full truncate with tooltip; Copy works.
   - Refresh shows shimmer in Balance row, then value.
   - Entrance animation plays once; reduced-motion kills it.

## Audit checklist for Codex (gpt-5.5 xhigh)

Challenge this plan on:
1. **Correctness risk** — does any change alter on-chain behavior, signing flow, or the
   `runOwnerAction` / `parsePositiveAmount` contract? (Should be none.)
2. **Token wiring** — will the `--radius-*` / `--shadow-hero` additions actually generate working
   `rounded-*` / `shadow-*` utilities in this Tailwind v4 `@theme inline` setup? Any naming clash
   with existing `--radius`?
3. **Inline validation regression** — can the pre-flight `depositValid`/`withdrawValid` gate prevent a
   legitimate action, or disagree with `parsePositiveAmount`'s real check?
4. **Reduced-motion / a11y** — does adding `animate-feed-reveal` + `animationDelay` inline styles
   break the global `prefers-reduced-motion` kill switch?
5. **Mobile 375px** — does any consolidation (radius tokens, button heights, "All" chip) make the
   action rail worse on narrow widths?
6. **Scope creep** — does any item quietly change data flow / hooks / contracts / API? Flag any.
7. **4lpha vibe** — does unifying the tile recipe risk flattening the intentional visual hierarchy
   (hero metrics vs balance tiles)?