# Plan — LP Agent Detail UI polish (de-rainbow + token cohesion)

## Context & goal

`/agents/lp/[id]` (`components/agents/lp/LpAgentDetailPage.tsx` + 6 panel components) renders the LP
agent detail/management page. It already uses 0G semantic tokens, but it has drifted color-loud and
inconsistent versus the rest of the app (especially the just-polished `/fund`):

- 7 different radii: `rounded-[22px]`, `rounded-[28px]`, `rounded-xl`, `rounded-lg`, `rounded-2xl`,
  `rounded-full`. `/fund` now uses 3 tokens: `rounded-tile` / `rounded-card` / `rounded-hero`.
- Panel backgrounds mix `bg-panel-solid-strong/80`, `/92`, `/94`, plain `bg-panel-solid-strong`,
  and `bg-panel`. `/fund` consolidates to `bg-panel-solid-strong` (outer) + `bg-panel` (inner rows).
- Action buttons over-saturated: header Pause `border-amber/40 bg-amber/10`, Remove
  `border-rose/40 bg-rose/10`. `/fund` uses the calmer `border-X/20 bg-X/[0.1] hover:bg-X/[0.16]`.
- **Rainbow panels (the "màu mè quá mức" the user flagged):**
  - `LpPolicyControls` log-filter pills paint 3 saturated colors at once (emerald / amber / slate).
  - `AutomationModuleCard` icon tiles use blue + green + rose; blue is redundant with `primary`.
  - `LpPositionCard` 5-cell strip can show green + amber + rose simultaneously.
- No entrance animation; `/fund` and `/agents` use staggered `animate-feed-reveal`.
- Mixed button heights: `h-8` (AutoMint) vs `h-9` (most).

Goal: **visual polish + de-rainbow only**, make the LP detail feel as cohesive and restrained as
`/fund`. **No rebuild.** Keep the dense dark operational 4lpha vibe. Keep semantic color ONLY where
it carries data meaning (PnL sign, fee earned, live indicator, active state). Drop decorative color.

Flow: this plan → Codex `task gpt-5.5 xhigh` audit → Codex `task --write` execute → Claude
`code-review` + `security-review` + `tsc`/`build` audit.

> **Revision after Codex xhigh audit (verdict: no-ship → fixed):**
> 1. `AutomationModuleCard.tone` prop type stays `"blue" | "green" | "rose"` — do NOT change the
>    type or `TABS`. Only remap the `TONE_ICON["blue"]` VALUE to the primary palette. Zero
>    call-site / type churn. (This card is shared with `LpAgentCreateWorkspace` — out of scope for
>    edits, but the de-rainbow is a pure visual improvement that applies to both contexts. Visual
>    QA must cover the create flow too.)
> 2. No wrapper `<div>`s around grid children. Apply `animate-feed-reveal` to the grid container
>    itself (single entrance, no per-column stagger) to avoid disrupting `grid-cols-[...]` stretch.
> 3. Every change below is a **substring swap** — replace ONLY the radius token / bg token / alpha
>    stop named. PRESERVE all layout, sizing, overflow, scroll, flex, and grid classes on the same
>    element (e.g. `flex max-h-[min(32rem,calc(100vh-260px))] min-h-[14rem] flex-col`,
>    `min-h-0 flex-1 overflow-y-auto`, `grid overflow-hidden md:grid-cols-3`).
> 4. `LpAutoMintToggle`: preserve the existing condition and labels (`autoMint` true → rose
>    "Turn off"; false → primary "Turn on"). Only soften border `/40`→`/20`, fill `/10`→`/[0.1]`,
>    hover → `/[0.16]`. Do NOT relabel or invert.
> 5. `LogFilterButton`: only the ACTIVE pill is colored today (inactive are plain), so the
>    "rainbow" is milder than first described. De-rainbow = neutralize the active pill FILL, but
>    KEEP reject=amber / execute=green meaning on the small count badge (data-bearing).

## Files in scope (detail page only)

- `components/agents/lp/LpAgentDetailPage.tsx`
- `components/agents/lp/LpAgentSidebar.tsx`
- `components/agents/lp/LpPositionsWorkspace.tsx`
- `components/agents/lp/LpPositionCard.tsx`
- `components/agents/lp/LpPolicyControls.tsx`
- `components/agents/lp/AutomationModuleCard.tsx`
- `components/agents/lp/LpAutoMintToggle.tsx`

## Out of scope (do NOT touch)

- `LpAgentCreateWorkspace.tsx`, `LpManualMintDialog.tsx`, `LpWithdrawNativeDialog.tsx`,
  `LpRangePreview.tsx` — create flow / dialogs, not the detail page.
- `LpStatusPill.tsx`, `ZiaPoweredBadge.tsx` — shared, already restrained. Keep as-is.
- Any data flow, hook, API route, contract, ABI, `lib/agent/*`, `lib/contracts/*`, `useLpActionRequest`.
- No new dependencies. No new CSS tokens (reuse the 3 radius tokens + `--shadow-hero` already in
  `app/globals.css` from the `/fund` work).

## Guardrails (AGENTS.md compliance — Codex MUST honor)

- **No data-flow / contract / hook / API changes.** This is a className-only polish. Do not touch
  `useState`, `useEffect`, `fetch`, `useLpActionRequest`, `buildCopilotActionConsentMessage`,
  `requestActionConsentNonce`, `signMessage`, or any handler logic.
- **No legacy deps.** Do not import or reference ZeroDev, Kernel, BNB, BSC, Mantle, X Layer,
  Pancake, Four.Meme, OKX, GMGN, Birdeye, `PRIVATE_KEY`/`GMGN_PRIVATE_KEY`/`EXECUTOR_PRIVATE_KEY`.
- **No secrets.** Do not hardcode keys, RPC URLs, wallet material. Do not add `NEXT_PUBLIC_*`.
- **0G constants stay.** Do not change chain IDs, RPC, or explorer URLs.
- **Mainnet-only Agentic ID.** Do not touch the identity display semantics or wire a mock verifier.
- **Label mock/demo/test-only clearly.** Do not remove the existing "MOCK" / "coming soon" labels
  on the range preview, reward-claim button, or automation tabs.
- **English only** for code, comments, strings.
- **Match existing patterns.** Use the exact token recipe from `/fund` (below). Do not invent new
  alpha stops, radii, or shadows.

## Token recipe (reuse from `/fund` — do not redefine)

`app/globals.css` already defines (do NOT edit globals.css):
- `--radius-tile: 0.875rem` → `rounded-tile` (small rows, pills, inner cells)
- `--radius-card: 1.25rem` → `rounded-card` (cards, tiles, inner panels)
- `--radius-hero: 1.5rem` → `rounded-hero` (top hero; `lg:rounded-[30px]` stays arbitrary on hero only)
- `--shadow-hero` token (dark + light variants)

Alpha stops (match `/fund` exactly):
- soft fill: `bg-X/[0.06]`
- medium fill: `bg-X/[0.1]`
- hover: `hover:bg-X/[0.16]`
- border: `border-X/20`

Outer panel recipe: `rounded-card border border-line bg-panel-solid-strong p-4` (drop the `/80` `/92`
opacity — use solid). Hero/top band: `rounded-hero ... lg:rounded-[30px]` + inline
`style={{ boxShadow: "var(--shadow-hero)" }}` (inline wins over the global `:where(section)[class*="border"]`
rule — proven in `/fund`).

Inner row/cell recipe: `rounded-tile border border-line bg-panel px-3 py-2`.

Entrance animation: wrap top-level sections with `className="animate-feed-reveal ..."` + inline
`style={{ animationDelay: "Nms" }}` (0 / 60 / 120 / 180 ms). `globals.css` already clears animation
under `prefers-reduced-motion` (delay + fill-mode + duration), so no extra motion-safe guard needed.

## Changes per file (exact class swaps)

### 1. `LpAgentDetailPage.tsx`

- **Header band (line 178):**
  - `rounded-[28px] border border-line bg-panel-solid-strong/92 px-5 py-5 shadow-[var(--shadow-panel)] lg:px-6`
    → `rounded-hero border border-line bg-panel-solid-strong px-5 py-5 lg:px-6`, and add inline
    `style={{ boxShadow: "var(--shadow-hero)", animationDelay: "0ms" }}`, add `animate-feed-reveal`
    to the className.
- **Pause button (line 193):**
  - `rounded-xl border border-amber/40 bg-amber/10 ... hover:border-amber/70 active:scale-[0.96]`
    → `rounded-tile border border-amber/20 bg-amber/[0.1] ... hover:bg-amber/[0.16] active:scale-[0.96]`.
    Keep `text-amber`, `h-9`.
- **Remove button (line 200):**
  - same pattern → `rounded-tile border border-rose/20 bg-rose/[0.1] ... hover:bg-rose/[0.16] active:scale-[0.96]`.
- **Live placeholder section (line 216):** `rounded-[22px] ... bg-panel-solid-strong/80 p-5` →
  `rounded-card ... bg-panel-solid-strong p-5`, add `animate-feed-reveal`.
- **3-column grid (line 225):** add `animate-feed-reveal` to the grid container's className (single
  entrance, no per-column wrappers). Do NOT wrap the 3 children in extra `<div>`s (wrappers disrupt
  `lg:grid-cols-[320px_minmax(0,1fr)_420px]` stretch). Do NOT change the grid layout classes.
- **Toast (line 287):** leave as-is (it's a transient overlay, not a panel).

### 2. `LpAgentSidebar.tsx`

- **Both outer panels (lines 67, 101):** `rounded-[22px] ... bg-panel-solid-strong/80 p-4` →
  `rounded-card ... bg-panel-solid-strong p-4`.
- **Identity icon tile (line 105):** `rounded-lg border ...` → `rounded-tile border ...`. Keep the
  configured/not tone pair (`border-primary/25 bg-primary/10` vs `border-amber/25 bg-amber/10`) —
  meaningful (ready vs pending). Soften border to `/20` to match recipe.
- **InfoRow (line 166):** `rounded-lg border border-line bg-panel px-3 py-2` → `rounded-tile ...`.
- **APR band `tone="info"` → `text-primary`**: KEEP (APR is the one number worth highlighting).

### 3. `LpPositionsWorkspace.tsx`

- **Summary strip (line 38):** `rounded-lg border border-line bg-panel md:grid-cols-3` → `rounded-tile ...`.
- **Empty state (line 79):** `rounded-[22px] ... bg-panel p-4` → `rounded-card ... bg-panel p-4`.
  Mint button `bg-primary text-on-primary ...` KEEP (primary CTA). Keep `h-9`.

### 4. `LpPositionCard.tsx`

- **Card (line 185):** `rounded-[22px] ... bg-panel-solid-strong/80 p-4` → `rounded-card ...
  bg-panel-solid-strong p-4`.
- **5-cell strip (line 202):** `rounded-lg border border-line bg-panel` → `rounded-tile ...`.
- **InfoCell tones (success=green, warning=amber, danger=rose):** KEEP — these are data-bearing
  (PnL sign, fee earned, APR staking). Do not de-saturate. This is not the "màu mè" the user
  objected to; the objection is decorative panel color, not data color.
- **Range chart container (line 288):** `rounded-xl ... bg-panel p-4` → `rounded-tile ...`.
  Chart band `bg-primary/30 border-primary/40` KEEP (position range). Marker `bg-amber` KEEP
  (current price). These are meaningful, not decorative.
- **Action buttons (lines 221, 232, 241, 252):** `rounded-full border border-line bg-panel` KEEP
  (neutral ghost actions). `h-9` KEEP.

### 5. `LpPolicyControls.tsx` — PRIMARY DE-RAINBOW TARGET

- **Automation panel (line 70) + log panel (line 123):** `rounded-[22px] ... bg-panel-solid-strong/80 p-4`
  → `rounded-card ... bg-panel-solid-strong p-4`.
- **Automation tab buttons (line 95):** `rounded-lg` → `rounded-tile`. Active
  `border-primary/50 bg-primary/10 text-primary` KEEP (active state, meaningful). Inactive KEEP.
- **Log-filter container (line 133):** `rounded-xl ... bg-panel p-1` → `rounded-tile ...`.
- **LogFilterButton (lines 178–219) — DE-RAINBOW:** today ONLY the active pill is colored (inactive
  are plain). Neutralize the active pill FILL, but KEEP reject=amber / execute=green meaning on the
  small count badge (data-bearing). Concretely (substring swaps only — preserve structure):
  - Active button (all tones): replace the colored `border-X/20 bg-X/10 text-X` active class with
    `border-line-strong bg-panel-strong text-foreground` (one neutral active style for all three).
  - Inactive button: `border-transparent text-muted hover:text-foreground` (unchanged).
  - Count badge: keep its tone color but soften: emerald `bg-green/15 text-green`, amber
    `bg-amber/15 text-amber`, slate `bg-panel text-muted`. (Drop the `/20` saturated fills.)
  - Net effect: active pill is calm neutral; the small colored count dot still signals
    reject=amber / execute=green at a glance.
- **"Live stream active" green dot (line 129):** KEEP (`bg-green` single small dot — meaningful
  live indicator). Do not remove.

### 6. `AutomationModuleCard.tsx` — DE-RAINBOW

- **Card (line 32):** `rounded-xl ... bg-panel-solid-strong p-3` → `rounded-tile ...`.
- **TONE_ICON (line 10):** do NOT change the `tone` prop type (keep `"blue" | "green" | "rose"`)
  and do NOT change `TABS` in `LpPolicyControls.tsx`. Only remap the VALUE of `TONE_ICON["blue"]`
  to the primary palette so "blue" renders as primary (blue is redundant with primary):
  - `blue: "border-primary/20 bg-primary/[0.06] text-primary"` (was `border-blue/20 bg-blue/10 text-blue`)
  - `green: "border-green/20 bg-green/[0.06] text-green"` (soften fill `/10`→`/[0.06]`)
  - `rose: "border-rose/20 bg-rose/[0.06] text-rose"` (soften fill `/10`→`/[0.06]`)
  - This is a pure value remap — no type change, no call-site change. Safe for the shared create flow.
- **Icon tile (line 34):** `rounded-lg border ...` → `rounded-tile border ...`.
- **ModuleStatusIcon (line 55):** disabled state `bg-rose/15 text-rose` is harsh for a "coming soon"
  disabled toggle. Soften to `bg-panel-strong text-muted`. Enabled `bg-primary text-on-primary` KEEP.

### 7. `LpAutoMintToggle.tsx`

- **Card (line 93):** `rounded-xl ... bg-panel-solid-strong p-3` → `rounded-tile ...`.
- **Toggle button (line 99):** `h-8` → `h-9` (match siblings). PRESERVE the existing condition
  and labels exactly (`autoMint === true` → rose "Turn off"; `autoMint === false` → primary "Turn
  on"). Only soften the branch classes — do NOT relabel or invert:
  - true branch (rose, "Turn off"): `border-rose/40 bg-rose/10 ... hover:border-rose` →
    `border-rose/20 bg-rose/[0.1] ... hover:bg-rose/[0.16]`.
  - false branch (primary, "Turn on"): `border-primary/50 bg-primary/10 ... hover:border-primary` →
    `border-primary/20 bg-primary/[0.1] ... hover:bg-primary/[0.16]`.
- **Note `text-primary` / error `text-rose`:** KEEP (meaningful status).

## Reused existing pieces

- `--radius-tile` / `--radius-card` / `--radius-hero` + `--shadow-hero` — already in `app/globals.css`.
- `animate-feed-reveal` keyframe + reduced-motion clear — already in `app/globals.css`.
- Alpha recipe `border-X/20 bg-X/[0.1] hover:bg-X/[0.16]` — matches `/fund` and `TONE_CLASS` in
  `DiscoverSurface.tsx`.

## Verification (Claude runs after Codex execute)

1. `npx tsc --noEmit` — no new type errors (Codex must keep `tone` prop types consistent across
   `AutomationModuleCard` + `LpPolicyControls TABS`).
2. `npm run build` — production build clean.
3. `code-review` skill on the diff.
4. `security-review` skill on the diff (confirm no data-flow/contract/secrets drift).
5. Browser (user does visual QA): `/agents/lp/<id>` — header + sidebar + positions + policy panels
   all render, de-rainbowed, dark/light both clean, mobile 375px columns stack, entrance animation
   plays once, reduced-motion kills it. ALSO visually check the LP create flow
   (`/agents/create/lp` or wherever `LpAgentCreateWorkspace` renders) since `AutomationModuleCard`
   is shared — confirm the de-rainbowed `blue→primary` icon tile still reads correctly there.

## Out of scope (noted, not done)

- Consolidating the two balance/accounting sources — behavior change, skip.
- Replacing mock accounting — data work, skip.
- Any contract / hook / API / proof / identity-semantics change.