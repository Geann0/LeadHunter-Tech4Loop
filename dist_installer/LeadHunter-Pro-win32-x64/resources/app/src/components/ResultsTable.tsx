import React from "react";
import { Lead } from "../types";
import { cn } from "../lib/utils";
import { ExternalLink, Phone, MapPin, Star } from "lucide-react";

interface ResultsTableProps {
  leads: Lead[];
  className?: string;
}

export const ResultsTable: React.FC<ResultsTableProps> = ({
  leads,
  className,
}) => {
  const getStatusColor = (status: Lead["status"]) => {
    switch (status) {
      case "success":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
      case "partial":
        return "bg-yellow-500/10 text-yellow-400 border-yellow-500/30";
      case "error":
        return "bg-red-500/10 text-red-400 border-red-500/30";
    }
  };

  return (
    <div
      className={cn(
        "bg-slate-900 border border-slate-800 rounded-lg overflow-hidden",
        className
      )}
    >
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          Leads Extraídos
          <span className="text-xs text-slate-400 font-normal ml-2">
            ({leads.length} encontrados)
          </span>
        </h3>
      </div>
      <div className="overflow-x-auto max-h-96 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-950 sticky top-0 z-10">
            <tr className="border-b border-slate-800">
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                Nome
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                <div className="flex items-center gap-1">
                  <Star className="w-3 h-3" />
                  Nota
                </div>
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                <div className="flex items-center gap-1">
                  <Phone className="w-3 h-3" />
                  Telefone
                </div>
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                <div className="flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  Endereço
                </div>
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-slate-400 uppercase tracking-wider">
                Status
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-slate-400 uppercase tracking-wider">
                Ações
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {leads.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-slate-500"
                >
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center">
                      <MapPin className="w-6 h-6 text-slate-600" />
                    </div>
                    <p>Nenhum lead encontrado ainda</p>
                    <p className="text-xs">
                      Inicie uma busca para começar a extração
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              leads.map((lead, index) => (
                <tr
                  key={lead.id}
                  className={cn(
                    "hover:bg-slate-800/50 transition-colors",
                    index % 2 === 0 ? "bg-slate-900/50" : "bg-slate-900"
                  )}
                >
                  <td className="px-4 py-3 text-white font-medium">
                    {lead.name}
                  </td>
                  <td className="px-4 py-3 text-cyan-400 font-mono">
                    {lead.rating || "N/A"}
                  </td>
                  <td className="px-4 py-3 text-emerald-400 font-mono">
                    {lead.phone || "Não informado"}
                  </td>
                  <td className="px-4 py-3 text-slate-300 max-w-xs truncate">
                    {lead.address}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={cn(
                        "inline-flex items-center px-2 py-1 rounded-full text-xs font-medium border",
                        getStatusColor(lead.status)
                      )}
                    >
                      {lead.status === "success"
                        ? "✓ Completo"
                        : lead.status === "partial"
                        ? "⚠ Parcial"
                        : "✗ Erro"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <a
                      href={lead.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300 transition-colors"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
