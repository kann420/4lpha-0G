import Image from "next/image";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[14px] border border-cyan-200/10 bg-cyan-200/10 shadow-[0_10px_28px_rgba(30,232,197,0.13)] lg:h-12 lg:w-12">
        <Image src="/4lpha_logo.svg" alt="4lpha" fill sizes="48px" className="object-cover" />
      </div>
      {compact ? null : (
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold leading-none text-white">4lpha 0G</p>
          <p className="mt-1 truncate text-xs uppercase tracking-[0.22em] text-cyan-100/60">
            Policy agent
          </p>
        </div>
      )}
    </div>
  );
}
