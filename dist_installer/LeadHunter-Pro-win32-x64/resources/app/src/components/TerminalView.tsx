import React, { useEffect, useRef } from "react";
import { LogMessage } from "../types";
import { formatTimestamp } from "../lib/utils";
import { cn } from "../lib/utils";

interface TerminalViewProps {
  logs: LogMessage[];
  className?: string;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  logs,
  className,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll to bottom when new logs arrive
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  const getLevelColor = (level: LogMessage["level"]) => {
    switch (level) {
      case "info":
        return "text-cyan-400";
      case "success":
        return "text-emerald-400";
      case "warning":
        return "text-yellow-400";
      case "error":
        return "text-red-400";
      default:
        return "text-slate-400";
    }
  };

  const getLevelIcon = (level: LogMessage["level"]) => {
    switch (level) {
      case "info":
        return "→";
      case "success":
        return "✓";
      case "warning":
        return "⚠";
      case "error":
        return "✗";
      default:
        return "·";
    }
  };

  return (
    <div
      className={cn(
        "bg-black border border-slate-800 rounded-lg overflow-hidden",
        className
      )}
    >
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 flex items-center gap-2">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <div className="w-3 h-3 rounded-full bg-yellow-500" />
          <div className="w-3 h-3 rounded-full bg-emerald-500" />
        </div>
        <span className="text-xs text-slate-400 font-mono ml-2">Terminal</span>
      </div>
      <div
        ref={terminalRef}
        className="p-4 h-64 overflow-y-auto font-mono text-xs leading-relaxed scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900"
      >
        {logs.length === 0 ? (
          <div className="text-slate-600 flex items-center gap-2">
            <span className="animate-pulse">▋</span>
            <span>Aguardando comandos...</span>
          </div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className="flex gap-3 mb-1 hover:bg-slate-900/50 px-2 py-0.5 rounded"
            >
              <span className="text-slate-600 flex-shrink-0">
                {formatTimestamp(log.timestamp)}
              </span>
              <span className={cn("flex-shrink-0", getLevelColor(log.level))}>
                {getLevelIcon(log.level)}
              </span>
              <span className={getLevelColor(log.level)}>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
