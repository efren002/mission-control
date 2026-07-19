import { Code2 } from "lucide-react";

function vscodeFileUrl(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const encoded = absolute
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
  return `vscode://file${encoded}`;
}

export function OpenInVsCode({
  hostPath,
  iconOnly = false,
}: {
  hostPath: string | null;
  iconOnly?: boolean;
}) {
  if (!hostPath) return null;

  return (
    <a
      href={vscodeFileUrl(hostPath)}
      className={
        iconOnly
          ? "border border-[#292824] p-2 text-dim hover:border-signal hover:text-signal"
          : "inline-flex items-center gap-2 border border-[#292824] px-4 py-2 text-[10px] font-bold uppercase text-terminal hover:border-signal hover:text-signal"
      }
      title={`Open ${hostPath} in VS Code`}
      aria-label={iconOnly ? "Open in VS Code" : undefined}
    >
      <Code2 className="h-3.5 w-3.5" />
      {!iconOnly && "Open in VS Code"}
    </a>
  );
}
