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
  if (!legalNature && !capitalSocial) return "N/A";

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
  if (!capitalSocial || capitalSocial === "N/A") return "N/A";

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
function mapCNAEtoSegment(cnae?: string): string {
  if (!cnae || cnae === "N/A") return "Diversos";

  // Normalize CNAE (remove dots and dashes)
  const cnaeClean = String(cnae).toLowerCase().replace(/[^\d]/g, "");

  // CNAE mapping table (first 4 digits are usually sufficient)
  const cnaeMapping: { [key: string]: string } = {
    // Farmácia e drogaria
    "4771": "Farmácia",
    "4773": "Drogaria",

    // Alimentos e bebidas
    "1011": "Abate de Animais",
    "1033": "Preparação de Alimentos",
    "1091": "Produção de Bebidas",
    "4711": "Supermercado",
    "4712": "Padaria",
    "4721": "Açougue",
    "4722": "Peixaria",
    "4729": "Varejo Alimentos",
    "5611": "Restaurante",
    "5612": "Lanchonete",
    "5613": "Bar",

    // Comércio geral
    "4713": "Comércio Bebidas",
    "4761": "Comércio Vestuário",
    "4762": "Comércio Calçados",
    "4763": "Comércio Perfumaria",
    "4781": "Comércio Livros",
    "4782": "Comércio Flores",
    "4789": "Comércio Diversos",

    // Serviços
    "4910": "Transporte Terrestre",
    "4921": "Transporte Ferroviário",
    "4930": "Transporte Aquaviário",
    "5111": "Agências Aéreas",
    "5112": "Serviços Aeroportuários",

    // Saúde
    "6411": "Consultório Médico",
    "6412": "Consultório Dentário",
    "6413": "Consultório Psicologia",
    "6421": "Auxiliar Diagnóstico",
    "6422": "Radiologia",
    "6423": "Análises Clínicas",
    "8111": "Hospital",
    "8520": "Educação",

    // Educação
    "8211": "Ensino Fundamental",
    "8212": "Ensino Médio",
    "8230": "Educação Superior",

    // Construção
    "4100": "Construção",
    "4120": "Construção Residencial",
    "4130": "Preparação Terreno",

    // Imobiliária
    "6810": "Atividades Imobiliária",
    "6821": "Aluguel Imóveis",

    // Transporte
    "4923": "Táxi",
    "4929": "Transporte Passageiros",

    // Distribuidora
    "4613": "Distribuidora Bebidas",
    "4614": "Distribuidora Alimentos",
    "4621": "Distribuição Artigos",
    "4644": "Comércio Atacado Alimentos",
    "4645": "Comércio Atacado Bebidas",

    // Posto de combustível
    "4730": "Comércio Combustíveis",

    // Beleza
    "9601": "Salão de Beleza",
    "9602": "Barbearia",
    "9603": "Estética",

    // Financeira
    "6521": "Seguro",

    // Telecomunicações
    "6110": "Telecomunicações",
    "6130": "Internet Provedora",

    // Energia
    "3511": "Distribuição Energia",
    "3530": "Gás",
  };

  // Try full CNAE first
  for (const [key, value] of Object.entries(cnaeMapping)) {
    if (cnaeClean.startsWith(key)) {
      return value;
    }
  }

  // If no exact match, try first 2 digits
  if (cnaeClean.length >= 2) {
    const shortCnae = cnaeClean.substring(0, 2);
    if (shortCnae.startsWith("41")) return "Construção";
    if (shortCnae.startsWith("46")) return "Comércio Atacado";
    if (shortCnae.startsWith("47")) return "Comércio Varejista";
    if (shortCnae.startsWith("49")) return "Transporte";
    if (shortCnae.startsWith("51")) return "Transporte Serviços";
    if (shortCnae.startsWith("52")) return "Armazenagem";
    if (shortCnae.startsWith("53")) return "Correios";
    if (shortCnae.startsWith("55")) return "Hospedagem";
    if (shortCnae.startsWith("56")) return "Alimentação";
    if (shortCnae.startsWith("58")) return "Publicação";
    if (shortCnae.startsWith("59")) return "Audiovisual";
    if (shortCnae.startsWith("60")) return "Telecomunicações";
    if (shortCnae.startsWith("61")) return "Telecomunicações";
    if (shortCnae.startsWith("62")) return "Tecnologia";
    if (shortCnae.startsWith("63")) return "Serviços Tecnologia";
    if (shortCnae.startsWith("64")) return "Serviços Profissionais";
    if (shortCnae.startsWith("68")) return "Imobiliária";
    if (shortCnae.startsWith("69")) return "Serviços Jurídicos";
    if (shortCnae.startsWith("70")) return "Publicidade";
    if (shortCnae.startsWith("71")) return "Aluguel Equipamentos";
    if (shortCnae.startsWith("72")) return "Pesquisa Desenvolvimento";
    if (shortCnae.startsWith("73")) return "Publicidade";
    if (shortCnae.startsWith("74")) return "Agência Viagem";
    if (shortCnae.startsWith("75")) return "Administração Pública";
    if (shortCnae.startsWith("77")) return "Aluguel Bens";
    if (shortCnae.startsWith("78")) return "Seleção Pessoal";
    if (shortCnae.startsWith("79")) return "Agência Turismo";
    if (shortCnae.startsWith("80")) return "Educação";
    if (shortCnae.startsWith("84")) return "Administração";
    if (shortCnae.startsWith("85")) return "Educação";
    if (shortCnae.startsWith("86")) return "Saúde";
    if (shortCnae.startsWith("87")) return "Assistência Social";
    if (shortCnae.startsWith("90")) return "Artes Cultura";
    if (shortCnae.startsWith("91")) return "Organização Religiosa";
    if (shortCnae.startsWith("92")) return "Atividade Desportiva";
    if (shortCnae.startsWith("93")) return "Atividade Recreativa";
    if (shortCnae.startsWith("94")) return "Organização Profissional";
    if (shortCnae.startsWith("95")) return "Reparo Conservação";
    if (shortCnae.startsWith("96")) return "Serviço Pessoal";
    if (shortCnae.startsWith("97")) return "Serviço Doméstico";
    if (shortCnae.startsWith("99")) return "Atividade Interna";
  }

  return "Diversos";
}

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

  // 1. Situação cadastral (até 10 pontos)
  if (lead.situacao === "Ativa") {
    score += 10;
  }

  // 2. Porte da empresa (até 15 pontos)
  if (lead.porte) {
    if (lead.porte === "MEI") score += 5;
    else if (lead.porte === "ME") score += 8;
    else if (lead.porte === "EPP") score += 12;
    else if (lead.porte === "LTDA" || lead.porte === "SA") score += 15;
  }

  // 3. Capital social (até 25 pontos)
  if (lead.capitalSocial && lead.capitalSocial !== "N/A") {
    const capitalAmount = parseFloat(
      String(lead.capitalSocial)
        .replace(/[^\d.,]/g, "")
        .replace(/\./g, "")
        .replace(",", ".") || "0"
    );

    if (capitalAmount > 0 && capitalAmount <= 50000) score += 6;
    else if (capitalAmount > 50000 && capitalAmount <= 200000) score += 12;
    else if (capitalAmount > 200000 && capitalAmount <= 1000000) score += 18;
    else if (capitalAmount > 1000000) score += 25;
  }

  // 4. Tempo de fundação (até 20 pontos)
  if (lead.dataAbertura && lead.dataAbertura !== "N/A") {
    const year = parseInt(lead.dataAbertura);
    if (!isNaN(year)) {
      const agoDays = new Date().getFullYear() - year;
      if (agoDays <= 1) score += 5;
      else if (agoDays <= 3) score += 10;
      else if (agoDays <= 8) score += 15;
      else score += 20;
    }
  }

  // 5. Telefone (até 15 pontos)
  if (lead.phone && lead.phone !== "N/A" && lead.phone.length > 5) {
    score += 15;
  }

  // 6. Rating Google (até 15 pontos - bonus)
  if (lead.rating) {
    const ratingValue = parseFloat(lead.rating);
    if (ratingValue >= 4.5) score += 15;
    else if (ratingValue >= 4.0) score += 12;
    else if (ratingValue >= 3.5) score += 8;
    else if (ratingValue > 0) score += 5;
  }

  // Cap score at 100
  return Math.min(100, score);
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

// Try ReceitaWS (Method 1)
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
    const data = await response.json();
    if (!data.company?.cnpj) return null;

    const cnpjValue = data.company.cnpj.replace(/\D/g, "");
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
    const details = await detailResponse.json();

    if (details?.cnpj) {
      return {
        cnpj: details.cnpj,
        capitalSocial: details.capital_social
          ? `R$ ${parseFloat(String(details.capital_social)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : "N/A",
      };
    }
    return null;
  } catch (err) {
    console.error("ReceitaWS error:", err instanceof Error ? err.message : err);
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
    const data = await response.json();

    // BrasilAPI returns array of results
    if (Array.isArray(data) && data.length > 0) {
      const company = data[0]; // Take first match
      const cnpj = company.cnpj || "N/A";
      const capitalSocial = company.capital_social
        ? `R$ ${parseFloat(String(company.capital_social)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "N/A";

      // Extract additional data from search result
      const situacao =
        company.status || company.situacao || "N/A";
      const dataAbertura = company.establishment_opening_date || company.opening_date || "N/A";
      const porte = determineCompanySize(
        company.legal_nature || company.company_type,
        String(company.capital_social || "0"),
      );
      const cnaeDescricao = company.main_activity_description || company.cnae_description || "N/A";

      return {
        cnpj,
        capitalSocial,
        situacao: situacao !== "N/A" ? situacao : undefined,
        dataAbertura: dataAbertura !== "N/A" ? formatOpeningDate(dataAbertura) : undefined,
        porte: porte !== "N/A" ? porte : undefined,
        cnaeDescricao: cnaeDescricao !== "N/A" ? cnaeDescricao : undefined,
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
      // Query BrasilAPI for full details
      const cnpjClean = normalizeCNPJ(result.cnpj);
      const detailResponse = await fetch(
        `https://brasilapi.com.br/api/cnpj/v1/${cnpjClean}`,
        { headers: { "User-Agent": "LeadHunter/2.0" } },
      );
      if (detailResponse.ok) {
        const details = (await detailResponse.json()) as {
          capital_social?: string | number;
          status?: string;
          establishment_opening_date?: string;
          legal_nature?: string;
          main_activity_description?: string;
        };
        if (details.capital_social) {
          result.capitalSocial = `R$ ${parseFloat(String(details.capital_social)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
        if (details.status) result.situacao = details.status;
        if (details.establishment_opening_date)
          result.dataAbertura = formatOpeningDate(details.establishment_opening_date);
        if (details.legal_nature || details.capital_social) {
          result.porte = determineCompanySize(details.legal_nature, String(details.capital_social || "0"));
        }
        if (details.main_activity_description) result.cnaeDescricao = details.main_activity_description;
      }
      cnpjCache.set(cacheKey, result);
      return result;
    }

    // Method 1: ReceitaWS (fastest, good coverage)
    console.info(`  └─ Method 1: ReceitaWS...`);
    result = await searchCNPJViaReceitaWS(name, city);
    if (result && result.cnpj !== "N/A") {
      console.info(`  ✅ Found via ReceitaWS: ${result.cnpj}`);
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
 * Abreviatura profissional do porte com word boundaries seguros
 */
function abbreviatePorteProfessional(porte?: string): string {
  if (!porte) return "N/A";

  const porteUpper = String(porte).trim().toUpperCase();

  const hasWord = (text: string, word: string): boolean => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\b" + escaped + "\\b", "i");
    return re.test(text);
  };

  if (
    hasWord(porteUpper, "MICROEMPREENDEDOR") ||
    hasWord(porteUpper, "MEI")
  )
    return "MEI";
  if (hasWord(porteUpper, "MICROEMPRESA") || hasWord(porteUpper, "ME"))
    return "ME";
  if (hasWord(porteUpper, "PEQUENO") || hasWord(porteUpper, "EPP"))
    return "EPP";
  if (
    hasWord(porteUpper, "MÉDIO") ||
    hasWord(porteUpper, "MEDIO") ||
    hasWord(porteUpper, "EMP")
  )
    return "EMP";
  if (hasWord(porteUpper, "GRANDE")) return "GE";
  if (hasWord(porteUpper, "LTDA") || hasWord(porteUpper, "LIMITADA"))
    return "LTDA";
  if (hasWord(porteUpper, "SOCIEDADE ANONIMA") || hasWord(porteUpper, "SA"))
    return "SA";

  return porteUpper;
}

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

// 🔥 POST-EXTRACTION ENRICHMENT - Queries BrasilAPI for full 
async function queryBrasilAPIForEnrichment(cnpj: string): Promise<{
  situacao?: string;
  dataAbertura?: string;
  cnaeDescricao?: string;
  cnae?: string;
} | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
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
      status?: string;
      establishment_opening_date?: string;
      main_activity_description?: string;
      cnae?: string;
      main_cnae?: string;
    };

    return {
      situacao: data.status || undefined,
      dataAbertura: data.establishment_opening_date
        ? formatOpeningDate(data.establishment_opening_date)
        : undefined,
      cnaeDescricao: data.main_activity_description || undefined,
      cnae: data.cnae || data.main_cnae || undefined,
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
      cnae?: string;
      atividade_principal?: Array<{ text?: string; code?: string }>;
    };

    const situacao = data.status || data.situacao;
    const cnaeDescricao = data.cnae_descricao;
    const cnaeCode =
      data.cnae || (data.atividade_principal?.[0]?.code as string | undefined);

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
function identifySegmentFromName(name: string): string {
  if (!name || name === "N/A") return "N/A";

  const lowerName = name.toLowerCase();

  // Define keywords for each segment
  const segments: { [key: string]: string[] } = {
    Farmácia: ["farmácia", "drogaria", "droga", "medicament"],
    Restaurante: [
      "restaurante",
      "churrascaria",
      "pizzaria",
      "bar",
      "café",
      "lanch",
    ],
    "Clínica Médica": [
      "clínica",
      "médico",
      "médica",
      "consultório",
      "hospital",
      "pronto socorro",
      "upa",
    ],
    Padaria: ["padaria", "pão", "bolo", "confeitaria"],
    Supermercado: ["supermercado", "mercado", "mercearia"],
    Academia: ["academia", "ginásio", "musculação", "fitness"],
    Salão: ["salão", "cabeleireiro", "cabeleireira", "barbaria", "barber"],
    Comércio: ["loja", "depósito", "distribuidora", "importadora"],
    Consultório: ["consultório", "advogado", "contador", "engenheiro"],
    Telecomunicações: ["telecom", "operadora", "telefone", "telefônica"],
    Energia: [
      "energia",
      "hidrelétrica",
      "geradora",
      "distribuidora de energia",
    ],
    Construção: ["construção", "imobiliária", "incorporadora", "construtora"],
    Educação: ["escola", "colégio", "universidade", "faculdade", "instituto"],
    Transporte: ["transporte", "táxi", "ônibus", "logística", "frete"],
  };

  // Search for matching segment
  for (const [segment, keywords] of Object.entries(segments)) {
    for (const keyword of keywords) {
      if (lowerName.includes(keyword)) {
        return segment;
      }
    }
  }

  // Default: return N/A if no match
  return "N/A";
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
      { header: "CNAE Código", key: "cnae", width: 15 },
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
                if (!aria) return "N/A";
                const match = aria.match(/[\d,.]+/);
                return match && match[0] ? match[0] : "N/A";
              } catch {
                return "N/A";
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

        // 🔥 PROCESSING: Extract city from full address
        const safeCity = extractCityFromAddress(safeAddressRaw);

        // 🔥 PROCESSING: Identify segment from company name
        const safeCommercialSegment = identifySegmentFromName(safeName);

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

        const lead = {
          id: `lead_${Date.now()}_${extractedCount}`,
          name: safeName,
          rating: safeRating,
          phone: safePhone,
          city: safeCity,
          commercialSegment: safeCommercialSegment,
          cnpj: companyData.cnpj,
          capitalSocial: companyData.capitalSocial,
          situacao: companyData.situacao || "N/A",
          dataAbertura: companyData.dataAbertura || "N/A",
          porte: companyData.porte || "N/A",
          cnaeDescricao: companyData.cnaeDescricao || "N/A",
          faixaCapitalSocial: classifyCapitalRange(companyData.capitalSocial),
          cnae: cnaeCode,
          score: 0, // Will be calculated after
          extractedAt: new Date().toISOString(),
          status: "success" as const,
        };

        // 🔥 NEW: Map CNAE to commercial segment (if available)
        if (cnaeCode !== "N/A") {
          const cnaeSegment = mapCNAEtoSegment(cnaeCode);
          if (cnaeSegment !== "Diversos") {
            lead.commercialSegment = cnaeSegment;
          }
        }

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
          cnae: lead.cnae,
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
