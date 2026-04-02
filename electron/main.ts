import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "fs";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import ExcelJS from "exceljs";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Types
interface Lead {
  name: string;
  phone: string;
  city: string;
  commercialSegment: string;
  cnpj: string;
  capitalSocial: string;
  rating: string;
  situacao?: string; // Ativa, Inapta, Baixada
  dataAbertura?: string; // Data de abertura
  porte?: string; // MEI, ME, EPP, LTDA, SA
  cnaeDescricao?: string; // Descrição da atividade principal
  faixaCapitalSocial?: string; // Pequeno, Médio, Estruturado
  cnae?: string; // Código CNAE (ex: 4711-3)
  score?: number; // Pontuação de qualidade do lead (0-100)
  extractedAt?: string;
  status?: "success" | "error";
}

process.env.APP_ROOT = path.join(__dirname, "..");

export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null;
let browser: Browser | null = null;
let isScrapingActive = false;
let handlersRegistered = false; // 🔥 FIX: Track if handlers are already registered

// 🔥 MEMORY OPTIMIZATION: Ephemeral context management
const CONTEXT_RESTART_INTERVAL = 50; // Restart browser context every 50 extractions
let extractionCounter = 0;

// Helper Functions
function sendLog(
  level: "info" | "success" | "warning" | "error",
  message: string,
) {
  win?.webContents.send("scrape:log", {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    level,
    message,
  });
}

function sendProgress(current: number, total: number, currentItem?: string) {
  const percentage =
    total > 0 ? Math.round((current / total) * 100 * 100) / 100 : 0; // 2 decimais
  win?.webContents.send("scrape:progress", {
    current,
    total,
    percentage,
    currentItem,
  });
}

function sendComplete(totalLeads: number, filePath: string) {
  win?.webContents.send("scrape:complete", { totalLeads, filePath });
}

function sendError(message: string) {
  win?.webContents.send("scrape:error", { message });
}

// 🔥 SERPAPI KEY - Configurável
const SERPAPI_KEY =
  process.env.SERPAPI_KEY ||
  "52520c7cdc82c3d7e0acbaa6354e2c5c43ebd1bd15254d84c6d6eaa510125ea2";

// 🔥 CNPJ UTILITIES: Validation and normalization
function normalizeCNPJ(cnpj: string): string {
  return cnpj.replace(/[^\d]/g, "");
}

function validateCNPJ(cnpj: string): boolean {
  const cleanCNPJ = normalizeCNPJ(cnpj);

  // Must be 14 digits
  if (cleanCNPJ.length !== 14) return false;

  // Check for all same digits (invalid)
  if (/^(\d)\1{13}$/.test(cleanCNPJ)) return false;

  // Calculate first check digit
  let tamanho = cleanCNPJ.length - 2;
  let numeros = cleanCNPJ.substring(0, tamanho);
  let digitos = cleanCNPJ.substring(tamanho);
  let soma = 0;
  let pos = tamanho - 7;

  for (let i = tamanho; i >= 1; i--) {
    soma += parseInt(numeros.charAt(tamanho - i)) * pos--;
    if (pos < 2) pos = 9;
  }

  let resultado = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  if (resultado !== parseInt(digitos.charAt(0))) return false;

  // Calculate second check digit
  tamanho = tamanho + 1;
  numeros = cleanCNPJ.substring(0, tamanho);
  soma = 0;
  pos = tamanho - 7;

  for (let i = tamanho; i >= 1; i--) {
    soma += parseInt(numeros.charAt(tamanho - i)) * pos--;
    if (pos < 2) pos = 9;
  }

  resultado = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  return resultado === parseInt(digitos.charAt(1));
}

// 🔥 HELPER: Determine company size (MEI, ME, EPP, LTDA, SA) from legal nature
function determineCompanySize(
  legalNature?: string,
  capitalSocial?: string,
): string {
  if (!legalNature && !capitalSocial) return "Não declarado";

  const legal = String(legalNature || "").toLowerCase();
  const capital = parseFloat(String(capitalSocial || "0").replace(/\D/g, "") || "0");

  // Check legal nature first
  if (legal.includes("mei") || legal.includes("microempreendedor")) return "MEI";
  if (legal.includes("ltda")) return "LTDA";
  if (legal.includes("s/a") || legal.includes("sociedade anonima")) return "SA";

  // Fallback to capital social range
  if (capital <= 50000) return "ME"; // Microempresa
  if (capital <= 300000) return "EPP"; // PME/EPP
  return "LTDA"; // Default to LTDA for larger companies
}

// 🔥 HELPER: Classify capital social range (Pequeno, Médio, Estruturado)
function classifyCapitalRange(capitalSocial?: string): string {
  if (!capitalSocial || capitalSocial === "Não declarado") return "N/A";

  // Extract numeric value
  const numericValue = parseFloat(
    String(capitalSocial).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".") || "0",
  );

  if (numericValue === 0) return "N/A";
  if (numericValue <= 50000) return "Pequeno"; // até 50k
  if (numericValue <= 300000) return "Médio"; // 50k-300k
  return "Estruturado"; // acima de 300k
}

// 🔥 HELPER: Format opening date from ISO or DDMMYYYY format
function formatOpeningDate(dateStr?: string): string {
  if (!dateStr) return "N/A";

  try {
    // Try ISO format first (YYYY-MM-DD)
    if (dateStr.includes("-")) {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.getFullYear().toString();
      }
    }
    // Try DDMMYYYY format
    if (dateStr.length === 8 && /^\d{8}$/.test(dateStr)) {
      const year = dateStr.substring(4, 8);
      return year;
    }
    // Return as-is if can't parse
    return dateStr.substring(0, 4); // Try to extract year
  } catch {
    return "N/A";
  }
}

// 🔥 NEW: Map CNAE code to commercial segment name
// 🔥 NEW: Calculate lead quality score (0-100)
function calculateLeadScore(lead: {
  situacao?: string;
  porte?: string;
  capitalSocial?: string;
  dataAbertura?: string;
  phone?: string;
  rating?: string;
}): number {
  let score = 0;

  // ========== CRITERIO 1: Situação Cadastral (até 20 pontos) ==========
  // Empresas ativas têm melhor potencial de lead
  if (lead.situacao === "Ativa") {
    score += 20; // Máximo: empresa regularizada
  } else if (lead.situacao === "Inapta") {
    score += 5; // Mínimo: empresa com problemas
  } else if (lead.situacao === "Baixada") {
    score += 0; // Nenhum ponto: empresa desativada
  } else {
    score += 0; // Nula ou desconhecido: sem pontos
  }

  // ========== CRITERIO 2: Porte da Empresa (até 25 pontos) ==========
  // Empresas maiores têm maior potencial de compra/venda
  if (lead.porte) {
    if (lead.porte === "SA" || lead.porte === "LTDA") score += 25; // Maior porte
    else if (lead.porte === "EMP") score += 20; // Médio porte (empresa média)
    else if (lead.porte === "EPP") score += 15; // Pequeno porte
    else if (lead.porte === "ME") score += 10; // Microempresa
    else if (lead.porte === "MEI") score += 5; // Microempreendedor
  }

  // ========== CRITERIO 3: Capital Social (até 30 pontos) ==========
  // Maior capital = maior operação = maior interesse em novos negócios
  if (lead.capitalSocial && lead.capitalSocial !== "N/A") {
    const capitalAmount = parseFloat(
      String(lead.capitalSocial)
        .replace(/[^\d.,]/g, "")
        .replace(/\./g, "")
        .replace(",", ".") || "0"
    );

    if (capitalAmount > 5000000) score += 30; // Mega: > 5M
    else if (capitalAmount > 1000000) score += 28; // Grande: > 1M
    else if (capitalAmount > 500000) score += 25; // Médio-grande: > 500k
    else if (capitalAmount > 200000) score += 20; // Médio: > 200k
    else if (capitalAmount > 100000) score += 15; // Médio-pequeno: > 100k
    else if (capitalAmount > 50000) score += 10; // Pequeno: > 50k
    else if (capitalAmount > 10000) score += 5; // Muito pequeno: > 10k
    else if (capitalAmount > 0) score += 2; // Mínimo: > 0
  }

  // ========== CRITERIO 4: Tempo de Operação / Antiguidade (até 15 pontos) ==========
  // Empresas mais antigas são mais estabelecidas e confiáveis
  if (lead.dataAbertura && lead.dataAbertura !== "N/A") {
    const year = parseInt(lead.dataAbertura);
    if (!isNaN(year) && year > 1900) {
      const yearsActive = new Date().getFullYear() - year;
      if (yearsActive >= 20) score += 15; // Muito antiga: >= 20 anos
      else if (yearsActive >= 10) score += 13; // Bastante antiga: >= 10 anos
      else if (yearsActive >= 5) score += 10; // Estabelecida: >= 5 anos
      else if (yearsActive >= 3) score += 7; // Moderada: >= 3 anos
      else if (yearsActive >= 1) score += 4; // Recente: >= 1 ano
      else score += 1; // Muito recente: < 1 ano
    }
  }

  // ========== CRITERIO 5: Avaliação / Rating Google (até 10 pontos) ==========
  // Melhor rating = melhor reputação = maior conversão
  if (lead.rating && lead.rating !== "N/A" && lead.rating !== "0") {
    const ratingValue = parseFloat(lead.rating);
    if (!isNaN(ratingValue)) {
      if (ratingValue >= 4.8) score += 10; // Excelente: >= 4.8
      else if (ratingValue >= 4.5) score += 9; // Muito bom: >= 4.5
      else if (ratingValue >= 4.2) score += 8; // Bom: >= 4.2
      else if (ratingValue >= 4.0) score += 7; // Satisfatório: >= 4.0
      else if (ratingValue >= 3.5) score += 5; // Aceitável: >= 3.5
      else if (ratingValue >= 3.0) score += 3; // Fraco: >= 3.0
      else if (ratingValue > 0) score += 1; // Muito fraco: > 0
    }
  }

  // ========== GARANTIAS DE MÍNIMO E MÁXIMO ==========
  // Score não pode ser negativo (mínimo 0)
  // Score não pode exceder 100 (máximo 100)
  return Math.max(0, Math.min(100, score));
}

// Try SerpAPI (Method 0 - Google Search API)
async function searchCNPJViaSerpAPI(
  name: string,
  city: string,
): Promise<{
  cnpj: string;
  capitalSocial: string;
  situacao?: string;
  dataAbertura?: string;
  porte?: string;
  cnaeDescricao?: string;
} | null> {
  try {
    if (!SERPAPI_KEY) {
      console.info("[SerpAPI] No API key configured, skipping");
      return null;
    }

    const query = encodeURIComponent(`CNPJ ${name} ${city}`);
    const url = `https://serpapi.com/search.json?q=${query}&engine=google&api_key=${SERPAPI_KEY}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "LeadHunter/2.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return null;
    const data = (await response.json()) as {
      organic_results?: Array<{ snippet?: string }>;
    };

    // CNPJ regex pattern
    const regexCnpj = /(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/;

    if (data.organic_results && Array.isArray(data.organic_results)) {
      for (const result of data.organic_results) {
        if (result.snippet) {
          const match = result.snippet.match(regexCnpj);
          if (match) {
            const cnpj = normalizeCNPJ(match[0]);
            // Validate CNPJ format
            if (validateCNPJ(cnpj)) {
              // Format CNPJ: XX.XXX.XXX/XXXX-XX
              const formatted = `${cnpj.substring(0, 2)}.${cnpj.substring(2, 5)}.${cnpj.substring(5, 8)}/${cnpj.substring(8, 12)}-${cnpj.substring(12)}`;

              return {
                cnpj: formatted,
                capitalSocial: "N/A", // SerpAPI doesn't return this
              };
            }
          }
        }
      }
    }
    return null;
  } catch (err) {
    console.error("SerpAPI error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// 🔥 RECEITAWS: Free CNPJ lookup from public data
// 🔥 CNPJ Lookup - Hybrid approach with multiple fallbacks
const cnpjCache = new Map<
  string,
  {
    cnpj: string;
    capitalSocial: string;
    situacao?: string;
    dataAbertura?: string;
    porte?: string;
    cnaeDescricao?: string;
  }
>();

// Try ReceitaWS (Method 1) - https://www.receitaws.com.br/
async function searchCNPJViaReceitaWS(
  name: string,
  city: string,
): Promise<{
  cnpj: string;
  capitalSocial: string;
  situacao?: string;
  dataAbertura?: string;
  porte?: string;
  cnaeDescricao?: string;
} | null> {
  try {
    const cnpjClean = name.replace(/\D/g, "");
    
    // If name contains CNPJ-like pattern, try direct fetch
    if (cnpjClean.length === 14) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(
        `https://www.receitaws.com.br/v1/cnpj/${cnpjClean}`,
        {
          headers: { "User-Agent": "LeadHunter/2.0" },
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);

      if (response.ok) {
        const details = (await response.json()) as {
          cnpj?: string;
          capital_social?: string | number;
          situacao?: string;
          abertura?: string;
          porte?: string;
          atividade_principal?: Array<{ text?: string; code?: string }>;
          cnae_descricao?: string;
          status?: string;
        };

        if (details?.cnpj) {
          const capitalSocial = details.capital_social
            ? `R$ ${parseFloat(String(details.capital_social)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "N/A";

          // CORRIGIDO: ReceitaWS retorna 'situacao' (não 'status')
          const situacao = details.situacao || details.status || undefined;
          console.debug(`[ReceitaWS] Situação encontrada: ${situacao}`);

          // CORRIGIDO: Formato da data é DD/MM/YYYY
          const dataAbertura = details.abertura
            ? formatOpeningDate(details.abertura)
            : undefined;

          // CORRIGIDO: ReceitaWS usa 'atividade_principal' com array
          const cnaeDescricao = details.atividade_principal?.[0]?.text || details.cnae_descricao || undefined;

          // ReceitaWS retorna 'porte' diretamente
          const porte = details.porte || undefined;

          return {
            cnpj: details.cnpj,
            capitalSocial,
            situacao,
            dataAbertura,
            porte,
            cnaeDescricao,
          };
        }
      }
    }

    // Fallback: Search endpoint se não encontrou por CNPJ direto
    const searchQuery = `${name} ${city}`.trim();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://www.receitaws.com.br/api/cnpj/search?q=${encodeURIComponent(searchQuery)}`,
      {
        headers: { "User-Agent": "LeadHunter/2.0" },
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) return null;
    const searchData = await response.json();
    if (!searchData.company?.cnpj) return null;

    const cnpjValue = searchData.company.cnpj.replace(/\D/g, "");
    const detailController = new AbortController();
    const detailTimeoutId = setTimeout(() => detailController.abort(), 5000);

    const detailResponse = await fetch(
      `https://www.receitaws.com.br/v1/cnpj/${cnpjValue}`,
      {
        headers: { "User-Agent": "LeadHunter/2.0" },
        signal: detailController.signal,
      },
    );
    clearTimeout(detailTimeoutId);

    if (!detailResponse.ok) return null;
    const details = (await detailResponse.json()) as {
      cnpj?: string;
      capital_social?: string | number;
      situacao?: string;
      abertura?: string;
      porte?: string;
      atividade_principal?: Array<{ text?: string; code?: string }>;
      cnae_descricao?: string;
      status?: string;
    };

    if (details?.cnpj) {
      const capitalSocial = details.capital_social
        ? `R$ ${parseFloat(String(details.capital_social)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "N/A";

      const situacao = details.situacao || details.status || undefined;
      const dataAbertura = details.abertura
        ? formatOpeningDate(details.abertura)
        : undefined;
      const cnaeDescricao = details.atividade_principal?.[0]?.text || details.cnae_descricao || undefined;
      const porte = details.porte || undefined;

      return {
        cnpj: details.cnpj,
        capitalSocial,
        situacao,
        dataAbertura,
        porte,
        cnaeDescricao,
      };
    }
    return null;
  } catch (err) {
    console.debug(`[ReceitaWS] Error: ${err instanceof Error ? err.message : "Unknown"}`);
    return null;
  }
}

// Try BrasilAPI (Method 2)
async function searchCNPJViaBrasilAPI(
  name: string,
): Promise<{
  cnpj: string;
  capitalSocial: string;
  situacao?: string;
  dataAbertura?: string;
  porte?: string;
  cnaeDescricao?: string;
} | null> {
  try {
    type BrasilAPISearchCompany = {
      cnpj?: string;
      capital_social?: string | number;
      status?: string;
      situacao_cadastral?: number;
      descricao_situacao_cadastral?: string;
      establishment_opening_date?: string;
      data_inicio_atividade?: string;
      data_da_constituicao?: string;
      main_activity_description?: string;
      cnae_fiscal_descricao?: string;
      cnae?: string;
      cnae_fiscal?: number;
      main_cnae?: string;
      legal_nature?: string;
      natureza_juridica?: string;
      porte?: string;
    };

    type BrasilAPIDetailData = BrasilAPISearchCompany;

    // Step 1: Search by company name
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://brasilapi.com.br/api/cnpj/v1/search?company_name=${encodeURIComponent(name)}`,
      {
        headers: { "User-Agent": "LeadHunter/2.0" },
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) return null;
    const searchData = (await response.json()) as BrasilAPISearchCompany[];

    // BrasilAPI search returns array of results
    if (Array.isArray(searchData) && searchData.length > 0) {
      const company = searchData[0]; // Take first match
      const cnpj = company.cnpj || "N/A";
      if (cnpj === "N/A") return null;

      const cnpjClean = cnpj.replace(/\D/g, "");
      
      // Step 2: Fetch detailed data from specific CNPJ endpoint for complete information
      console.debug(`[BrasilAPI Search] Found CNPJ ${cnpj}, fetching details...`);
      let detailResult: BrasilAPIDetailData | null = null;

      try {
        const detailController = new AbortController();
        const detailTimeoutId = setTimeout(() => detailController.abort(), 5000);

        const detailResponse = await fetch(
          `https://brasilapi.com.br/api/cnpj/v1/${cnpjClean}`,
          {
            headers: { "User-Agent": "LeadHunter/2.0" },
            signal: detailController.signal,
          },
        );
        clearTimeout(detailTimeoutId);

        if (detailResponse.ok) {
          detailResult = (await detailResponse.json()) as BrasilAPIDetailData;
          console.debug(`[BrasilAPI Search] Successfully fetched full details for ${cnpj}`);
        }
      } catch (err) {
        console.debug(`[BrasilAPI Search] Could not fetch details: ${err instanceof Error ? err.message : "Unknown"}`);
      }

      // Extract Capital Social
      const capitalValue = detailResult?.capital_social || company.capital_social;
      const capitalSocial = capitalValue
        ? `R$ ${parseFloat(String(capitalValue)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "N/A";

      // Extract Situação - try all variants
      let situacao: string | undefined;
      if (detailResult?.descricao_situacao_cadastral) {
        situacao = detailResult.descricao_situacao_cadastral;
      } else if (detailResult?.status) {
        situacao = detailResult.status;
      } else if (company.descricao_situacao_cadastral) {
        situacao = company.descricao_situacao_cadastral;
      } else if (company.status) {
        situacao = company.status;
      }

      // Extract Data Abertura - try all variants
      let dataAbertura: string | undefined;
      if (detailResult?.data_inicio_atividade) {
        dataAbertura = formatOpeningDate(detailResult.data_inicio_atividade);
      } else if (detailResult?.establishment_opening_date) {
        dataAbertura = formatOpeningDate(detailResult.establishment_opening_date);
      } else if (company.data_inicio_atividade) {
        dataAbertura = formatOpeningDate(company.data_inicio_atividade);
      } else if (company.establishment_opening_date) {
        dataAbertura = formatOpeningDate(company.establishment_opening_date);
      }

      // Extract CNAE Descrição - try all variants
      let cnaeDescricao: string | undefined;
      if (detailResult?.cnae_fiscal_descricao) {
        cnaeDescricao = detailResult.cnae_fiscal_descricao;
      } else if (detailResult?.main_activity_description) {
        cnaeDescricao = detailResult.main_activity_description;
      } else if (company.cnae_fiscal_descricao) {
        cnaeDescricao = company.cnae_fiscal_descricao;
      } else if (company.main_activity_description) {
        cnaeDescricao = company.main_activity_description;
      }

      // Extract Porte - try all variants
      let porte: string | undefined;
      if (detailResult?.porte) {
        porte = detailResult.porte;
      } else if (company.porte) {
        porte = company.porte;
      } else if (detailResult?.legal_nature) {
        porte = determineCompanySize(detailResult.legal_nature, String(detailResult.capital_social || "0"));
      } else if (detailResult?.natureza_juridica) {
        porte = determineCompanySize(detailResult.natureza_juridica, String(detailResult.capital_social || "0"));
      }

      return {
        cnpj,
        capitalSocial,
        situacao,
        dataAbertura,
        porte: porte !== "N/A" ? porte : undefined,
        cnaeDescricao,
      };
    }
    return null;
  } catch (err) {
    console.error("BrasilAPI error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Try Google Search scraping (Method 3 - Aggressive fallback)
async function searchCNPJViaGoogle(
  name: string,
  city: string,
): Promise<{
  cnpj: string;
  capitalSocial: string;
  situacao?: string;
  dataAbertura?: string;
  porte?: string;
  cnaeDescricao?: string;
} | null> {
  try {
    const searchQuery = `${name} ${city} CNPJ`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(
      `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) return null;
    const html = await response.text();

    // Regex patterns para CNPJ
    // CNPJ format: XX.XXX.XXX/XXXX-XX
    const cnpjRegex = /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/;
    const match = html.match(cnpjRegex);

    if (match) {
      return {
        cnpj: match[1],
        capitalSocial: "N/A", // Google Search não retorna capital social facilmente
      };
    }
    return null;
  } catch (err) {
    console.error(
      "Google Search error:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// Try CNPJA API (Method 4 - Premium fallback) - https://cnpja.com/api
async function searchCNPJViaCNPJA(
  cnpj: string,
): Promise<{
  cnpj: string;
  capitalSocial: string;
  situacao?: string;
  dataAbertura?: string;
  porte?: string;
  cnaeDescricao?: string;
} | null> {
  try {
    const cnpjClean = normalizeCNPJ(cnpj);
    
    // CNPJA Key - configurável via environment ou hardcoded
    const cnpjaKey = process.env.CNPJA_KEY || "43a76ea4-a463-44f9-899e-374746ae048b-8149b5da-dfff-4de5-bee7-68946deff296";
    
    if (!cnpjaKey) {
      console.debug(`[CNPJA] API key not configured, skipping`);
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://api.cnpja.com/office/${cnpjClean}`,
      {
        headers: {
          "User-Agent": "LeadHunter/2.0",
          "Authorization": cnpjaKey, // CNPJA uses Authorization header directly
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.debug(`[CNPJA] HTTP ${response.status} for ${cnpjClean}`);
      return null;
    }

    const data = (await response.json()) as {
      taxId?: string;
      founded?: string;
      company?: {
        id?: number;
        name?: string;
        equity?: number;
      };
      address?: {
        city?: string;
        state?: string;
      };
      simples?: {
        optant?: boolean;
      };
    };

    if (data?.taxId) {
      // Extract Capital Social
      const capitalValue = data.company?.equity;
      const capitalSocial = capitalValue
        ? `R$ ${parseFloat(String(capitalValue)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "N/A";

      // Extract Data Abertura (founded field)
      const dataAbertura = data.founded
        ? formatOpeningDate(data.founded)
        : undefined;

      // CNPJA não retorna situação diretamente, mas pode usar simples.optant
      let situacao: string | undefined;
      if (data.simples?.optant === true) {
        situacao = "Ativa"; // If in Simples, assume active
      }

      console.debug(`[CNPJA] Successfully retrieved data for ${cnpjClean}`);

      return {
        cnpj: data.taxId,
        capitalSocial,
        situacao,
        dataAbertura,
        porte: undefined, // CNPJA doesn't provide company size
        cnaeDescricao: undefined, // CNPJA doesn't provide CNAE in basic response
      };
    }
    return null;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown";
    if (errorMsg.includes("401") || errorMsg.includes("unauthorized")) {
      console.debug(`[CNPJA] Authentication failed - invalid API key`);
    } else {
      console.debug(`[CNPJA] Error: ${errorMsg}`);
    }
    return null;
  }
}

// 🔥 CONSOLIDATION WITH MANDATORY FALLBACK: Ensures Situação is never empty without trying all APIs
async function consolidateCNPJDataWithFallback(
  cnpj: string,
): Promise<{
  capitalSocial?: string;
  situacao?: string;
  dataAbertura?: string;
  porte?: string;
  cnaeDescricao?: string;
}> {
  try {
    const cnpjClean = normalizeCNPJ(cnpj);
    
    type BrasilAPIData = {
      capital_social?: string | number;
      status?: string;
      situacao_cadastral?: number;
      descricao_situacao_cadastral?: string;
      establishment_opening_date?: string;
      data_inicio_atividade?: string;
      data_da_constituicao?: string;
      main_activity_description?: string;
      cnae_fiscal_descricao?: string;
      cnae?: string;
      cnae_fiscal?: number;
      main_cnae?: string;
      legal_nature?: string;
      natureza_juridica?: string;
      porte?: string;
    };

    type ReceitaWSData = {
      capital_social?: string | number;
      situacao?: string;
      abertura?: string;
      cnae_descricao?: string;
      atividade_principal?: Array<{ text?: string; code?: string }>;
      porte?: string;
      status?: string;
    };

    let brasilApiResult: BrasilAPIData | null = null;
    let receitaWsResult: ReceitaWSData | null = null;

    // Step 1: Try BrasilAPI (primary)
    console.debug(`[Consolidation] Attempting BrasilAPI for ${cnpjClean}...`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const brasilResponse = await fetch(
        `https://brasilapi.com.br/api/cnpj/v1/${cnpjClean}`,
        { 
          headers: { "User-Agent": "LeadHunter/2.0" },
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);
      
      if (brasilResponse.ok) {
        brasilApiResult = (await brasilResponse.json()) as BrasilAPIData;
        console.debug(`[Consolidation] ✅ BrasilAPI returned data`);
      } else {
        console.debug(`[Consolidation] ⚠️ BrasilAPI HTTP ${brasilResponse.status}`);
      }
    } catch (err) {
      console.debug(`[Consolidation] BrasilAPI timeout/error: ${err instanceof Error ? err.message : "Unknown"}`);
    }

    // Step 2: Try ReceitaWS (fallback)
    console.debug(`[Consolidation] Attempting ReceitaWS for ${cnpjClean}...`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const receitaResponse = await fetch(
        `https://www.receitaws.com.br/v1/cnpj/${cnpjClean}`,
        { 
          headers: { "User-Agent": "LeadHunter/2.0" },
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);

      if (receitaResponse.ok) {
        receitaWsResult = (await receitaResponse.json()) as ReceitaWSData;
        console.debug(`[Consolidation] ✅ ReceitaWS returned data`);
      } else {
        console.debug(`[Consolidation] ⚠️ ReceitaWS HTTP ${receitaResponse.status}`);
      }
    } catch (err) {
      console.debug(`[Consolidation] ReceitaWS timeout/error: ${err instanceof Error ? err.message : "Unknown"}`);
    }

    // Step 3: Try CNPJA (second fallback - only if both BrasilAPI and ReceitaWS failed)
    let cnpjaResult: any = null;
    if (!brasilApiResult && !receitaWsResult) {
      console.debug(`[Consolidation] Attempting CNPJA for ${cnpjClean} (last resort)...`);
      cnpjaResult = await searchCNPJViaCNPJA(cnpjClean);
      if (cnpjaResult) {
        console.debug(`[Consolidation] ✅ CNPJA returned data`);
      } else {
        console.debug(`[Consolidation] ⚠️ CNPJA failed`);
      }
    }

    // Step 4: Consolidate with rigid hierarchy (BrasilAPI > ReceitaWS > CNPJA)
    const result: {
      capitalSocial?: string;
      situacao?: string;
      dataAbertura?: string;
      porte?: string;
      cnaeDescricao?: string;
    } = {};

    // Capital Social: BrasilAPI > ReceitaWS > CNPJA preference
    if (brasilApiResult?.capital_social) {
      result.capitalSocial = `R$ ${parseFloat(String(brasilApiResult.capital_social)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else if (receitaWsResult?.capital_social) {
      result.capitalSocial = `R$ ${parseFloat(String(receitaWsResult.capital_social)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else if (cnpjaResult?.capitalSocial && cnpjaResult.capitalSocial !== "N/A") {
      result.capitalSocial = cnpjaResult.capitalSocial;
    }

    // 🔥 Situação: BrasilAPI > ReceitaWS > CNPJA (NEVER undefined without trying all)
    // Try BrasilAPI first with all possible field names
    if (brasilApiResult?.descricao_situacao_cadastral) {
      result.situacao = brasilApiResult.descricao_situacao_cadastral;
      console.debug(`[Consolidation] ✅ Situação from BrasilAPI (descricao_situacao_cadastral): ${brasilApiResult.descricao_situacao_cadastral}`);
    } else if (brasilApiResult?.status) {
      result.situacao = brasilApiResult.status;
      console.debug(`[Consolidation] ✅ Situação from BrasilAPI (status): ${brasilApiResult.status}`);
    } else if (receitaWsResult?.situacao) {
      result.situacao = receitaWsResult.situacao;
      console.debug(`[Consolidation] ✅ Situação from ReceitaWS (situacao): ${receitaWsResult.situacao}`);
    } else if (receitaWsResult?.status) {
      result.situacao = receitaWsResult.status;
      console.debug(`[Consolidation] ✅ Situação from ReceitaWS (status): ${receitaWsResult.status}`);
    } else if (cnpjaResult?.situacao) {
      result.situacao = cnpjaResult.situacao;
      console.debug(`[Consolidation] ✅ Situação from CNPJA: ${cnpjaResult.situacao}`);
    } else {
      console.debug(`[Consolidation] ⚠️ Situação not found in any API`);
    }

    // Data Abertura: BrasilAPI > ReceitaWS > CNPJA (with all possible field names)
    if (brasilApiResult?.data_inicio_atividade) {
      result.dataAbertura = formatOpeningDate(brasilApiResult.data_inicio_atividade);
      console.debug(`[Consolidation] ✅ Data abertura from BrasilAPI (data_inicio_atividade)`);
    } else if (brasilApiResult?.establishment_opening_date) {
      result.dataAbertura = formatOpeningDate(brasilApiResult.establishment_opening_date);
      console.debug(`[Consolidation] ✅ Data abertura from BrasilAPI (establishment_opening_date)`);
    } else if (brasilApiResult?.data_da_constituicao) {
      result.dataAbertura = formatOpeningDate(brasilApiResult.data_da_constituicao);
      console.debug(`[Consolidation] ✅ Data abertura from BrasilAPI (data_da_constituicao)`);
    } else if (receitaWsResult?.abertura) {
      result.dataAbertura = formatOpeningDate(receitaWsResult.abertura);
      console.debug(`[Consolidation] ✅ Data abertura from ReceitaWS (abertura)`);
    } else if (cnpjaResult?.dataAbertura && cnpjaResult.dataAbertura !== "N/A") {
      result.dataAbertura = cnpjaResult.dataAbertura;
      console.debug(`[Consolidation] ✅ Data abertura from CNPJA`);
    }

    // CNAE Descrição: BrasilAPI > ReceitaWS (with all possible field names)
    if (brasilApiResult?.cnae_fiscal_descricao) {
      result.cnaeDescricao = brasilApiResult.cnae_fiscal_descricao;
      console.debug(`[Consolidation] ✅ CNAE desc from BrasilAPI (cnae_fiscal_descricao)`);
    } else if (brasilApiResult?.main_activity_description) {
      result.cnaeDescricao = brasilApiResult.main_activity_description;
      console.debug(`[Consolidation] ✅ CNAE desc from BrasilAPI (main_activity_description)`);
    } else if (receitaWsResult?.cnae_descricao) {
      result.cnaeDescricao = receitaWsResult.cnae_descricao;
      console.debug(`[Consolidation] ✅ CNAE desc from ReceitaWS`);
    } else if (receitaWsResult?.atividade_principal?.[0]?.text) {
      result.cnaeDescricao = receitaWsResult.atividade_principal[0].text;
      console.debug(`[Consolidation] ✅ CNAE desc from ReceitaWS (atividade_principal)`);
    }

    // Porte: BrasilAPI > ReceitaWS (try all field names)
    if (brasilApiResult?.porte) {
      result.porte = brasilApiResult.porte;
      console.debug(`[Consolidation] ✅ Porte from BrasilAPI`);
    } else if (brasilApiResult?.legal_nature) {
      result.porte = determineCompanySize(
        brasilApiResult.legal_nature,
        String(brasilApiResult.capital_social || "0"),
      );
    } else if (brasilApiResult?.natureza_juridica) {
      result.porte = determineCompanySize(
        brasilApiResult.natureza_juridica,
        String(brasilApiResult.capital_social || "0"),
      );
    } else if (receitaWsResult?.porte) {
      result.porte = receitaWsResult.porte;
      console.debug(`[Consolidation] ✅ Porte from ReceitaWS`);
    }

    return result;
  } catch (err) {
    console.error(`[Consolidation ERROR] ${err instanceof Error ? err.message : "Unknown"}`);
    return {};
  }
}

// 🔥 MAIN LOOKUP: Tries all methods in sequence with SerpAPI first
async function lookupCNPJ(
  phone: string,
  name: string,
  city: string,
): Promise<{
  cnpj: string;
  capitalSocial: string;
  situacao?: string;
  dataAbertura?: string;
  porte?: string;
  cnaeDescricao?: string;
}> {
  try {
    // Check cache first
    const cacheKey = `${phone}|${name}|${city}`.toLowerCase();
    const cached = cnpjCache.get(cacheKey);
    if (cached) {
      console.info(`[CACHE HIT] ${name} @ ${city}`);
      return cached;
    }

    console.info(`[CNPJ LOOKUP] Trying for: ${name} @ ${city}`);

    // Method 0: SerpAPI (Google Search API - most reliable for unregistered)
    console.info(`  └─ Method 0: SerpAPI (Google Search API)...`);
    let result = await searchCNPJViaSerpAPI(name, city);
    if (result && result.cnpj !== "N/A") {
      console.info(`  ✅ Found via SerpAPI: ${result.cnpj}`);
      // 🔥 NEW: Consolidate with mandatory fallback between BrasilAPI and ReceitaWS
      const enrichment = await consolidateCNPJDataWithFallback(result.cnpj);
      result.capitalSocial = enrichment.capitalSocial || result.capitalSocial;
      result.situacao = enrichment.situacao || result.situacao;
      result.dataAbertura = enrichment.dataAbertura || result.dataAbertura;
      result.porte = enrichment.porte || result.porte;
      result.cnaeDescricao = enrichment.cnaeDescricao || result.cnaeDescricao;
      cnpjCache.set(cacheKey, result);
      return result;
    }

    // Method 1: ReceitaWS (fastest, good coverage)
    console.info(`  └─ Method 1: ReceitaWS...`);
    result = await searchCNPJViaReceitaWS(name, city);
    if (result && result.cnpj !== "N/A") {
      console.info(`  ✅ Found via ReceitaWS: ${result.cnpj}`);
      // 🔥 NEW: Ensure fallback if ReceitaWS data is incomplete
      if (!result.situacao) {
        const enrichment = await consolidateCNPJDataWithFallback(result.cnpj);
        result.situacao = enrichment.situacao || result.situacao;
        result.dataAbertura = enrichment.dataAbertura || result.dataAbertura;
        result.porte = enrichment.porte || result.porte;
        result.cnaeDescricao = enrichment.cnaeDescricao || result.cnaeDescricao;
      }
      cnpjCache.set(cacheKey, result);
      return result;
    }

    // Method 2: BrasilAPI (better coverage than ReceitaWS)
    console.info(`  └─ Method 2: BrasilAPI...`);
    result = await searchCNPJViaBrasilAPI(name);
    if (result && result.cnpj !== "N/A") {
      console.info(`  ✅ Found via BrasilAPI: ${result.cnpj}`);
      cnpjCache.set(cacheKey, result);
      return result;
    }

    // Method 3: Google Search (last resort scraping)
    console.info(`  └─ Method 3: Google Search...`);
    result = await searchCNPJViaGoogle(name, city);
    if (result && result.cnpj !== "N/A") {
      console.info(`  ✅ Found via Google: ${result.cnpj}`);
      cnpjCache.set(cacheKey, result);
      return result;
    }

    // Method 4: CNPJA (premium fallback if key configured)
    console.info(`  └─ Method 4: CNPJA (premium API)...`);
    const cnpjaKey = process.env.CNPJA_KEY || "43a76ea4-a463-44f9-899e-374746ae048b-8149b5da-dfff-4de5-bee7-68946deff296";
    if (cnpjaKey && cnpjaKey.length > 20) {
      // Try to extract CNPJ from name if it looks like one
      const cnpjMatch = name.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/);
      if (cnpjMatch) {
        result = await searchCNPJViaCNPJA(cnpjMatch[0]);
        if (result && result.cnpj !== "N/A") {
          console.info(`  ✅ Found via CNPJA: ${result.cnpj}`);
          cnpjCache.set(cacheKey, result);
          return result;
        }
      }
    } else {
      console.info(`  └─ CNPJA Key not configured, skipping`);
    }

    // All methods failed
    console.info(`  ❌ Not found in any database`);
    const notFound = { cnpj: "N/A", capitalSocial: "N/A" };
    cnpjCache.set(cacheKey, notFound);
    return notFound;
  } catch (err) {
    console.error(
      `[CNPJ LOOKUP ERROR] ${err instanceof Error ? err.message : err}`,
    );
    return { cnpj: "N/A", capitalSocial: "N/A" };
  }
}

// 🔥 NEW: Mandatory enrichment via BrasilAPI to extract CNAE code
async function enrichWithBrasilAPICNAE(
  cnpj: string,
): Promise<{
  cnae?: string;
}> {
  try {
    if (!cnpj || cnpj === "N/A") {
      return {};
    }

    const cnpjClean = normalizeCNPJ(cnpj);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://brasilapi.com.br/api/cnpj/v1/${cnpjClean}`,
      {
        headers: { "User-Agent": "LeadHunter/2.0" },
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      return {};
    }

    const data = (await response.json()) as {
      cnae?: string;
      main_cnae?: string;
    };

    const cnaeCode = data.cnae || data.main_cnae;
    if (cnaeCode) {
      return { cnae: cnaeCode };
    }

    return {};
  } catch (err) {
    console.debug(
      `[BRASILAPI ENRICHMENT] ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    return {};
  }
}

// ==================== 🔥 PROFESSIONAL ENRICHMENT FUNCTIONS ====================

/**
 * Normaliza texto: remove acentos, pontuação, normaliza espaços
 * Usa NFD decomposition para melhor detecção de acentos
 */
function normalizeText(str?: string | null): string {
  if (!str) return "";
  try {
    return String(str)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // Remove acentos
      .replace(/[^\w\s]/g, " ") // Remove pontuação
      .replace(/\s+/g, " ") // Normaliza múltiplos espaços
      .trim()
      .toLowerCase();
  } catch {
    return String(str).toLowerCase().trim();
  }
}

/**
 * Mapeamento oficial CNAE 2.3 (IBGE) - Prefixos de 2 dígitos para segmentos principais
 */
const CNAE_OFFICIAL_MAP: { [key: string]: string } = {
  // Agricultura, Pecuária, Produção Florestal
  "01": "Agricultura",
  "02": "Pecuária",
  "03": "Produção Florestal",
  "05": "Pesca",

  // Indústria de Transformação
  "10": "Indústria Alimentícia",
  "11": "Fabricação de Bebidas",
  "12": "Fabricação de Produtos de Fumo",
  "13": "Fabricação de Produtos Têxteis",
  "14": "Confecção de Artigos de Vestuário",
  "15": "Preparação, Curtimento de Couro",
  "16": "Fabricação de Produtos de Madeira",
  "17": "Fabricação de Celulose e Papel",
  "18": "Impressão e Reprodução",
  "19": "Fabricação de Produtos de Petróleo",
  "20": "Fabricação de Produtos Químicos",
  "21": "Fabricação de Produtos Farmacêuticos",
  "22": "Fabricação de Borracha e Plástico",
  "23": "Fabricação de Produtos de Minerais Não Metálicos",
  "24": "Metalurgia",
  "25": "Fabricação de Produtos de Metal",
  "26": "Fabricação de Equipamentos Informáticos",
  "27": "Fabricação de Máquinas e Equipamentos Elétricos",
  "28": "Fabricação de Máquinas e Equipamentos",
  "29": "Fabricação de Veículos Automotores",
  "30": "Fabricação de Outros Equipamentos de Transporte",
  "31": "Fabricação de Móveis",
  "32": "Fabricação de Produtos Diversos",
  "33": "Manutenção, Reparação e Instalação",

  // Fornecimento de Eletricidade
  "35": "Fornecimento de Eletricidade e Gás",

  // Construção
  "41": "Construção de Edifícios",
  "42": "Obras de Infraestrutura",
  "43": "Serviços Especializados de Construção",

  // Comércio; Manutenção e Reparação
  "45": "Comércio e Reparação de Veículos Automotores",
  "46": "Comércio Atacadista",
  "47": "Comércio Varejista",

  // Transporte, Armazenagem
  "49": "Transporte Terrestre",
  "50": "Transporte Aquaviário",
  "51": "Transporte Aéreo",
  "52": "Armazenagem e Atividades Auxiliares",
  "53": "Atividades Correios",

  // Alojamento e Alimentação
  "55": "Alojamento",
  "56": "Alimentação e Bebidas",

  // Informação e Comunicação
  "58": "Edição e Edição Integrada",
  "59": "Atividades Audiovisuais",
  "60": "Atividades de Rádio",
  "61": "Telecomunicações",
  "62": "Atividades de Tecnologia da Informação",
  "63": "Atividades de Prestação de Serviços de Informação",

  // Atividades Financeiras, de Seguros
  "64": "Atividades de Serviços Financeiros",
  "65": "Seguros",
  "66": "Atividades Auxiliares de Serviços Financeiros",

  // Atividades Imobiliárias
  "68": "Atividades Imobiliárias",

  // Atividades Profissionais, Científicas
  "69": "Atividades Jurídicas, Consultoria",
  "70": "Atividades de Sedes de Empresas",
  "71": "Serviços de Arquitetura e Engenharia",
  "72": "Pesquisa e Desenvolvimento",
  "73": "Publicidade e Pesquisa de Mercado",
  "74": "Atividades Especializadas de Serviços",
  "75": "Atividades Veterinárias",

  // Atividades Administrativas
  "77": "Atividades de Aluguel",
  "78": "Seleção, Colocação de Pessoal",
  "79": "Atividades de Agências de Viagem",
  "80": "Atividades de Investigação e Segurança",
  "81": "Serviços para Edifícios",
  "82": "Atividades de Apoio Administrativo",

  // Administração Pública, Segurança
  "84": "Administração Pública e Defesa",
  "85": "Educação",
  "86": "Atividades de Atenção à Saúde",
  "87": "Atividades de Assistência Social",

  // Artes, Cultura, Esportes
  "90": "Atividades Criativas, Artísticas e Literárias",
  "91": "Atividades de Bibliotecas e Museus",
  "92": "Atividades Desportivas e de Diversão",
  "93": "Atividades de Organizações Associativas",
};

/**
 * Palavras-chave para classificação heurística complementar (refinement final)
 */
const SEGMENT_KEYWORDS: { [key: string]: string[] } = {
  Farmácia: ["farmacias", "drogaria", "farmaceutico", "medicamento", "remedio"],
  Restaurante: [
    "restaurante",
    "lanchonete",
    "bar",
    "bistro",
    "pizzaria",
    "churrascaria",
    "alimentacao",
    "fast food",
    "delivery",
    "buffet",
  ],
  Supermercado: [
    "supermercado",
    "hipermercado",
    "mercado",
    "mercearia",
    "hortifruti",
  ],
  TI: [
    "software",
    "desenvolvimento",
    "programa de computador",
    "aplicativo",
    "plataforma",
    "cloud",
    "saas",
    "data center",
    "tecnologia",
  ],
  Contabilidade: ["contabilidade", "contador", "escritorio contabil"],
  Transporte: ["transporte", "logistica", "cargas", "fretamento", "taxi"],
  Agro: ["agricultura", "pecuaria", "agropecuaria", "cultivo", "plantio"],
  Educação: ["escola", "colégio", "universidade", "faculdade", "instituto"],
  Saúde: ["hospital", "clinica", "medico", "consultorio", "laboratorio"],
  Advocacia: ["advogado", "advocacia", "juridico", "jurista"],
  Consultoria: [
    "consultoria",
    "consultor",
    "consulting",
    "gestao empresarial",
  ],
};

/**
 * Classifica segmento comercial com múltiplas estratégias em cascata
 * Estratégia 1: CNAE code prefix (mais confiável)
 * Estratégia 2: Heurística de palavras-chave na descrição
 * Estratégia 3: Fallback com seção CNAE
 */
function classifySegmentProfessional(
  cnaeDescricao?: string,
  cnaeCodigo?: string,
): string {
  // Estratégia 1: Classificar por código CNAE (2 primeiros dígitos)
  if (cnaeCodigo) {
    const codeStr = String(cnaeCodigo).replace(/\D/g, "");
    if (codeStr.length >= 2) {
      const prefix2 = codeStr.slice(0, 2);
      if (CNAE_OFFICIAL_MAP[prefix2]) {
        return CNAE_OFFICIAL_MAP[prefix2];
      }
    }
  }

  // Estratégia 2: Heurística de palavras-chave na descrição
  const descNorm = normalizeText(cnaeDescricao);
  if (descNorm) {
    for (const [segmento, keywords] of Object.entries(SEGMENT_KEYWORDS)) {
      for (const palavra of keywords) {
        // Word boundary para evitar falsos positivos
        const re = new RegExp(`\\b${palavra}\\b`, "i");
        if (re.test(descNorm)) {
          return segmento;
        }
      }
    }
  }

  // Estratégia 3: Fallback - retorna a primeira palavra significativa da descrição
  if (descNorm) {
    const tokens = descNorm.split(/\s+/).filter((w) => w.length > 4);
    if (tokens.length > 0) {
      return tokens[0].charAt(0).toUpperCase() + tokens[0].slice(1);
    }
  }

  // Estratégia 4: Fallback final - CNAE com código numérico
  if (cnaeCodigo) {
    return `CNAE ${cnaeCodigo}`;
  }

  return "Diversos";
}

/**
 * Abreviatura profissional do porte com mapeamento conforme APIs
 * Segue padrão IBGE/ReceitaWS/BrasilAPI para consistência
 * 
 * Mapeamento Oficial:
 * - MEI (Microempreendedor Individual)
 * - ME (Microempresa) - até R$ 244mil/ano
 * - EPP (Empresa Pequeno Porte) - R$ 244mil a R$ 2.4mi/ano
 * - EMP (Empresa Média) - acima de R$ 2.4mi/ano
 * - GE (Grande Empresa) - acima de R$ 300mi/ano
 * - LTDA (Limitada) - tipo societário
 * - SA (Sociedade Anônima) - tipo societário
 */
function abbreviatePorteProfessional(porte?: string): string {
  if (!porte) return "N/A";

  const porteNorm = String(porte).trim().toLowerCase();

  // Helper para checagem de palavra com boundary
  const hasWord = (text: string, word: string): boolean => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\b" + escaped + "\\b", "i");
    return re.test(text);
  };

  // Ordem de prioridade: tipo societário primeiro, depois tamanho
  // Tipo Societário (tem precedência)
  if (hasWord(porteNorm, "sociedade anonima") || hasWord(porteNorm, "sociedade anônima")) return "SA";
  if (hasWord(porteNorm, "limitada") || hasWord(porteNorm, "ltda") || hasWord(porteNorm, "ltda.")) return "LTDA";
  if (hasWord(porteNorm, "eireli")) return "EIRELI";
  if (hasWord(porteNorm, "unipessoal")) return "EI";

  // Tamanho (BrasilAPI/ReceitaWS standard)
  if (hasWord(porteNorm, "microempreendedor") || hasWord(porteNorm, "mei") || hasWord(porteNorm, "m.e.i")) return "MEI";
  if (hasWord(porteNorm, "microempresa") || hasWord(porteNorm, "micro")) return "ME";
  if (hasWord(porteNorm, "pequeno") || hasWord(porteNorm, "epp") || hasWord(porteNorm, "e.p.p")) return "EPP";
  if (hasWord(porteNorm, "médio") || hasWord(porteNorm, "medio") || hasWord(porteNorm, "emp")) return "EMP";
  if (hasWord(porteNorm, "grande")) return "GE";

  // Se chegou aqui e tem número de dígitos, retorna como "N/A"
  // pois não conseguiu classificar
  return "N/A";
}

/**
 * Valida e normaliza a situação cadastral do CNPJ
 * Apenas retorna valores permitidos: Ativa, Inapta, Baixada ou Nula
 * IMPORTANTE: Nunca deve retornar "Nula" sem que TODAS as APIs (BrasilAPI, ReceitaWS, CNPJA) tenham sido tentadas
 */
function normalizeSituacaoCadastral(situacao?: string | null): string {
  // Only return "Nula" if truly no value found
  if (!situacao || situacao === "" || situacao === "null" || situacao === "N/A") {
    return "Nula";
  }

  const situacaoLower = String(situacao).trim().toLowerCase();

  // 🔥 ATIVA: ReceitaWS retorna "ATIVA", BrasilAPI retorna "ATIVA" ou "descricao_situacao_cadastral"
  if (
    situacaoLower === "ativa" ||
    situacaoLower === "active" ||
    situacaoLower === "registered" ||
    situacaoLower === "regularizado" ||
    situacaoLower === "em funcionamento" ||
    situacaoLower === "em funcionamento normal" ||
    situacaoLower === "funcionando" ||
    situacaoLower.includes("ativa")
  ) {
    console.debug(`[Normalization] Recognized as ATIVA from: "${situacao}"`);
    return "Ativa";
  }

  // 🔥 INAPTA: Reconhece variações de inatividade
  if (
    situacaoLower === "inapta" ||
    situacaoLower === "inactive" ||
    situacaoLower === "suspended" ||
    situacaoLower === "nao_regularizada" ||
    situacaoLower === "não_regularizada" ||
    situacaoLower === "não regularizada" ||
    situacaoLower === "não registrada" ||
    situacaoLower === "cancelada" ||
    situacaoLower === "paralisada" ||
    situacaoLower === "cessada" ||
    situacaoLower === "suspensa" ||
    situacaoLower === "encerrada" || 
    situacaoLower === "cancelada" ||
    situacaoLower.includes("inapta") ||
    situacaoLower.includes("inativa")
  ) {
    console.debug(`[Normalization] Recognized as INAPTA from: "${situacao}"`);
    return "Inapta";
  }

  // 🔥 BAIXADA: Reconhece variações de desativação
  if (
    situacaoLower === "baixada" ||
    situacaoLower === "canceled" ||
    situacaoLower === "dissolved" ||
    situacaoLower === "extinta" ||
    situacaoLower === "extinto" ||
    situacaoLower === "encerrada" ||
    situacaoLower === "cessada" ||
    situacaoLower === "anulada" ||
    situacaoLower === "cancelada" ||
    situacaoLower.includes("baixada") ||
    situacaoLower.includes("desativada") ||
    situacaoLower.includes("fechada")
  ) {
    console.debug(`[Normalization] Recognized as BAIXADA from: "${situacao}"`);
    return "Baixada";
  }

  // If value doesn't match any known status, log and return as-is for inspection
  console.warn(`[Normalization] ⚠️ Unknown situação value: "${situacao}" - will be marked as "Nula"`);
  return "Nula";
}

/**
 * Consolida informações de CNPJ com hierarquia rigorosa
 * Garante que campos críticos nunca sejam N/A
 * Hierarquia: BrasilAPI > ReceitaWS > Fallback
 */
/**
 * Formata CNPJ para padrão oficial
 */
function formatCNPJProfessional(cnpj?: string): string {
  if (!cnpj) return "N/A";
  const cleaned = String(cnpj).replace(/\D/g, "");
  if (cleaned.length !== 14) return "N/A";
  return cleaned.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

/**
 * Formata valor como moeda brasileira
 */
function formatarMoedaProfessional(valor?: string | number): string {
  if (!valor) return "N/A";
  try {
    const num = typeof valor === "string" ? parseFloat(valor.replace(/\D/g, "")) : Number(valor);
    if (isNaN(num) || num === 0) return "N/A";
    return "R$ " + num.toLocaleString("pt-BR", { minimumFractionDigits: 2 });
  } catch {
    return "N/A";
  }
}

/**
 * Classifica faixa de capital social
 */
function classifyCapitalRangeProfessional(valor?: string | number): string {
  if (!valor) return "N/A";
  try {
    const num = typeof valor === "string" ? parseFloat(valor.replace(/\D/g, "")) : Number(valor);
    if (isNaN(num) || num === 0) return "N/A";
    if (num <= 50000) return "Pequeno";
    if (num <= 300000) return "Médio";
    return "Estruturado";
  } catch {
    return "N/A";
  }
}

// 🔥 POST-EXTRACTION ENRICHMENT - Queries BrasilAPI for full CNPJ data
async function queryBrasilAPIForEnrichment(cnpj: string): Promise<{
  situacao?: string;
  dataAbertura?: string;
  cnaeDescricao?: string;
  cnae?: string;
} | null> {
  try {
    const cnpjClean = cnpj.replace(/\D/g, "");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://brasilapi.com.br/api/cnpj/v1/${cnpjClean}`,
      {
        headers: { "User-Agent": "LeadHunter/2.0" },
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.debug(`[BrasilAPI Enrichment] HTTP ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      // Situação cadastral fields
      status?: string;
      situacao_cadastral?: number;
      descricao_situacao_cadastral?: string;
      // Opening date fields
      establishment_opening_date?: string;
      data_inicio_atividade?: string;
      data_da_constituicao?: string;
      // Activity description fields
      main_activity_description?: string;
      cnae_fiscal_descricao?: string;
      // CNAE code fields
      cnae?: string;
      main_cnae?: string;
      cnae_fiscal?: number;
    };

    console.debug(`[BrasilAPI Response] Received data for ${cnpjClean}`);

    // Extract Situação - try all possible fields
    let situacao: string | undefined;
    if (data.descricao_situacao_cadastral) {
      situacao = data.descricao_situacao_cadastral;
      console.debug(`[BrasilAPI] Situação from descricao_situacao_cadastral: ${situacao}`);
    } else if (data.status) {
      situacao = data.status;
      console.debug(`[BrasilAPI] Situação from status: ${situacao}`);
    }

    // Extract Data Abertura - try all possible fields
    let dataAbertura: string | undefined;
    if (data.data_inicio_atividade) {
      dataAbertura = formatOpeningDate(data.data_inicio_atividade);
      console.debug(`[BrasilAPI] Data abertura from data_inicio_atividade: ${dataAbertura}`);
    } else if (data.establishment_opening_date) {
      dataAbertura = formatOpeningDate(data.establishment_opening_date);
      console.debug(`[BrasilAPI] Data abertura from establishment_opening_date: ${dataAbertura}`);
    } else if (data.data_da_constituicao) {
      dataAbertura = formatOpeningDate(data.data_da_constituicao);
      console.debug(`[BrasilAPI] Data abertura from data_da_constituicao: ${dataAbertura}`);
    }

    // Extract CNAE Descrição - try all possible fields
    let cnaeDescricao: string | undefined;
    if (data.cnae_fiscal_descricao) {
      cnaeDescricao = data.cnae_fiscal_descricao;
      console.debug(`[BrasilAPI] CNAE desc from cnae_fiscal_descricao: ${cnaeDescricao}`);
    } else if (data.main_activity_description) {
      cnaeDescricao = data.main_activity_description;
      console.debug(`[BrasilAPI] CNAE desc from main_activity_description: ${cnaeDescricao}`);
    }

    // Extract CNAE Código - ALWAYS return numeric code, never description
    // Priority: cnae > cnae_fiscal > main_cnae
    let cnaeCode: string | undefined;
    if (data.cnae) {
      // cnae can be string or number from BrasilAPI - ensure it's numeric only
      const cleaned = String(data.cnae).replace(/\D/g, "");
      if (cleaned.length >= 4 && cleaned.length <= 7) {
        cnaeCode = cleaned;
        console.debug(`[BrasilAPI] CNAE code from cnae: ${cnaeCode}`);
      }
    } else if (data.cnae_fiscal) {
      // cnae_fiscal is usually numeric
      const cleaned = String(data.cnae_fiscal).replace(/\D/g, "");
      if (cleaned.length >= 4 && cleaned.length <= 7) {
        cnaeCode = cleaned;
        console.debug(`[BrasilAPI] CNAE code from cnae_fiscal: ${cnaeCode}`);
      }
    } else if (data.main_cnae) {
      // main_cnae is numeric
      const cleaned = String(data.main_cnae).replace(/\D/g, "");
      if (cleaned.length >= 4 && cleaned.length <= 7) {
        cnaeCode = cleaned;
        console.debug(`[BrasilAPI] CNAE code from main_cnae: ${cnaeCode}`);
      }
    }

    return {
      situacao,
      dataAbertura,
      cnaeDescricao,
      cnae: cnaeCode,
    };
  } catch (err) {
    console.debug(
      `[BrasilAPI Enrichment Error] ${err instanceof Error ? err.message : "Unknown"}`,
    );
    return null;
  }
}

// 🔥 Queries ReceitaWS for enrichment data
async function queryReceitaWSForEnrichment(cnpj: string): Promise<{
  situacao?: string;
  dataAbertura?: string;
  cnaeDescricao?: string;
  cnae?: string;
} | null> {
  try {
    const cnpjClean = cnpj.replace(/\D/g, "");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://www.receitaws.com.br/v1/cnpj/${cnpjClean}`,
      {
        headers: { "User-Agent": "LeadHunter/2.0" },
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.debug(`[ReceitaWS Enrichment] HTTP ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      status?: string;
      situacao?: string;
      data_da_constituicao?: string;
      cnae_descricao?: string;
      cnae?: string | number;
      atividade_principal?: Array<{ text?: string; code?: string | number }>;
    };

    const situacao = data.status || data.situacao;
    const cnaeDescricao = data.cnae_descricao;
    
    // Extract CNAE code - ALWAYS numeric, never description
    let cnaeCode: string | undefined;
    if (data.cnae) {
      const cleaned = String(data.cnae).replace(/\D/g, "");
      if (cleaned.length >= 4 && cleaned.length <= 7) {
        cnaeCode = cleaned;
        console.debug(`[ReceitaWS] CNAE code from cnae: ${cnaeCode}`);
      }
    } else if (data.atividade_principal?.[0]?.code) {
      const cleaned = String(data.atividade_principal[0].code).replace(/\D/g, "");
      if (cleaned.length >= 4 && cleaned.length <= 7) {
        cnaeCode = cleaned;
        console.debug(`[ReceitaWS] CNAE code from atividade_principal: ${cnaeCode}`);
      }
    }

    return {
      situacao: situacao || undefined,
      dataAbertura: data.data_da_constituicao
        ? formatOpeningDate(data.data_da_constituicao)
        : undefined,
      cnaeDescricao: cnaeDescricao || undefined,
      cnae: cnaeCode || undefined,
    };
  } catch (err) {
    console.debug(
      `[ReceitaWS Enrichment Error] ${err instanceof Error ? err.message : "Unknown"}`,
    );
    return null;
  }
}

// 🔥 Multi-API enrichment with cascading fallback
async function enrichCNPJWithMultipleApisForSheet(cnpj: string): Promise<{
  situacao: string;
  dataAbertura: string;
  cnaeDescricao: string;
  cnae: string;
}> {
  // Attempt 1: BrasilAPI (primary)
  let result = await queryBrasilAPIForEnrichment(cnpj);
  if (result && (result.situacao || result.cnaeDescricao || result.cnae)) {
    console.debug(`[Post-Enrichment] BrasilAPI hit for ${cnpj}`);
    return {
      situacao: result.situacao || "N/A",
      dataAbertura: result.dataAbertura || "N/A",
      cnaeDescricao: result.cnaeDescricao || "N/A",
      cnae: result.cnae || "N/A",
    };
  }

  // Attempt 2: ReceitaWS (fallback)
  result = await queryReceitaWSForEnrichment(cnpj);
  if (result && (result.situacao || result.cnaeDescricao || result.cnae)) {
    console.debug(`[Post-Enrichment] ReceitaWS hit for ${cnpj}`);
    return {
      situacao: result.situacao || "N/A",
      dataAbertura: result.dataAbertura || "N/A",
      cnaeDescricao: result.cnaeDescricao || "N/A",
      cnae: result.cnae || "N/A",
    };
  }

  // No data found
  console.debug(`[Post-Enrichment] No data found for ${cnpj}`);
  return {
    situacao: "N/A",
    dataAbertura: "N/A",
    cnaeDescricao: "N/A",
    cnae: "N/A",
  };
}

// 🔥 POST-EXTRACTION ENRICHMENT STAGE - Professional batch-processing version
async function enrichSheetWithCNPJData(worksheet: ExcelJS.Worksheet): Promise<void> {
  try {
    console.info("[Post-Enrichment] Starting professional sheet enrichment phase...");
    const processedCNPJs = new Set<string>();
    const cnpjsToProcess: Array<{ rowNum: number; cnpj: string }> = [];

    // ========== PHASE 1: Collect CNPJs to process ==========
    console.debug("[Post-Enrichment] Phase 1: Scanning worksheet for CNPJs...");
    for (let rowNum = 2; rowNum <= worksheet.rowCount; rowNum++) {
      const row = worksheet.getRow(rowNum);
      const cnpjCell = row.getCell(6); // Column F: CNPJ
      const cnpjRaw = String(cnpjCell.value || "").trim();

      // Skip empty or invalid entries
      if (!cnpjRaw || cnpjRaw === "N/A" || cnpjRaw === "") {
        continue;
      }

      // Skip duplicates in tracking
      if (processedCNPJs.has(cnpjRaw)) {
        console.debug(`[Post-Enrichment] Duplicate CNPJ detected: ${cnpjRaw} at row ${rowNum}`);
        continue;
      }

      processedCNPJs.add(cnpjRaw);
      cnpjsToProcess.push({ rowNum, cnpj: cnpjRaw });
    }

    console.info(
      `[Post-Enrichment] Found ${cnpjsToProcess.length} unique CNPJs to enrich`,
    );

    if (cnpjsToProcess.length === 0) {
      console.info("[Post-Enrichment] No CNPJs to process, skipping enrichment");
      return;
    }

    // ========== PHASE 2: Batch processing with rate limiting ==========
    console.debug("[Post-Enrichment] Phase 2: Starting batch enrichment (5 concurrent requests)...");
    const BATCH_SIZE = 5; // Concurrent requests
    const BATCH_DELAY = 500; // Delay between batches (ms)

    for (let i = 0; i < cnpjsToProcess.length; i += BATCH_SIZE) {
      const batch = cnpjsToProcess.slice(i, i + BATCH_SIZE);

      // Process batch in parallel
      const batchResults = await Promise.all(
        batch.map(async ({ rowNum, cnpj }) => {
          try {
            const enriched = await enrichCNPJWithMultipleApisForSheet(cnpj);
            return { rowNum, cnpj, enriched, error: null };
          } catch (err) {
            console.warn(`[Post-Enrichment] Error enriching CNPJ ${cnpj}:`, err);
            return {
              rowNum,
              cnpj,
              enriched: null,
              error: err instanceof Error ? err.message : "Unknown error",
            };
          }
        }),
      );

      console.debug(
        `[Post-Enrichment] Processed batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(cnpjsToProcess.length / BATCH_SIZE)}`,
      );

      // ========== PHASE 3: Update worksheet with enriched data ==========
      for (const result of batchResults) {
        if (result.error) {
          console.debug(`[Post-Enrichment] Skipping row ${result.rowNum} due to error: ${result.error}`);
          continue;
        }

        if (!result.enriched) continue;

        const row = worksheet.getRow(result.rowNum);

        // Column B (index 2): Telefone - Keep existing if present
        const teleCell = row.getCell(2);
        if (!teleCell.value || teleCell.value === "N/A") {
          // Could extract from BrasilAPI if available
        }

        // Column C (index 3): Cidade - Keep existing if present
        const cityCell = row.getCell(3);
        if (!cityCell.value || cityCell.value === "N/A") {
          // Could extract from BrasilAPI if available
        }

        // Column D (index 4): Segmento Comercial - Refine with professional classification
        const segmCell = row.getCell(4);
        if (!segmCell.value || segmCell.value === "N/A") {
          const professionalSegment = classifySegmentProfessional(
            result.enriched.cnaeDescricao,
            result.enriched.cnae,
          );
          if (professionalSegment !== "Diversos") {
            segmCell.value = professionalSegment;
          }
        }

        // Column F (index 6): CNPJ - Format professionally
        const cnpjFormattedCell = row.getCell(6);
        cnpjFormattedCell.value = formatCNPJProfessional(result.cnpj);

        // Column G (index 7): Situação - Update if empty
        const situacaoCell = row.getCell(7);
        if (!situacaoCell.value || situacaoCell.value === "N/A") {
          if (result.enriched.situacao && result.enriched.situacao !== "N/A") {
            situacaoCell.value = result.enriched.situacao;
          }
        }

        // Column H (index 8): Ano Fundação - Update if empty
        const anoCell = row.getCell(8);
        if (!anoCell.value || anoCell.value === "N/A") {
          if (result.enriched.dataAbertura && result.enriched.dataAbertura !== "N/A") {
            anoCell.value = result.enriched.dataAbertura;
          }
        }

        // Column I (index 9): Porte - Abbreviate professionally
        const porteCell = row.getCell(9);
        if (!porteCell.value || porteCell.value === "N/A") {
          // Porte might come from enrichment in future
        } else if (porteCell.value) {
          porteCell.value = abbreviatePorteProfessional(String(porteCell.value));
        }

        // Column J (index 10): CNAE Descrição - Update if empty
        const cnaeDescCell = row.getCell(10);
        if (!cnaeDescCell.value || cnaeDescCell.value === "N/A") {
          if (result.enriched.cnaeDescricao && result.enriched.cnaeDescricao !== "N/A") {
            cnaeDescCell.value = result.enriched.cnaeDescricao;
          }
        }

        // Column K (index 11): Capital Social - Format professionally
        const capitalCell = row.getCell(11);
        if (capitalCell.value && capitalCell.value !== "N/A") {
          capitalCell.value = formatarMoedaProfessional(String(capitalCell.value));
        }

        // Column L (index 12): Faixa Capital - Classify professionally
        const faixaCell = row.getCell(12);
        if (capitalCell.value && capitalCell.value !== "N/A") {
          faixaCell.value = classifyCapitalRangeProfessional(String(capitalCell.value));
        }

        // Column M (index 13): CNAE Código - Update if empty
        const cnaeCodeCell = row.getCell(13);
        if (!cnaeCodeCell.value || cnaeCodeCell.value === "N/A") {
          if (result.enriched.cnae && result.enriched.cnae !== "N/A") {
            cnaeCodeCell.value = result.enriched.cnae;
          }
        }
      }

      // Rate limiting between batches
      if (i + BATCH_SIZE < cnpjsToProcess.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }

    console.info(
      `[Post-Enrichment] ✅ Successfully enriched ${processedCNPJs.size} unique CNPJs`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[Post-Enrichment] Warning during enrichment: ${errorMsg}`);
    // Continue anyway - enrichment is optional enhancement
  }
}

// 🔥 Extract city from full address (e.g., "Rua X, 123, São Paulo, SP" → "São Paulo")
function extractCityFromAddress(address: string): string {
  if (!address || address === "N/A") return "N/A";

  let text = String(address).trim();

  // Step 1: Remove CEP patterns (XXXXX-XXX or XXXXX XXX or XXXXX.XXX)
  text = text.replace(/\d{5}[\s\-.]?\d{3}/g, "").trim();

  // Step 2: Remove trailing comma if present after CEP removal
  text = text.replace(/,\s*$/, "").trim();

  // Step 3: Remove " - STATE" pattern at the end (e.g., " - RO", " - SP")
  text = text.replace(/\s*-\s*[A-Z]{2}\s*$/i, "").trim();

  // Step 4: Split by comma and get all parts
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p);

  // Step 5: Extract the last meaningful part (usually the city)
  // In Brazilian addresses: "Rua, Número - Bairro, CIDADE"
  if (parts.length > 0) {
    const candidate = parts[parts.length - 1].trim();

    // Validate: must have letters, reasonable length, not all numbers
    if (
      candidate &&
      candidate.length > 2 &&
      candidate.length < 100 &&
      /[a-zA-Z]/.test(candidate) && // Must contain letters
      !/^\d+[\s\-\.]*\d*$/.test(candidate) // Not just numbers
    ) {
      return candidate;
    }
  }

  return "N/A";
}

// 🔥 Identify commercial segment from company name
/**
 * Extrai o segmento comercial diretamente do termo de busca do Maps
 * Ex: "clinicas esteticas em ouro preto do oeste" → "clinicas esteticas"
 * Ex: "farmacias em ji-paraná" → "farmacias"
 */
function extractSegmentFromSearchTerm(searchTerm: string): string {
  if (!searchTerm || searchTerm.trim() === "") return "N/A";

  try {
    // Normaliza espaços
    const normalized = searchTerm.trim().toLowerCase();
    
    // Procura por " em " como separador (padrão de busca no Maps)
    const patterns = [
      /^(.+?)\s+em\s+/i,  // Tudo antes de " em "
      /^(.+?)\s+no\s+/i,  // Tudo antes de " no "
      /^(.+?)\s+na\s+/i,  // Tudo antes de " na "
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match && match[1]) {
        return match[1]
          .trim()
          .split(/\s+/)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
      }
    }

    // Fallback: retorna o termo inteiro se não encontrar separador
    return normalized
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  } catch {
    return "N/A";
  }
}

// 🔥 SIMPLIFIED: Use normal Excel workbook instead of streaming (avoid Node.js Buffer issues)
async function initializeExcel(searchTerm: string): Promise<{
  workbook: ExcelJS.Workbook;
  filePath: string;
  worksheet: ExcelJS.Worksheet;
  leads: Lead[];
}> {
  try {
    console.log("📋 Iniciando Excel para:", searchTerm);
    const documents = app.getPath("documents");
    const leadsFolder = path.join(documents, "Leads-Hunted");

    // Create folder if it doesn't exist
    if (!fs.existsSync(leadsFolder)) {
      fs.mkdirSync(leadsFolder, { recursive: true });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, -5);
    const filename = `LeadHunter_${searchTerm
      .slice(0, 20)
      .replace(/[^a-zA-Z0-9]/g, "_")}_${timestamp}.xlsx`;
    const filePath = path.join(leadsFolder, filename);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Leads Consolidados");

    worksheet.columns = [
      { header: "Nome", key: "name", width: 30 },
      { header: "Telefone", key: "phone", width: 18 },
      { header: "Cidade", key: "city", width: 20 },
      { header: "Segmento Comercial", key: "commercialSegment", width: 30 },
      { header: "Nota", key: "rating", width: 10 },
      { header: "CNPJ", key: "cnpj", width: 18 },
      { header: "Situação", key: "situacao", width: 15 },
      { header: "Ano Fundação", key: "dataAbertura", width: 15 },
      { header: "Porte", key: "porte", width: 12 },
      { header: "CNAE", key: "cnaeDescricao", width: 35 },
      { header: "Capital Social", key: "capitalSocial", width: 18 },
      { header: "Faixa Capital", key: "faixaCapitalSocial", width: 15 },
      { header: "Score", key: "score", width: 10 },
    ];

    // 🔥 PROFESSIONAL FORMATTING: Header style (blue background, white text)
    try {
      const headerRow = worksheet.getRow(1);

      // Format each header cell properly using column index
      worksheet.columns.forEach((_col, colIndex) => {
        const cell = headerRow.getCell(colIndex + 1);

        // Set fill color (blue background) - use pattern fill type
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF104E8B" }, // Dark blue
        } as any; // Use any to bypass strict typing

        // Set font (white, bold)
        cell.font = {
          bold: true,
          color: { argb: "FFFFFFFF" }, // White
          size: 11,
        };

        // Set borders
        cell.border = {
          top: { style: "thin" as const, color: { argb: "FF000000" } },
          bottom: { style: "thin" as const, color: { argb: "FF000000" } },
          left: { style: "thin" as const, color: { argb: "FF000000" } },
          right: { style: "thin" as const, color: { argb: "FF000000" } },
        };

        // Set alignment
        (cell.alignment as any) = {
          horizontal: "center",
          vertical: "middle",
          wrapText: true,
        };
      });

      // Set row height for header
      headerRow.height = 25;
    } catch (formatError: unknown) {
      const msg =
        formatError instanceof Error
          ? formatError.message
          : "Unknown formatting error";
      console.error("❌ Erro ao formatar headers:", msg);
      // Continue anyway - formatting is not critical
    }

    console.log("✅ Excel inicializado com sucesso, arquivo:", filePath);
    return { workbook, filePath, worksheet, leads: [] };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ ERRO ao inicializar Excel:", msg);
    console.error(
      "Stack trace:",
      error instanceof Error ? error.stack : "No stack",
    );
    throw error;
  }
}

async function saveExcel(
  workbook: ExcelJS.Workbook,
  filePath: string,
): Promise<void> {
  await workbook.xlsx.writeFile(filePath);
}

async function scrapeGoogleMaps(searchTerm: string, maxResults: number) {
  let page: Page | null = null;
  let context: BrowserContext | null = null;

  // 🔥 SIMPLIFIED: Use normal workbook
  console.log("⏳ Chamando initializeExcel para:", searchTerm);
  sendLog("info", "⏳ Inicializando arquivo Excel...");

  const {
    workbook,
    filePath,
    worksheet,
    leads: collectedLeads,
  } = await initializeExcel(searchTerm);

  console.log("✅ initializeExcel completado, arquivo:", filePath);
  sendLog("success", "✅ Arquivo Excel pronto");

  // 🔥 Deduplication with Sets (memory efficient)
  const seenUrls = new Set<string>();
  const seenIdentifiers = new Set<string>();

  try {
    sendLog("info", "🚀 Iniciando navegador otimizado...");
    sendLog("info", "⏳ Aguardando Chromium iniciar...");

    // 🔥 PERFORMANCE: Force headless mode (optimized Chromium)
    browser = await chromium.launch({
      headless: true,
      timeout: 60000, // 60 segundos para iniciar
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
      ],
    });

    sendLog("success", "✅ Chromium iniciado");
    sendLog("info", "⏳ Criando contexto do navegador...");

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });

    sendLog("success", "✅ Contexto criado");
    sendLog("info", "⏳ Abrindo página...");

    page = await context.newPage();

    sendLog("success", "✅ Página aberta");
    sendLog("info", "⏳ Configurando bloqueio de recursos...");

    // 🔥 PERFORMANCE: Block ALL unnecessary resources
    await page.route("**/*", (route) => {
      const resourceType = route.request().resourceType();
      const blockedTypes = ["image", "stylesheet", "font", "media", "other"];

      if (blockedTypes.includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    sendLog("info", "🌐 Navegador iniciado (modo ultra-otimizado)");

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    sendLog("info", `📍 Acessando: ${searchUrl}`);

    sendLog("info", "⏳ Navegando para Google Maps...");
    const pageStartTime = Date.now();

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000, // Aumentado para 60 segundos
    });

    const pageLoadTime = Date.now() - pageStartTime;
    sendLog("success", `✅ Página carregada em ${pageLoadTime}ms`);

    sendLog("info", "⏳ Aguardando JS executar...");
    await page.waitForTimeout(3000); // Dar mais tempo para JS carregar

    // 🔥 DEBUG: Check what's on the page
    const pageTitle = await page.title();
    sendLog("info", `📄 Título da página: ${pageTitle}`);

    const resultsSelector = 'div[role="feed"]';
    sendLog("info", "🔍 Procurando painel de resultados...");

    try {
      await page.waitForSelector(resultsSelector, { timeout: 8000 });
    } catch (err) {
      // Se não encontrou div[role="feed"], tenta alternativas
      sendLog(
        "warning",
        "⚠️  Seletor principal não encontrado, testando alternativas...",
      );

      // Verificar se Google pediu verificação
      const urlCurrent = page.url();
      sendLog("info", `📍 URL atual: ${urlCurrent}`);

      if (
        urlCurrent.includes("google.com/sorry") ||
        urlCurrent.includes("accounts.google.com")
      ) {
        sendLog(
          "error",
          "❌ ERRO: Google está pedindo verificação (CAPTCHA/Login)",
        );
        sendLog("error", "   Google detectou comportamento de bot");
        sendLog(
          "error",
          "   Recomendação: execute manualmente uma busca a partir do navegador",
        );
        throw new Error(
          "Google bloqueou a requisição - requer verificação humana",
        );
      }

      const alternativeSelectors = [
        "div.Nv2PK",
        "div.a4gq8d",
        'div[class*="place-list"]',
        ".jOjyc",
        'div[jsaction*="click"]',
      ];

      let found = false;
      for (const selector of alternativeSelectors) {
        try {
          sendLog("info", `⏳ Testando ${selector}...`);
          await page.waitForSelector(selector, { timeout: 3000 });
          sendLog("success", `✅ Encontrado seletor alternativo: ${selector}`);
          found = true;
          break;
        } catch {
          sendLog("info", `  ❌ ${selector} - não encontrado`);
        }
      }

      if (!found) {
        sendLog("error", "❌ Nenhum painel de resultados encontrado!");
        sendLog("error", "   Possíveis causas:");
        sendLog("error", "   1. Google bloqueou (CAPTCHA/IP)");
        sendLog("error", "   2. Estrutura HTML mudou");
        sendLog("error", "   3. JavaScript não executou");
        throw new Error(
          "Nenhum painel de resultados encontrado. Google Maps pode estar bloqueado ou estrutura mudou.",
        );
      }
    }

    sendLog("success", "✅ Painel encontrado, iniciando scroll...");

    // 🔥 OPTIMIZED SCROLL: Count DOM elements directly
    let scrollAttempts = 0;
    const maxScrollAttempts = 50;
    let previousCount = 0;
    let stagnantScrolls = 0;

    sendLog("info", "⏳ Scrollando para carregar mais resultados...");

    while (scrollAttempts < maxScrollAttempts && isScrapingActive) {
      await page.evaluate((sel) => {
        const panel = document.querySelector(sel);
        if (panel) panel.scrollBy(0, panel.scrollHeight);
      }, resultsSelector);

      await page.waitForTimeout(600); // Faster scroll
      scrollAttempts++;

      // 🔥 FIX: Tentar múltiplos seletores de link
      let currentCount = 0;
      const linkSelectors = [
        'div[role="feed"] > div > div > a',
        'a[href*="/maps/place/"]',
        'a[jsaction*="click"]',
        ".hfpxzc",
        "div.Nv2PK a",
      ];

      for (const selector of linkSelectors) {
        try {
          const count = await page.locator(selector).count();
          if (count > 0) {
            currentCount = count;
            break;
          }
        } catch {
          // Continue to next selector
        }
      }

      sendLog("info", `  📍 Links encontrados: ${currentCount}`);

      if (currentCount > previousCount) {
        previousCount = currentCount;
        stagnantScrolls = 0;
      } else {
        stagnantScrolls++;
      }

      if (stagnantScrolls >= 4 || previousCount >= maxResults) {
        break;
      }
    }

    if (!isScrapingActive) {
      await saveExcel(workbook, filePath);
      sendLog("warning", "⏹️ Extração cancelada");
      return;
    }

    // 🔥 STRATEGY: Extract URLs - Try multiple selectors for compatibility
    let links: any[] = [];
    const linkSelectors = [
      'div[role="feed"] > div > div > a',
      'a[href*="/maps/place/"]',
      "a.hfpxzc",
      "div.Nv2PK a",
      'a[jsaction*="click"]',
    ];

    sendLog("info", "⏳ Extraindo links dos resultados...");

    for (const selector of linkSelectors) {
      try {
        sendLog("info", `  Testando seletor: ${selector}`);
        links = await page.locator(selector).all();
        if (links.length > 0) {
          sendLog(
            "success",
            `✅ Encontrado ${links.length} links com: ${selector}`,
          );
          break;
        }
      } catch (err) {
        sendLog("info", `  ❌ Erro com seletor ${selector}`);
      }
    }

    if (links.length === 0) {
      sendLog("error", "❌ Nenhum link encontrado em nenhum seletor!");
      sendLog(
        "error",
        "O Google Maps pode ter bloqueado a requisição ou mudou a estrutura.",
      );
      sendLog("error", "Detalhes: ");
      const html = await page.content();
      sendLog("error", `  Página tem ${html.length} caracteres`);
      await saveExcel(workbook, filePath);
      return;
    }

    const linkUrls: string[] = [];
    sendLog("info", `📋 Processando ${links.length} links encontrados...`);
    sendLog("info", `📋 Mapeando ${links.length} estabelecimentos...`);
    for (const link of links) {
      try {
        const url = await link.getAttribute("href");
        if (url && url.includes("/maps/")) {
          linkUrls.push(url);
        }
      } catch (err) {
        // Skip invalid links
      }
    }

    const totalAvailable = linkUrls.length;
    sendLog("success", `✅ ${totalAvailable} estabelecimentos mapeados`);
    win?.webContents.send("scrape:total-found", { totalFound: totalAvailable });

    let extractedCount = 0;

    for (
      let i = 0;
      i < linkUrls.length && extractedCount < maxResults && isScrapingActive;
      i++
    ) {
      try {
        // 🔥 EXTREME SAFETY: Wrap entire iteration in try-catch
        if (!isScrapingActive) break;
        if (!page || page.isClosed()) break;

        // 🔥 EPHEMERAL CONTEXT: Restart every N requests to free memory
        extractionCounter++;
        if (
          extractionCounter % CONTEXT_RESTART_INTERVAL === 0 &&
          context &&
          page
        ) {
          sendLog("info", "♻️ Reiniciando contexto do navegador...");
          await page.close();
          await context.close();

          context = await browser!.newContext({
            viewport: { width: 1920, height: 1080 },
          });
          page = await context.newPage();

          // Re-apply resource blocking
          await page.route("**/*", (route) => {
            const resourceType = route.request().resourceType();
            if (
              ["image", "stylesheet", "font", "media", "other"].includes(
                resourceType,
              )
            ) {
              route.abort();
            } else {
              route.continue();
            }
          });

          // 🔥 ANTI-BOT: Return to results page naturally
          await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(1500 + Math.random() * 500); // Random delay

          // Scroll to approximate position where we left off
          const feedSelector = 'div[role="feed"]';
          const scrollPosition = Math.floor(i / 10) * 500; // Approximate scroll per 10 items
          await page
            .locator(feedSelector)
            .evaluate((el: Element, pos: number) => {
              el.scrollTo(0, pos);
            }, scrollPosition);

          await page.waitForTimeout(800 + Math.random() * 400);
          sendLog("info", `♻️ Contexto reiniciado - retomando extração`);
        }

        // 🔥 ANTI-BOT: Try to click naturally on page first, fallback to direct navigation
        const targetUrl = linkUrls[i];
        try {
          // Try to find and click the link on current page
          const linkSelectorsToTry = [
            'div[role="feed"] > div > div > a',
            'a[href*="/maps/place/"]',
            "a.hfpxzc",
            "div.Nv2PK a",
          ];

          let currentLinks: any[] = [];
          for (const selector of linkSelectorsToTry) {
            try {
              const links = await page.locator(selector).all();
              if (links.length > 0) {
                currentLinks = links;
                break;
              }
            } catch {
              // Try next selector
            }
          }

          let clicked = false;

          for (let j = 0; j < currentLinks.length; j++) {
            try {
              const href = await currentLinks[j].getAttribute("href");
              if (href === targetUrl) {
                // Add random delay before click (human-like)
                await page.waitForTimeout(300 + Math.random() * 700);
                await currentLinks[j].evaluate((el: HTMLElement) => el.click());
                clicked = true;
                break;
              }
            } catch {
              // Skip if error getting href
            }
          }

          // Fallback: Direct navigation only if link not found on page
          if (!clicked) {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          }
        } catch (err) {
          // Error clicking: fallback to direct navigation
          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        }

        await page!.waitForTimeout(600 + Math.random() * 400); // Random delay

        // 🔥 EXTREME SAFETY: Validate page state before extraction
        if (!page || page.isClosed()) {
          continue;
        }

        const url = page!.url();
        if (seenUrls.has(url)) continue;

        // 🔥 SPEED: Extract ALL data in ONE evaluate call (10x faster) with NULL SAFETY
        const leadData = await page!.evaluate(() => {
          // 🔥 EXTREME SAFETY: Return null if anything fails
          try {
            const getName = () => {
              try {
                const elem = document.querySelector("h1.DUwDvf");
                const text = elem?.textContent?.trim();
                if (!text) return "N/A";
                return text;
              } catch {
                return "N/A";
              }
            };

            const getRating = () => {
              try {
                const elem = document.querySelector(
                  'div.F7nice span[role="img"]',
                );
                const aria = elem?.getAttribute("aria-label");
                if (!aria) return "0";  // Rating não encontrado = 0, não N/A
                const match = aria.match(/[\d,.]+/);
                return match && match[0] ? match[0] : "0";
              } catch {
                return "0";  // Erro na extração = 0, não N/A
              }
            };

            const getPhone = () => {
              try {
                const elem = document.querySelector(
                  'button[data-item-id*="phone:tel:"]',
                );
                const text = elem?.textContent?.trim();
                if (!text) return "N/A";
                return text;
              } catch {
                return "N/A";
              }
            };

            const getCity = () => {
              try {
                // 🔥 Try multiple selectors for address
                let addressText = null;

                // Try 1: Primary selector for address button
                let elem = document.querySelector(
                  'button[data-item-id^="address"]',
                );
                if (elem?.textContent) {
                  addressText = elem.textContent.trim();
                }

                // Try 2: Alternative selector - address div
                if (!addressText) {
                  elem = document.querySelector(
                    'div[role="region"] button[aria-label*="address"]',
                  );
                  if (elem?.textContent) {
                    addressText = elem.textContent.trim();
                  }
                }

                // Try 3: Look for any button with full address pattern
                if (!addressText) {
                  const buttons = document.querySelectorAll("button");
                  for (const btn of buttons) {
                    const text = btn.textContent?.trim() || "";
                    // Address usually has street, number, city or comma-separated parts
                    if (
                      text &&
                      text.length > 10 &&
                      text.length < 200 &&
                      (text.includes(",") || /\d+/.test(text))
                    ) {
                      // Check if it looks like an address (has street, number, city markers)
                      if (
                        /rua|av\.|avenida|praça|pç|trav|rod|estrada|rota|alameda|passagem|beco|travessa|lote|lc|apt|apto|apart|sala|lj|piso|andar/i.test(
                          text,
                        ) ||
                        (/^\d+/.test(text.trim().split(",")[0]) === false &&
                          /[a-záéíóúãõçñ]/i.test(text))
                      ) {
                        addressText = text;
                        break;
                      }
                    }
                  }
                }

                // Try 4: Search in spans with address-like content
                if (!addressText) {
                  const spans = document.querySelectorAll(
                    "span[role='text'], span.webnc",
                  );
                  for (const span of spans) {
                    const text = span.textContent?.trim() || "";
                    if (
                      text &&
                      text.length > 10 &&
                      text.length < 200 &&
                      /,/.test(text) &&
                      /[a-záéíóúãõçñ]/i.test(text)
                    ) {
                      addressText = text;
                      break;
                    }
                  }
                }

                // Try 5: Last resort - get parent container text
                if (!addressText) {
                  const container = document.querySelector(
                    "div[role='main'], [data-tab-index='0']",
                  );
                  if (container) {
                    const allText = container.textContent || "";
                    // Find address-like patterns in the text
                    const lines = allText.split("\n");
                    for (const line of lines) {
                      const text = line.trim();
                      if (
                        text &&
                        text.length > 10 &&
                        text.length < 200 &&
                        /,/.test(text) &&
                        !text.includes("Qualificação do local")
                      ) {
                        // Check if looks like address
                        if (
                          /rua|avenida|av\.|praça|trav|rod|alameda|estrada|pç|lote|apt|sala|lj/i.test(
                            text,
                          )
                        ) {
                          addressText = text;
                          break;
                        }
                      }
                    }
                  }
                }

                if (!addressText) return "N/A";
                return addressText;
              } catch {
                return "N/A";
              }
            };

            const getCommercialSegment = () => {
              try {
                // Multiple selectors to try for category
                let categoryText = null;

                // Try 1: LBgpef class
                const categoryElem = document.querySelector(".LBgpef");
                if (categoryElem?.textContent) {
                  categoryText = categoryElem.textContent.trim();
                }

                // Try 2: Element with aria-label containing category
                if (!categoryText) {
                  const elems = document.querySelectorAll(
                    '[aria-label*="categori"], [aria-label*="tipo"], [aria-label*="tipo"]',
                  );
                  for (const el of elems) {
                    if (el.textContent && el.textContent.length < 50) {
                      categoryText = el.textContent.trim();
                      break;
                    }
                  }
                }

                // Try 3: Search button children for category
                if (!categoryText) {
                  const searchResults =
                    document.querySelectorAll('div[role="button"]');
                  for (const elem of searchResults) {
                    const text = elem.textContent || "";
                    if (
                      text.length > 5 &&
                      text.length < 50 &&
                      !text.match(/^\d/) &&
                      !text.match(/km$/)
                    ) {
                      categoryText = text.trim();
                      break;
                    }
                  }
                }

                return categoryText || "N/A";
              } catch {
                return "N/A";
              }
            };

            return {
              name: getName(),
              rating: getRating(),
              phone: getPhone(),
              city: getCity(),
              commercialSegment: getCommercialSegment(),
            };
          } catch {
            return null; // 🔥 EXTREME: Return null on ANY error
          }
        });

        // 🔥 EXTREME SAFETY: Skip if evaluation failed
        if (!leadData) {
          continue;
        }

        // 🔥 SAFETY: Validate extracted data
        if (!leadData || !leadData.name || leadData.name === "N/A") {
          continue; // Skip invalid entries
        }

        // 🔥 SAFETY: Ensure all fields are strings
        const safeName = String(leadData.name || "N/A");
        const safePhone = String(leadData.phone || "N/A");
        const safeRating = String(leadData.rating || "N/A");
        const safeAddressRaw = String(leadData.city || "N/A"); // Raw address from Google Maps

        // 🔥 MANDATORY: Reject leads without phone number (requirement)
        if (!safePhone || safePhone === "N/A") {
          console.debug(`[Extraction] Rejecting lead without phone: ${safeName}`);
          continue; // Skip entirely - no CNPJ lookup, no processing
        }

        // 🔥 PROCESSING: Extract city from full address
        const safeCity = extractCityFromAddress(safeAddressRaw);

        // 🔥 NEW: Extract segment DIRECTLY from search term (not from company name)
        const safeCommercialSegment = extractSegmentFromSearchTerm(searchTerm);

        const identifier = `${safeName}_${safePhone}`;
        if (seenIdentifiers.has(identifier)) continue;

        seenUrls.add(url);
        seenIdentifiers.add(identifier);
        extractedCount++;

        // 🔥 HYBRID CNPJ LOOKUP: Try ReceitaWS → BrasilAPI → Google Search
        sendLog(
          "info",
          `🔍 [${extractedCount}] Buscando CNPJ para: ${safeName} (${safeCity})...`,
        );
        const companyData = await lookupCNPJ(safePhone, safeName, safeCity);

        // Log result
        if (companyData.cnpj !== "N/A") {
          sendLog("success", `  ✅ CNPJ encontrado: ${companyData.cnpj}`);
          if (companyData.capitalSocial !== "N/A") {
            sendLog(
              "success",
              `  💰 Capital Social: ${companyData.capitalSocial}`,
            );
          }
        } else {
          sendLog(
            "warning",
            `  ⚠️ CNPJ não localizado em nenhuma base de dados`,
          );
        }

        // 🔥 NEW: Mandatory enrichment with BrasilAPI to extract CNAE code
        let cnaeCode = "N/A";
        if (companyData.cnpj !== "N/A") {
          const enrichmentData = await enrichWithBrasilAPICNAE(
            companyData.cnpj,
          );
          cnaeCode = enrichmentData.cnae || "N/A";
        }

        // 🔥 NEW: Ensure situação is properly normalized (ONLY after trying both APIs via consolidation)
        // At this point, companyData.situacao should already have fallback applied via lookupCNPJ
        let normalizedSituacao = "Nula"; // Default fallback
        
        if (companyData.situacao) {
          normalizedSituacao = normalizeSituacaoCadastral(companyData.situacao);
          sendLog("info", `  📋 Situação cadastral: ${normalizedSituacao} (fonte: ${companyData.situacao})`);
        } else {
          sendLog("warning", `  ⚠️ Situação não encontrada em nenhuma API (será marcada como "Nula")`);
        }

        // 🔥 NEW: Validate and ensure dataAbertura is never empty
        let dataAberturaFinal = companyData.dataAbertura || "N/A";
        if (dataAberturaFinal === "N/A" || !dataAberturaFinal) {
          // If no opening date found, use current year as final fallback
          dataAberturaFinal = new Date().getFullYear().toString();
        }

        const lead = {
          id: `lead_${Date.now()}_${extractedCount}`,
          name: safeName,
          rating: safeRating,
          phone: safePhone,
          city: safeCity,
          commercialSegment: safeCommercialSegment,
          cnpj: companyData.cnpj,
          capitalSocial: companyData.capitalSocial,
          situacao: normalizedSituacao,
          dataAbertura: dataAberturaFinal,
          porte: companyData.porte || "N/A",
          cnaeDescricao: companyData.cnaeDescricao || "N/A",
          faixaCapitalSocial: classifyCapitalRange(companyData.capitalSocial),
          cnae: cnaeCode,
          score: 0, // Will be calculated after
          extractedAt: new Date().toISOString(),
          status: "success" as const,
        };

        // 🔥 Do NOT map CNAE to commercial segment (segment is from search term only)
        // Removed: if (cnaeCode !== "N/A") { const cnaeSegment = ... }

        // 🔥 NEW: Calculate lead quality score
        lead.score = calculateLeadScore(lead);

        // 🔥 BATCH: Accumulate in array
        collectedLeads.push(lead);
        worksheet.addRow({
          name: lead.name,
          phone: lead.phone,
          city: lead.city,
          commercialSegment: lead.commercialSegment,
          rating: lead.rating,
          cnpj: lead.cnpj,
          situacao: lead.situacao,
          dataAbertura: lead.dataAbertura,
          porte: lead.porte,
          cnaeDescricao: lead.cnaeDescricao,
          capitalSocial: lead.capitalSocial,
          faixaCapitalSocial: lead.faixaCapitalSocial,
          score: lead.score,
        });

        win?.webContents.send("scrape:new-lead", lead);
        sendLog(
          "success",
          `✅ Lead ${extractedCount}: ${lead.name} | Cidade: ${lead.city} | CNPJ: ${lead.cnpj}`,
        );
        sendProgress(
          extractedCount,
          linkUrls.length,
          `Extraindo ${extractedCount}/${linkUrls.length}`,
        );
      } catch (error: unknown) {
        // 🔥 BULLETPROOF: Log error but continue extraction
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        sendLog("error", `❌ Erro no item ${i + 1}: ${errorMsg}`);
        // Continue to next item instead of crashing
        continue;
      }
    }

    if (!isScrapingActive) {
      await saveExcel(workbook, filePath);
      sendLog("warning", "⏹️ Extração cancelada");
      return;
    }

    // 🔥 POST-EXTRACTION ENRICHMENT PHASE
    sendLog(
      "info",
      `🔄 Iniciando fase de enriquecimento e validação de dados (pós-extração)...`,
    );
    console.info("[Scrape] Starting post-extraction enrichment phase");

    await enrichSheetWithCNPJData(worksheet);

    sendLog("success", `✅ Enriquecimento de dados concluído`);

    // 🔥 BATCH: Save workbook once at end
    await saveExcel(workbook, filePath);

    sendLog("success", `✨ ${extractedCount} leads salvos em: ${filePath}`);
    sendComplete(extractedCount, filePath);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    sendLog("error", `❌ Erro: ${errorMessage}`);
    sendError(errorMessage);

    // Save workbook even on error
    try {
      await saveExcel(workbook, filePath);
    } catch (err) {
      // Save failed, already logged
    }
  } finally {
    // 🔥 MEMORY: Aggressive cleanup
    if (page) {
      await page.close().catch(() => {});
      page = null;
    }
    if (context) {
      await context.close().catch(() => {});
      context = null;
    }
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }

    // Clear sets to free memory
    seenUrls.clear();
    seenIdentifiers.clear();

    isScrapingActive = false;
    extractionCounter = 0;
  }
}

function createWindow() {
  // Fix preload path for electron-packager (no asar)
  const preloadPath = app.isPackaged
    ? path.join(process.resourcesPath, "app", "dist-electron", "preload.cjs")
    : path.join(__dirname, "../dist-electron/preload.cjs");

  console.log("[Main] Preload path:", preloadPath);
  console.log("[Main] Preload exists:", fs.existsSync(preloadPath));

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    backgroundColor: "#0b1120",
    icon: path.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

function setupIpcHandlers() {
  // 🔥 CRITICAL: Prevent duplicate registration during HMR
  if (handlersRegistered) {
    return;
  }

  // 🔥 CRITICAL: Remove ALL listeners before registering to prevent HMR stacking
  ipcMain.removeAllListeners("window:minimize");
  ipcMain.removeAllListeners("window:close");
  ipcMain.removeAllListeners("scrape:start");
  ipcMain.removeAllListeners("scrape:stop");
  ipcMain.removeAllListeners("open:folder");

  ipcMain.on("window:minimize", () => {
    win?.minimize();
  });

  ipcMain.on("window:close", () => {
    isScrapingActive = false;
    if (browser) {
      browser.close().catch(() => {});
    }
    app.quit();
  });

  ipcMain.on("scrape:start", async (_event, config) => {
    const { searchTerm, maxResults, headless } = config;

    if (isScrapingActive) {
      sendError("Uma extração já está em andamento");
      return;
    }

    if (!searchTerm || searchTerm.trim().length === 0) {
      sendError("Por favor, insira um termo de busca válido");
      return;
    }

    isScrapingActive = true;
    sendLog("info", `🎯 Iniciando extração: "${searchTerm}"`);
    sendLog(
      "info",
      `⚙️ Configurações: Max ${maxResults} resultados, Headless: ${
        headless ? "Sim" : "Não"
      }`,
    );

    await scrapeGoogleMaps(searchTerm, maxResults);
  });

  ipcMain.on("scrape:stop", () => {
    if (isScrapingActive) {
      sendLog("warning", "⏹️ Parando extração...");
      isScrapingActive = false;
      if (browser) {
        browser.close().catch(() => {});
        browser = null;
      }
    }
  });

  ipcMain.on("open:folder", (_event, filePath) => {
    const folderPath = path.dirname(filePath);
    shell.openPath(folderPath);
  });

  // 🔥 DIAGNOSTIC: Check if dependencies are installed
  ipcMain.handle("diagnostic:check", async () => {
    const appDir = app.getAppPath();
    const nodeModulesPath = path.join(appDir, "node_modules");
    const requiredModules = ["playwright", "exceljs", "react"];

    const logs: string[] = [];
    let needsRepair = false;

    // Check if node_modules exists
    if (!fs.existsSync(nodeModulesPath)) {
      logs.push("❌ node_modules não encontrado");
      needsRepair = true;
    } else {
      logs.push("✅ node_modules encontrado");

      // Check critical modules
      for (const mod of requiredModules) {
        const modPath = path.join(nodeModulesPath, mod);
        if (!fs.existsSync(modPath)) {
          logs.push(`❌ Módulo faltando: ${mod}`);
          needsRepair = true;
        } else {
          logs.push(`✅ Módulo presente: ${mod}`);
        }
      }
    }

    return { needsRepair, logs };
  });

  // 🔥 DIAGNOSTIC: Repair by reinstalling dependencies
  ipcMain.handle("diagnostic:repair", async () => {
    const appDir = app.getAppPath();
    const logs: string[] = [];

    return new Promise((resolve) => {
      logs.push("Iniciando npm install...");
      win?.webContents.send("diagnostic:status", {
        message: "Iniciando npm install...",
      });

      const npm = spawn("npm", ["install"], {
        cwd: appDir,
        env: { ...process.env, npm_config_loglevel: "warn" },
      });

      npm.stdout?.on("data", (data) => {
        const message = data.toString().trim();
        if (message && message.length > 0) {
          logs.push(message);
          win?.webContents.send("diagnostic:status", { message });
        }
      });

      npm.stderr?.on("data", (data) => {
        const message = data.toString().trim();
        if (message && message.length > 0) {
          logs.push(`⚠️ ${message}`);
          win?.webContents.send("diagnostic:status", { message });
        }
      });

      npm.on("close", (code) => {
        if (code === 0) {
          logs.push("✅ Dependências reinstaladas com sucesso!");
          logs.push("Reinicie a aplicação para aplicar as alterações");
          win?.webContents.send("diagnostic:status", {
            message: "Installação completa - reinicie o app",
          });
          resolve({ success: true, logs });
        } else {
          logs.push(`❌ Erro ao instalar dependências (código: ${code})`);
          logs.push("Verifique sua conexão com internet e tente novamente");
          resolve({ success: false, logs });
        }
      });
    });
  });

  handlersRegistered = true; // 🔥 Mark as registered
}

// 🔥 EXTREME FIX: Prevent HMR from re-registering handlers
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // Do nothing on HMR - keep existing handlers
  });

  import.meta.hot.dispose(() => {
    // Mark handlers as not registered so they can be re-registered on full restart
    handlersRegistered = false;
  });
}

// 🔥 CRITICAL: Call setup immediately on module load (runs once per Electron process)
if (!handlersRegistered) {
  app.whenReady().then(() => {
    createWindow();
    setupIpcHandlers();
  });

  app.on("window-all-closed", () => {
    isScrapingActive = false;
    if (browser) {
      browser.close().catch(() => {});
    }
    if (process.platform !== "darwin") {
      app.quit();
      win = null;
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}
