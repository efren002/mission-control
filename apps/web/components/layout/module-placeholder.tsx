import type { LucideIcon } from "lucide-react";

interface ModulePlaceholderProps {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

export function ModulePlaceholder({
  eyebrow,
  title,
  description,
  icon: Icon,
}: ModulePlaceholderProps) {
  return (
    <div>
      <p className="eyebrow mb-3">{eyebrow}</p>
      <h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">
        {title}
      </h1>
      <p className="mt-2 max-w-2xl text-xs leading-5 text-dim">{description}</p>
      <section className="control-panel mt-6 grid min-h-[420px] place-items-center p-8 text-center">
        <div>
          <div className="mx-auto grid h-12 w-12 place-items-center border border-signal/30 bg-signal/[0.05]">
            <Icon className="h-5 w-5 text-signal" />
          </div>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.12em] text-terminal">
            [ module initialized ]
          </p>
          <p className="mt-2 text-[10px] text-dim">
            Domain behavior will be added in its vertical slice.
          </p>
        </div>
      </section>
    </div>
  );
}
