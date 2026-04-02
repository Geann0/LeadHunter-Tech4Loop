/**
 * Type Definitions for LeadHunter
 * Professional TypeScript interfaces for type safety
 */

export interface Lead {
  id: string;
  name: string;
  rating: string;
  phone: string;
  address: string;
  url: string;
  city?: string;
  segment?: string;
  // Nível 3 - Dados Estratégicos
  cnpj?: string;
  situacao?: "Ativa" | "Inapta" | "Baixada";
  dataAbertura?: string;
  anoFundacao?: number;
  porte?: "MEI" | "ME" | "EPP" | "LTDA" | "SA";
  cnae?: string;
  cnaePrincipal?: string;
  capitalSocial?: number;
  faixaCapital?: "Pequeno" | "Médio" | "Estruturado";
  extractedAt: string;
  status: "success" | "partial" | "error";
}

export interface LogMessage {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error" | "success";
  message: string;
}

export interface ScrapeProgress {
  current: number;
  total: number;
  percentage: number;
  currentItem?: string;
}

export interface ScrapeConfig {
  searchTerm: string;
  maxResults: number;
  headless: boolean;
}

export interface Stats {
  leadsFound: number;
  timeElapsed: string;
  successRate: number;
  status: "idle" | "scraping" | "exporting" | "complete" | "error";
}

// IPC Channel Types
export interface IpcChannels {
  "scrape:start": ScrapeConfig;
  "scrape:stop": void;
  "scrape:progress": ScrapeProgress;
  "scrape:new-lead": Lead;
  "scrape:log": LogMessage;
  "scrape:complete": { totalLeads: number; filePath: string };
  "scrape:error": { message: string };
  "open:folder": string;
}
