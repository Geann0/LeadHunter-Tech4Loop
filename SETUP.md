# LeadHunter Pro - Instruções de Instalação e Uso

## 🚀 Instalação Rápida

### 1. Instalar Dependências do Frontend

```powershell
cd C:\Users\haduk\OneDrive\Desktop\Extrator_Leads\LeadHunter-Tech4Loop
npm install
```

### 2. Instalar Dependências Python (se ainda não tiver)

```powershell
cd C:\Users\haduk\OneDrive\Desktop\Extrator_Leads
pip install playwright pandas openpyxl
playwright install chromium
```

## ▶️ Executar Aplicação

### Modo Desenvolvimento (com DevTools)

```powershell
cd C:\Users\haduk\OneDrive\Desktop\Extrator_Leads\LeadHunter-Tech4Loop
npm run dev
```

### Compilar para Produção

```powershell
npm run build
```

## 📋 Dependências Instaladas

### Frontend

✅ React 18.2.0
✅ React DOM 18.2.0
✅ Lucide React (ícones)
✅ clsx + tailwind-merge (utilitários CSS)
✅ TypeScript 5.2.2
✅ Vite 5.1.6
✅ Tailwind CSS 4.1.17
✅ Electron 30.0.1
✅ Autoprefixer + PostCSS

### Backend

✅ Playwright (browser automation)
✅ Pandas (data manipulation)
✅ OpenPyXL (Excel export)

## 🎯 Como Usar

1. **Execute** `npm run dev`
2. **Digite** o termo de busca (ex: "Farmácias em Ji-Paraná")
3. **Configure** max resultados (10-500) e modo headless
4. **Clique** em "Iniciar"
5. **Acompanhe** progresso no terminal e dashboard
6. **Aguarde** conclusão e exportação para Excel
7. **Clique** "Abrir Pasta" para ver o arquivo gerado

## 🔧 Arquivos Criados

### Componentes React

- `src/components/StatusBadge.tsx` - Indicador de status (5 estados)
- `src/components/StatCard.tsx` - Cards de métricas
- `src/components/TerminalView.tsx` - Visualizador de logs estilo Matrix
- `src/components/ResultsTable.tsx` - Tabela de resultados

### Core

- `src/App.tsx` - Aplicação principal com layout completo
- `src/types/index.ts` - Interfaces TypeScript
- `src/lib/utils.ts` - Funções utilitárias
- `src/global.d.ts` - Declarações TypeScript para IPC
- `src/index.css` - Estilos Tailwind

### Electron

- `electron/main.ts` - Processo principal com IPC handlers
- `electron/preload.ts` - Bridge IPC seguro

### Configuração

- `tailwind.config.js` - Configuração Tailwind
- `postcss.config.js` - PostCSS com Tailwind
- `package.json` - Dependências atualizadas

## 🎨 Tema Visual

- **Dark Mode Cyberpunk** com gradientes cyan/emerald
- **Janela Frameless** com controles customizados
- **Barra de Progresso Animada** com shimmer effect
- **Terminal Matrix-Style** com cores por nível de log
- **Tabela Responsiva** com sticky header

## 📡 Canais IPC

### Renderer → Main

- `scrape:start` - Iniciar extração
- `scrape:stop` - Parar extração
- `window:minimize` - Minimizar janela
- `window:close` - Fechar aplicação
- `open:folder` - Abrir pasta no explorador

### Main → Renderer

- `scrape:progress` - Atualização de progresso
- `scrape:new-lead` - Novo lead extraído
- `scrape:log` - Mensagem de log
- `scrape:complete` - Extração concluída
- `scrape:error` - Erro ocorrido

## ⚠️ Troubleshooting

### "Cannot find module 'lucide-react'"

```powershell
npm install
```

### "Python script not found"

- Verifique se `main.py` está em: `C:\Users\haduk\OneDrive\Desktop\Extrator_Leads\main.py`

### "Chromium not installed"

```powershell
playwright install chromium
```

### Janela não abre

- Execute `npm run dev` (não use `vite dev` diretamente)
- Verifique se não há erros no console

## 🎯 Próximos Passos

1. **Testar** aplicação em modo dev
2. **Validar** integração Python ↔ Electron
3. **Ajustar** parsing de output do Python (JSON format)
4. **Compilar** para produção quando tudo funcionar
5. **Distribuir** executável final

---

**Status**: ✅ Frontend completo | ⏳ Integração Python pendente
