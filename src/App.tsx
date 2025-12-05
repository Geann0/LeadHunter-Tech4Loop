import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Play,
  Square,
  FolderOpen,
  Clock,
  Target,
  TrendingUp,
  Minimize2,
  X,
} from "lucide-react";
import { StatusBadge } from "./components/StatusBadge";
import { StatCard } from "./components/StatCard";
import { TerminalView } from "./components/TerminalView";
import { ResultsTable } from "./components/ResultsTable";
import { Lead, LogMessage, ScrapeProgress, Stats } from "./types";
import { formatTime, generateId } from "./lib/utils";
import { cn } from "./lib/utils";

function App() {
  // State Management
  const [searchTerm, setSearchTerm] = useState("");
  const [maxResults, setMaxResults] = useState(200);
  const [headless, setHeadless] = useState(true); // Headless ativado por padrão
  const [leads, setLeads] = useState<Lead[]>([]);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [progress, setProgress] = useState<ScrapeProgress>({
    current: 0,
    total: 0,
    percentage: 0,
  });
  const [stats, setStats] = useState<Stats>({
    leadsFound: 0,
    timeElapsed: "0:00",
    successRate: 100,
    status: "idle",
  });
  const [startTime, setStartTime] = useState<number | null>(null);
  const [outputPath, setOutputPath] = useState<string>("");

  // Timer for elapsed time
  useEffect(() => {
    if (stats.status === "scraping" && startTime) {
      const interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        setStats((prev) => ({ ...prev, timeElapsed: formatTime(elapsed) }));
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [stats.status, startTime]);

  // IPC Event Listeners - REWRITTEN FOR STABILITY
  useEffect(() => {
    if (!window.ipcRenderer) return;

    // 🔥 EXTREME FIX: Use removeAllListeners before adding ANY listener
    window.ipcRenderer.removeAllListeners("scrape:progress");
    window.ipcRenderer.removeAllListeners("scrape:new-lead");
    window.ipcRenderer.removeAllListeners("scrape:log");
    window.ipcRenderer.removeAllListeners("scrape:complete");
    window.ipcRenderer.removeAllListeners("scrape:error");
    window.ipcRenderer.removeAllListeners("scrape:total-found");

    // Progress handler
    const handleProgress = (_event: any, data: ScrapeProgress) => {
      setProgress(data);
      addLog(
        "info",
        `Progresso: ${data.current}/${data.total} (${data.percentage}%)`
      );
    };

    // New lead handler
    const handleNewLead = (_event: any, lead: Lead) => {
      setLeads((prev) => {
        if (prev.some((l) => l.url === lead.url)) {
          return prev;
        }
        return [lead, ...prev];
      });
    };

    // Log handler
    const handleLog = (_event: any, log: LogMessage) => {
      setLogs((prev) => [...prev, log]);
    };

    // Complete handler
    const handleComplete = (
      _event: any,
      data: { totalLeads: number; filePath: string }
    ) => {
      setStats((prev) => ({ ...prev, status: "complete" }));
      setOutputPath(data.filePath);
      addLog(
        "success",
        `✨ Extração concluída! ${data.totalLeads} leads salvos em ${data.filePath}`
      );
    };

    // Error handler
    const handleError = (_event: any, data: { message: string }) => {
      setStats((prev) => ({ ...prev, status: "error" }));
      addLog("error", `❌ Erro: ${data.message}`);
    };

    // Total found handler
    const handleTotalFound = (_event: any, data: { totalFound: number }) => {
      setStats((prev) => ({ ...prev, leadsFound: data.totalFound }));
    };

    // Register listeners
    window.ipcRenderer.on("scrape:progress", handleProgress);
    window.ipcRenderer.on("scrape:new-lead", handleNewLead);
    window.ipcRenderer.on("scrape:log", handleLog);
    window.ipcRenderer.on("scrape:complete", handleComplete);
    window.ipcRenderer.on("scrape:error", handleError);
    window.ipcRenderer.on("scrape:total-found", handleTotalFound);

    // Cleanup on unmount
    return () => {
      window.ipcRenderer?.removeAllListeners("scrape:progress");
      window.ipcRenderer?.removeAllListeners("scrape:new-lead");
      window.ipcRenderer?.removeAllListeners("scrape:log");
      window.ipcRenderer?.removeAllListeners("scrape:complete");
      window.ipcRenderer?.removeAllListeners("scrape:error");
      window.ipcRenderer?.removeAllListeners("scrape:total-found");
    };
  }, []); // Empty deps - run once

  // Helper function to add logs
  const addLog = useCallback((level: LogMessage["level"], message: string) => {
    const log: LogMessage = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    setLogs((prev) => {
      // Prevent duplicate logs by checking last message
      if (prev.length > 0 && prev[prev.length - 1].message === message) {
        return prev;
      }
      return [...prev, log];
    });
  }, []);

  // Start scraping
  const handleStart = useCallback(() => {
    if (!searchTerm.trim()) {
      addLog("error", "Por favor, insira um termo de busca");
      return;
    }

    setStats((prev) => ({ ...prev, status: "scraping" }));
    setStartTime(Date.now());
    setLeads([]);
    setLogs([]);
    setProgress({ current: 0, total: 0, percentage: 0 });

    addLog("info", `🚀 Iniciando extração: "${searchTerm}"`);

    // Send IPC message to start scraping
    if (window.ipcRenderer) {
      window.ipcRenderer.send("scrape:start", {
        searchTerm,
        maxResults,
        headless,
      });
    } else {
      // Demo mode for browser testing
      addLog("info", "🌐 Modo demonstração - Simulando extração...");
      simulateScraping();
    }
  }, [searchTerm, maxResults, headless, addLog]);

  // Demo mode simulation
  const simulateScraping = useCallback(() => {
    const demoLeads = [
      {
        name: "Restaurant Demo 1",
        phone: "(555) 123-4567",
        rating: "4.5",
        address: "123 Main St, New York",
      },
      {
        name: "Cafe Demo 2",
        phone: "(555) 234-5678",
        rating: "4.8",
        address: "456 Park Ave, New York",
      },
      {
        name: "Bistro Demo 3",
        phone: "(555) 345-6789",
        rating: "4.2",
        address: "789 Broadway, New York",
      },
      {
        name: "Pizzeria Demo 4",
        phone: "(555) 456-7890",
        rating: "4.6",
        address: "321 5th Ave, New York",
      },
      {
        name: "Steakhouse Demo 5",
        phone: "(555) 567-8901",
        rating: "4.9",
        address: "654 Madison Ave, New York",
      },
    ];

    let currentIndex = 0;
    const total = Math.min(maxResults, demoLeads.length);

    const interval = setInterval(() => {
      if (currentIndex >= total) {
        clearInterval(interval);
        setStats((prev) => ({ ...prev, status: "complete" }));
        addLog("success", `✨ Demo concluída! ${total} leads simulados`);
        return;
      }

      const demoData = demoLeads[currentIndex % demoLeads.length];
      const lead: Lead = {
        id: `demo_${Date.now()}_${currentIndex}`,
        name: `${demoData.name} #${currentIndex + 1}`,
        rating: demoData.rating,
        phone: demoData.phone,
        address: demoData.address,
        url: `https://maps.google.com/demo/${currentIndex}`,
        extractedAt: new Date().toISOString(),
        status: "success",
      };

      setLeads((prev) => [lead, ...prev]);
      setStats((prev) => ({
        ...prev,
        leadsFound: prev.leadsFound + 1,
        successRate: Math.round(
          ((prev.leadsFound + 1) / (currentIndex + 1)) * 100
        ),
      }));
      setProgress({
        current: currentIndex + 1,
        total,
        percentage: Math.round(((currentIndex + 1) / total) * 100),
      });
      addLog("success", `✅ Lead ${currentIndex + 1}: ${lead.name}`);

      currentIndex++;
    }, 1500);
  }, [maxResults, addLog]);

  // Stop scraping
  const handleStop = useCallback(() => {
    setStats((prev) => ({ ...prev, status: "idle" }));
    addLog("warning", "⏹ Extração interrompida pelo usuário");

    if (window.ipcRenderer) {
      window.ipcRenderer.send("scrape:stop");
    }
  }, [addLog]);

  // Open output folder
  const handleOpenFolder = useCallback(() => {
    if (outputPath && window.ipcRenderer) {
      window.ipcRenderer.send("open:folder", outputPath);
    }
  }, [outputPath]);

  // Window controls
  const handleMinimize = () => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send("window:minimize");
    }
  };

  const handleClose = () => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send("window:close");
    }
  };

  const isScaping = stats.status === "scraping" || stats.status === "exporting";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Custom Window Bar */}
      <div className="bg-slate-900/80 backdrop-blur-xl border-b border-slate-800 px-4 py-3 flex items-center justify-between drag-region">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-emerald-500 rounded-lg flex items-center justify-center">
            <Target className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-lg font-bold bg-gradient-to-r from-cyan-400 to-emerald-400 bg-clip-text text-transparent">
            LeadHunter Pro
          </h1>
          <StatusBadge status={stats.status} />
        </div>
        <div className="flex items-center gap-2 no-drag">
          <button
            onClick={handleMinimize}
            className="w-8 h-8 rounded-lg hover:bg-slate-800 flex items-center justify-center transition-colors"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleClose}
            className="w-8 h-8 rounded-lg hover:bg-red-500/20 hover:text-red-400 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Control Panel */}
        <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex gap-4">
            {/* Search Input */}
            <div className="flex-1 relative">
              <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                <Search className="w-5 h-5 text-slate-500" />
              </div>
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                disabled={isScaping}
                placeholder="Digite o termo de busca (ex: Farmácias em Ji-Paraná)"
                className={cn(
                  "w-full pl-12 pr-4 py-3 bg-slate-950 border-2 border-slate-800 rounded-lg",
                  "text-white placeholder-slate-500 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20",
                  "transition-all duration-200 outline-none",
                  isScaping && "opacity-50 cursor-not-allowed"
                )}
              />
            </div>

            {/* Action Buttons */}
            <button
              onClick={isScaping ? handleStop : handleStart}
              disabled={!searchTerm.trim() && !isScaping}
              className={cn(
                "px-6 py-3 rounded-lg font-semibold flex items-center gap-2 transition-all duration-200",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                isScaping
                  ? "bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/50"
                  : "bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-600 hover:to-emerald-600 shadow-lg shadow-cyan-500/50"
              )}
            >
              {isScaping ? (
                <>
                  <Square className="w-5 h-5" />
                  Parar
                </>
              ) : (
                <>
                  <Play className="w-5 h-5" />
                  Iniciar
                </>
              )}
            </button>
          </div>

          {/* Settings Row */}
          <div className="flex items-center gap-6 pt-2">
            <div className="flex items-center gap-3">
              <label className="text-sm text-slate-400">Máx. Resultados:</label>
              <input
                type="range"
                min="10"
                max="500"
                step="10"
                value={maxResults}
                onChange={(e) => setMaxResults(Number(e.target.value))}
                disabled={isScaping}
                className="w-32"
              />
              <span className="text-sm font-mono text-cyan-400 w-12">
                {maxResults}
              </span>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={headless}
                onChange={(e) => setHeadless(e.target.checked)}
                disabled={isScaping}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-cyan-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all relative" />
              <span className="text-sm text-slate-400">Modo Headless</span>
            </label>

            {stats.status === "complete" && outputPath && (
              <button
                onClick={handleOpenFolder}
                className="ml-auto flex items-center gap-2 px-4 py-2 bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                Abrir Pasta
              </button>
            )}
          </div>
        </div>

        {/* Stats Dashboard */}
        <div className="grid grid-cols-3 gap-4">
          <StatCard
            title="Leads Encontrados"
            value={stats.leadsFound}
            icon={<Target className="w-5 h-5" />}
          />
          <StatCard
            title="Tempo Decorrido"
            value={stats.timeElapsed}
            icon={<Clock className="w-5 h-5" />}
          />
          <StatCard
            title="Taxa de Sucesso"
            value={`${stats.successRate}%`}
            icon={<TrendingUp className="w-5 h-5" />}
          />
        </div>

        {/* Progress Bar */}
        {isScaping && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">
                Progresso: {progress.current} / {progress.total || "?"}
              </span>
              <span className="text-cyan-400 font-mono">
                {progress.percentage}%
              </span>
            </div>
            <div className="h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all duration-300 ease-out relative overflow-hidden"
                style={{ width: `${progress.percentage}%` }}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
              </div>
            </div>
          </div>
        )}

        {/* Terminal and Results */}
        <div className="grid grid-cols-2 gap-4">
          <TerminalView logs={logs} />
          <ResultsTable leads={leads} />
        </div>
      </div>

      {/* Custom Styles for Animations */}
      <style>{`
        .drag-region {
          -webkit-app-region: drag;
        }
        .no-drag {
          -webkit-app-region: no-drag;
        }
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .animate-shimmer {
          animation: shimmer 2s infinite;
        }
        .scrollbar-thin::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .scrollbar-thin::-webkit-scrollbar-track {
          background: rgb(15 23 42);
        }
        .scrollbar-thin::-webkit-scrollbar-thumb {
          background: rgb(51 65 85);
          border-radius: 4px;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background: rgb(71 85 105);
        }
      `}</style>
    </div>
  );
}

export default App;
