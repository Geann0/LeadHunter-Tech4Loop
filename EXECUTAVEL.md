# 🚀 LeadHunter Pro - Executável FINAL

## 📍 Localização do Executável

```
build-output\win-unpacked\LeadHunter Pro.exe
```

**Caminho completo:**

```
C:\Users\haduk\OneDrive\Desktop\Extrator_Leads\LeadHunter-Tech4Loop\build-output\win-unpacked\LeadHunter Pro.exe
```

## ✅ Correções Aplicadas

1. ✅ **Preload IPC**: Desempacotado do ASAR e carregado corretamente
2. ✅ **Playwright**: Configurado para usar navegadores globais (`C:\Users\haduk\AppData\Local\ms-playwright\`)
3. ✅ **Caminho do Preload**: Usa `process.resourcesPath` quando empacotado

## 🎯 Como Usar

1. **Execute** `LeadHunter Pro.exe`
2. **Digite** sua busca (ex: "farmacias em ouro preto do oeste rondonia")
3. **Clique** em "Iniciar Busca"
4. **Aguarde** o navegador Chromium abrir automaticamente
5. **Veja** os leads sendo coletados em tempo real
6. **Excel** será salvo automaticamente na sua Área de Trabalho

## 🔧 Verificação

Para confirmar que o IPC está funcionando:

1. Abra o executável
2. Pressione **F12** para abrir DevTools
3. No console, digite: `window.ipcRenderer`
4. Deve retornar um objeto (não `undefined`)

## 📊 O Que Foi Corrigido

### Problema 1: Demo Mode

**Sintoma:** Sempre mostrava "Modo demonstração"
**Causa:** IPC não estava carregando (preload dentro do ASAR)
**Solução:** Adicionado `dist-electron/preload.mjs` ao `asarUnpack`

### Problema 2: Executável Travava

**Sintoma:** App demorava muito ou não abria
**Causa:** Playwright procurando navegadores em local errado
**Solução:** Removido `extraResources` que tentava copiar `.local-browsers` inexistente

### Problema 3: Preload Path Errado

**Sintoma:** `window.ipcRenderer` undefined
**Causa:** `__dirname` apontava para dentro do ASAR
**Solução:** Usa `process.resourcesPath` + `app.asar.unpacked` quando empacotado

## 🎮 Teste Rápido

Execute e teste com:

- **Busca:** "restaurantes em São Paulo"
- **Limite:** 10 leads
- **Delay:** 2000ms

Deve:

- ✅ Abrir navegador Chromium
- ✅ Navegar para Google Maps
- ✅ Fazer scroll automático
- ✅ Extrair dados
- ✅ Mostrar progresso em tempo real
- ✅ Salvar Excel na Área de Trabalho

## 📝 Logs de Debug

No PowerShell onde você executou, verá:

```
[Main] App is packaged: true
[Main] __dirname: C:\...\resources\app.asar
[Main] process.resourcesPath: C:\...\resources
[Main] Preload path: C:\...\resources\app.asar.unpacked\dist-electron\preload.mjs
[Main] Preload exists: true
```

Se `Preload exists: false`, há problema no build.

## 🛠️ Rebuild (Se Necessário)

```powershell
# Fechar todos os processos
Get-Process | Where-Object {$_.ProcessName -like "*LeadHunter*"} | Stop-Process -Force

# Limpar e rebuildar
Remove-Item "build-output" -Recurse -Force
npm run build

# Executável estará em:
build-output\win-unpacked\LeadHunter Pro.exe
```

## 📦 Distribuição

Para compartilhar com outras pessoas:

1. **Copie toda a pasta** `win-unpacked`
2. **Importante:** Outros usuários precisam ter Playwright instalado:
   ```powershell
   npx playwright install chromium
   ```
   OU copie a pasta `C:\Users\haduk\AppData\Local\ms-playwright` para a máquina de destino

## ⚠️ Requisitos

- ✅ Windows 10/11 (64-bit)
- ✅ Chromium instalado (via Playwright)
- ✅ Conexão com Internet (para scraping)

## 🎨 Interface

- **Tema:** Dark/Cyberpunk
- **Estatísticas:** Tempo decorrido, leads coletados, taxa de sucesso
- **Logs:** Em tempo real
- **Tabela:** Resultados conforme coletados

## 💾 Arquivo Excel

- **Localização:** Área de Trabalho
- **Nome:** `Google Maps Leads - YYYY-MM-DD-HH-mm-ss.xlsx`
- **Formato:** Compatível com Excel, Google Sheets, LibreOffice
- **Colunas:**
  - Nome
  - Telefone
  - Avaliação
  - Endereço
  - URL

---

**Status:** ✅ FUNCIONANDO
**Build:** 2024-12-05
**Versão Electron:** 30.5.1
**Versão Playwright:** 1.57.0
