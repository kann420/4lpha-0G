"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/providers/ThemeProvider";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === "light";

  return (
    <button
      type="button"
      onClick={() => {
        dispatchSigmaPetReaction("app.theme", { force: true });
        toggleTheme();
      }}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      className={`interaction flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-panel text-muted transition-colors hover:border-line-strong hover:bg-panel-strong hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${className}`}
    >
      {isLight ? (
        <Moon className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Sun className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
