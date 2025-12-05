import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "fs";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Types
interface Lead {
  name: string;
  phone: string;
  rating: string;
  address: string;
  url: string;
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
  message: string
) {
  win?.webContents.send("scrape:log", {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    level,
    message,
  });
}

function sendProgress(current: number, total: number, currentItem?: string) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
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

// 🔥 SIMPLIFIED: Use normal Excel workbook instead of streaming (avoid Node.js Buffer issues)
async function initializeExcel(searchTerm: string): Promise<{ workbook: ExcelJS.Workbook, filePath: string, worksheet: ExcelJS.Worksheet, leads: Lead[] }> {
  const documents = app.getPath("documents");
  const leadsFolder = path.join(documents, "Leads-Hunted");
  
  // Create folder if it doesn't exist
  if (!fs.existsSync(leadsFolder)) {
    fs.mkdirSync(leadsFolder, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const filename = `LeadHunter_${searchTerm
    .slice(0, 20)
    .replace(/[^a-zA-Z0-9]/g, "_")}_${timestamp}.xlsx`;
  const filePath = path.join(leadsFolder, filename);

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Leads");

  worksheet.columns = [
    { header: "Nome", key: "name", width: 30 },
    { header: "Telefone", key: "phone", width: 20 },
    { header: "Nota", key: "rating", width: 12 },
    { header: "Endereço", key: "address", width: 40 },
    { header: "URL", key: "url", width: 50 },
  ];

  return { workbook, filePath, worksheet, leads: [] };
}

async function saveExcel(workbook: ExcelJS.Workbook, filePath: string): Promise<void> {
  await workbook.xlsx.writeFile(filePath);
}

async function scrapeGoogleMaps(
  searchTerm: string,
  maxResults: number
) {
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  
  // 🔥 SIMPLIFIED: Use normal workbook
  const { workbook, filePath, worksheet, leads: collectedLeads } = await initializeExcel(searchTerm);
  
  // 🔥 Deduplication with Sets (memory efficient)
  const seenUrls = new Set<string>();
  const seenIdentifiers = new Set<string>();

  try {
    sendLog("info", "🚀 Iniciando navegador otimizado...");

    // 🔥 PERFORMANCE: Force headless mode (optimized Chromium)
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
      ],
    });

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });

    page = await context.newPage();
    
    // 🔥 PERFORMANCE: Block ALL unnecessary resources
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      const blockedTypes = ['image', 'stylesheet', 'font', 'media', 'other'];
      
      if (blockedTypes.includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });
    
    sendLog("info", "🌐 Navegador iniciado (modo ultra-otimizado)");

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    sendLog("info", `📍 Acessando: ${searchUrl}`);

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(800);

    const resultsSelector = 'div[role="feed"]';
    sendLog("info", "🔍 Procurando painel de resultados...");

    try {
      await page.waitForSelector(resultsSelector, { timeout: 8000 });
    } catch {
      throw new Error("Painel de resultados não encontrado.");
    }

    sendLog("success", "✅ Painel encontrado, iniciando scroll...");

    // 🔥 OPTIMIZED SCROLL: Count DOM elements directly
    let scrollAttempts = 0;
    const maxScrollAttempts = 50;
    let previousCount = 0;
    let stagnantScrolls = 0;

    while (scrollAttempts < maxScrollAttempts && isScrapingActive) {
      await page.evaluate((sel) => {
        const panel = document.querySelector(sel);
        if (panel) panel.scrollBy(0, panel.scrollHeight);
      }, resultsSelector);

      await page.waitForTimeout(600); // Faster scroll
      scrollAttempts++;

      const currentCount = await page.locator('div[role="feed"] > div > div > a').count();

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

    const links = await page.locator('div[role="feed"] > div > div > a').all();
    const totalAvailable = links.length;

    sendLog("success", `✅ ${totalAvailable} estabelecimentos encontrados`);
    win?.webContents.send("scrape:total-found", { totalFound: totalAvailable });

    let extractedCount = 0;

    for (let i = 0; i < links.length && extractedCount < maxResults && isScrapingActive; i++) {
      try {
        // 🔥 EXTREME SAFETY: Wrap entire iteration in try-catch
        if (!isScrapingActive) break;
        if (!page || page.isClosed()) break;
        // 🔥 EPHEMERAL CONTEXT: Restart every N requests to free memory
        extractionCounter++;
        if (extractionCounter % CONTEXT_RESTART_INTERVAL === 0 && context && page) {
          sendLog("info", "♻️ Reiniciando contexto do navegador...");
          await page.close();
          await context.close();
          
          context = await browser!.newContext({ viewport: { width: 1920, height: 1080 } });
          page = await context.newPage();
          
          // Re-apply resource blocking
          await page.route('**/*', (route) => {
            const resourceType = route.request().resourceType();
            if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
              route.abort();
            } else {
              route.continue();
            }
          });
          
          await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(800);
          
          // Re-fetch links after context restart
          const newLinks = await page.locator('div[role="feed"] > div > div > a').all();
          if (i < newLinks.length) {
            // 🔥 FIX: Use JavaScript click for invisible elements
            await newLinks[i].evaluate((el: HTMLElement) => el.click());
          }
        } else {
          // 🔥 FIX: Use JavaScript click for invisible elements
          await links[i].evaluate((el: HTMLElement) => el.click());
        }
        
        await page!.waitForTimeout(700);

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
                const elem = document.querySelector('h1.DUwDvf');
                const text = elem?.textContent?.trim();
                if (!text) return 'N/A'; // 🔥 FIX: Check null before processing
                return text;
              } catch {
                return 'N/A';
              }
            };

            const getRating = () => {
              try {
                const elem = document.querySelector('div.F7nice span[role="img"]');
                const aria = elem?.getAttribute('aria-label');
                if (!aria) return 'N/A'; // 🔥 FIX: Check null before regex
                const match = aria.match(/[\d,.]+/);
                return match && match[0] ? match[0] : 'N/A';
              } catch {
                return 'N/A';
              }
            };

            const getPhone = () => {
              try {
                const elem = document.querySelector('button[data-item-id*="phone:tel:"]');
                const text = elem?.textContent?.trim();
                if (!text) return 'N/A'; // 🔥 FIX: Check null before processing
                return text;
              } catch {
                return 'N/A';
              }
            };

            const getAddress = () => {
              try {
                const elem = document.querySelector('button[data-item-id^="address"]');
                const text = elem?.textContent?.trim();
                if (!text) return 'N/A'; // 🔥 FIX: Check null before processing
                return text;
              } catch {
                return 'N/A';
              }
            };

            return {
              name: getName(),
              rating: getRating(),
              phone: getPhone(),
              address: getAddress(),
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
        if (!leadData || !leadData.name || leadData.name === 'N/A') {
          continue; // Skip invalid entries
        }

        // 🔥 SAFETY: Ensure all fields are strings
        const safeName = String(leadData.name || 'N/A');
        const safePhone = String(leadData.phone || 'N/A');
        const safeRating = String(leadData.rating || 'N/A');
        const safeAddress = String(leadData.address || 'N/A');

        const identifier = `${safeName}_${safePhone}`;
        if (seenIdentifiers.has(identifier)) continue;

        seenUrls.add(url);
        seenIdentifiers.add(identifier);
        extractedCount++;

        const lead = {
          id: `lead_${Date.now()}_${extractedCount}`,
          name: safeName,
          rating: safeRating,
          phone: safePhone,
          address: safeAddress,
          url,
          extractedAt: new Date().toISOString(),
          status: "success" as const,
        };

        // 🔥 BATCH: Accumulate in array
        collectedLeads.push(lead);
        worksheet.addRow({
          name: lead.name,
          phone: lead.phone,
          rating: lead.rating,
          address: lead.address,
          url: lead.url
        });

        win?.webContents.send("scrape:new-lead", lead);
        sendLog("success", `✅ Lead ${extractedCount}: ${lead.name}`);
        sendProgress(extractedCount, maxResults, `Extraindo ${extractedCount}/${maxResults}`);

      } catch (error: unknown) {
        // 🔥 BULLETPROOF: Log error but continue extraction
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
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

    // 🔥 BATCH: Save workbook once at end
    await saveExcel(workbook, filePath);

    sendLog("success", `✨ ${extractedCount} leads salvos em: ${filePath}`);
    sendComplete(extractedCount, filePath);
    
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
  // Fix preload path for both dev and production
  const preloadPath = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "dist-electron",
        "preload.cjs"
      )
    : path.join(__dirname, "../dist-electron/preload.cjs");

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
      }`
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
