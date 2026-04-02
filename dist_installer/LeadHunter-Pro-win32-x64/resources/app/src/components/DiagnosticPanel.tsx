import { useState } from "react";
import { AlertTriangle, CheckCircle, Loader, Settings } from "lucide-react";

interface DiagnosticResult {
  status: "idle" | "checking" | "repairing" | "success" | "error";
  message: string;
  details: string[];
}

export function DiagnosticPanel() {
  const [diagnostic, setDiagnostic] = useState<DiagnosticResult>({
    status: "idle",
    message: "Clique para diagnosticar",
    details: [],
  });

  const handleDiagnostic = async () => {
    setDiagnostic({
      status: "checking",
      message: "Analisando dependências...",
      details: ["Verificando node_modules..."],
    });

    try {
      // Listen para mensagens de status
      const handleStatus = (data: any) => {
        setDiagnostic((prev) => ({
          ...prev,
          details: [...prev.details, data.message],
        }));
      };

      window.ipcRenderer?.on("diagnostic:status", handleStatus);

      const result = await window.ipcRenderer?.invoke("diagnostic:check");

      if (result?.needsRepair) {
        setDiagnostic({
          status: "repairing",
          message: "Reinstalando dependências...",
          details: [
            "Dependências faltando detectadas",
            "Iniciando instalação do npm...",
          ],
        });

        const repairResult =
          await window.ipcRenderer?.invoke("diagnostic:repair");

        if (repairResult?.success) {
          setDiagnostic({
            status: "success",
            message: "✅ Tudo funcionando perfeitamente!",
            details: repairResult.logs || [
              "Todas as dependências foram restauradas",
              "App pronto para usar",
            ],
          });
        } else {
          setDiagnostic({
            status: "error",
            message: "❌ Erro ao reinstalar dependências",
            details: repairResult?.logs || [
              "Verifique sua conexão com internet",
              "Tente novamente",
            ],
          });
        }
      } else {
        setDiagnostic({
          status: "success",
          message: "✅ Todas as dependências estão presentes",
          details: result?.logs || [
            "node_modules encontrado",
            "Sistema pronto para operação",
          ],
        });
      }

      window.ipcRenderer?.removeAllListeners("diagnostic:status");
    } catch (err) {
      setDiagnostic({
        status: "error",
        message: "❌ Erro no diagnóstico",
        details: [`${err}`],
      });
    }
  };

  const getStatusColor = () => {
    switch (diagnostic.status) {
      case "success":
        return "bg-green-50 border-green-200";
      case "error":
        return "bg-red-50 border-red-200";
      case "checking":
      case "repairing":
        return "bg-blue-50 border-blue-200";
      default:
        return "bg-gray-50 border-gray-200";
    }
  };

  const getIconColor = () => {
    switch (diagnostic.status) {
      case "success":
        return "text-green-600";
      case "error":
        return "text-red-600";
      case "checking":
      case "repairing":
        return "text-blue-600";
      default:
        return "text-gray-600";
    }
  };

  return (
    <div className={`border rounded-lg p-4 ${getStatusColor()}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {diagnostic.status === "checking" ||
          diagnostic.status === "repairing" ? (
            <Loader className={`${getIconColor()} animate-spin`} size={20} />
          ) : diagnostic.status === "success" ? (
            <CheckCircle className={getIconColor()} size={20} />
          ) : diagnostic.status === "error" ? (
            <AlertTriangle className={getIconColor()} size={20} />
          ) : (
            <Settings className={getIconColor()} size={20} />
          )}
          <span className={`font-semibold ${getIconColor()}`}>
            {diagnostic.message}
          </span>
        </div>
        <button
          onClick={handleDiagnostic}
          disabled={
            diagnostic.status === "checking" ||
            diagnostic.status === "repairing"
          }
          className={`px-4 py-2 rounded-lg font-medium transition-all ${
            diagnostic.status === "checking" ||
            diagnostic.status === "repairing"
              ? "bg-gray-300 text-gray-600 cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-700 active:scale-95"
          }`}
        >
          {diagnostic.status === "checking" || diagnostic.status === "repairing"
            ? "Processando..."
            : "Diagnosticar"}
        </button>
      </div>

      {diagnostic.details.length > 0 && (
        <div className="bg-white rounded border border-gray-200 p-3 text-sm space-y-1 max-h-40 overflow-y-auto">
          {diagnostic.details.map((detail, idx) => (
            <div key={idx} className="text-gray-700 font-mono text-xs">
              {`→ ${detail}`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
