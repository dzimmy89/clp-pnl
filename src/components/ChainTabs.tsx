import { CHAINS } from "@/lib/chains";

export function ChainTabs({ active }: { active?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {CHAINS.map((c) => {
        const isActive = c.key === active;
        return (
          <span
            key={c.key}
            className={`eyebrow border px-3 py-1.5 ${
              isActive
                ? "border-gold text-gold"
                : "border-line-soft text-muted"
            }`}
            title={c.live ? "Live" : "Coming soon"}
          >
            {c.name}
            {!c.live && (
              <span className="ml-2 text-faint normal-case tracking-normal">
                soon
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
