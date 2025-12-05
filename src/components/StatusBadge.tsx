import React from "react";
import { cn } from "../lib/utils";

interface StatusBadgeProps {
  status: "idle" | "scraping" | "exporting" | "complete" | "error";
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  className,
}) => {
  const variants = {
    idle: {
      bg: "bg-slate-800",
      text: "text-slate-400",
      dot: "bg-slate-500",
      label: "Aguardando",
    },
    scraping: {
      bg: "bg-cyan-950/50",
      text: "text-cyan-400",
      dot: "bg-cyan-500 animate-pulse",
      label: "Extraindo",
    },
    exporting: {
      bg: "bg-purple-950/50",
      text: "text-purple-400",
      dot: "bg-purple-500 animate-pulse",
      label: "Exportando",
    },
    complete: {
      bg: "bg-emerald-950/50",
      text: "text-emerald-400",
      dot: "bg-emerald-500",
      label: "Concluído",
    },
    error: {
      bg: "bg-red-950/50",
      text: "text-red-400",
      dot: "bg-red-500",
      label: "Erro",
    },
  };

  const variant = variants[status];

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium",
        variant.bg,
        variant.text,
        className
      )}
    >
      <span className={cn("w-2 h-2 rounded-full", variant.dot)} />
      {variant.label}
    </div>
  );
};
