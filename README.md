# 🎯 LeadHunter v2.0

**Sistema Inteligente de Extração e Enriquecimento de Leads Comerciais**

[![Status](https://img.shields.io/badge/status-production-brightgreen)](#)
[![Version](https://img.shields.io/badge/version-2.0-blue)](#)
[![TypeScript](https://img.shields.io/badge/made%20with-TypeScript-294E80)](#)
[![Licence](https://img.shields.io/badge/license-PROPRIETARY-red)](#licença)

---

## 📋 Visão Geral

LeadHunter é uma aplicação desktop (Electron + Vite + React) que automatiza a extração de leads comerciais do Google Maps e enriquece dados através de múltiplas APIs de CNPJ brasileiras, gerando relatórios profissionais em Excel.

### ✨ Funcionalidades Principais

- ✅ **Scraping Inteligente**: Extração otimizada do Google Maps com anti-bot
- ✅ **CNPJ Multi-API**: Busca em cascata (SerpAPI → ReceitaWS → BrasilAPI → Google → CNPJA)
- ✅ **Enriquecimento Automático**: Consolidação de dados de 3+ fontes
- ✅ **Exportação Excel**: Relatórios formatados profissionalmente
- ✅ **Score de Qualidade**: Cálculo inteligente de leadscoring (0-100)
- ✅ **Normalização de Dados**: Padronização de situação, porte, CNAE
- ✅ **API Premium**: Integração com CNPJA como fallback supremo

---

## 🚀 Início Rápido

### Pré-requisitos

- **Node.js** 18+
- **npm** ou **yarn**
- **Python** 3.8+ (para algumas dependências)
- **Windows 10+** (aplicação desktop)

### Instalação

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/LeadHunter.git
cd LeadHunter-Tech4Loop

# Instale as dependências
npm install

# Configure variáveis de ambiente
cp .env.example .env
# Edite .env com suas chaves:
# CNPJA_KEY=sua_chave_aqui
```

### Desenvolvimento

```bash
# Inicie o servidor Vite + Electron em modo dev
npm run dev

# Compilar TypeScript sem rodar
npx tsc --noEmit

# Build para produção
npm run build

# Build Electron
npm run electron:build
```

---

## 🔌 Configuração de APIs

### ReceitaWS (Automática)
✅ Sem autenticação necessária
- Endpoint: `https://www.receitaws.com.br/v1/cnpj/{cnpj}`
- 70M+ CNPJs indexados

### BrasilAPI (Automática)
✅ Sem autenticação necessária
- Endpoints: `https://brasilapi.com.br/api/cnpj/v1/...`
- Open source, 100% confiável

### CNPJA (Premium - Recomendado)
⚠️ Requer chave de autenticação
```bash
# .env
CNPJA_KEY=sua_chave_aqui
```
- Endpoint: `https://api.cnpja.com/office/{cnpj}`
- Verificação manual, maior confiabilidade

---

## 📚 Documentação

- **[DOCUMENTACAO_TECNICA.md](./DOCUMENTACAO_TECNICA.md)** - Documentação técnica completa (APIs, arquitetura, normalização)
- **[RESUMO_IMPLEMENTACAO.md](./RESUMO_IMPLEMENTACAO.md)** - Resumo das implementações (antes/depois)
- **[AUDITORIA_APIS_COMPLETA.md](./AUDITORIA_APIS_COMPLETA.md)** - Auditoria detalhada das APIs

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────┐
│         Google Maps Scraping            │
│  (Playwright + Chromium headless)       │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│    CNPJ Lookup (4 métodos em cascata)   │
│  SerpAPI → ReceitaWS → BrasilAPI → ...  │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│   Data Enrichment (3 APIs, fallback)    │
│  BrasilAPI (primary) → ReceitaWS → ... │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│   Normalização & Validação              │
│  Situação, CNAE, Porte, Score           │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│        Export Excel + Relatório         │
│         (ExcelJS formatado)              │
└─────────────────────────────────────────┘
```

---

## 📊 Processamento de Dados

### Normalização de Situação Cadastral

```
ATIVA      → "Ativa"  (26+ variações reconhecidas)
INAPTA     → "Inapta" (10+ variações reconhecidas)
BAIXADA    → "Baixada" (10+ variações reconhecidas)
Nenhuma    → "Nula"   (marcador de fallback)
```

### Abreviação de PORTE (Oficial IBGE)

```
Microempreendedor Individual  → MEI
Microempresa                  → ME
Empresa Pequeno Porte         → EPP
Empresa Média                 → EMP
Grande Empresa                → GE
Sociedade Anônima             → SA
Limitada                      → LTDA
```

### Extração de CNAE

✅ **Garantia:** Sempre retorna número (ex: `6110100`), nunca descrição

Mapeamento dos 2 primeiros dígitos para categorias:
- `01-03`: Agricultura/Pecuária
- `10-33`: Indústria
- `45-47`: Comércio
- `49-53`: Transporte
- `58-63`: Tecnologia/Comunicação
- E mais 20+ categorias...

### Score de Qualidade (0-100)

| Critério | Pontos |
|----------|--------|
| CNPJ Encontrado | +25 |
| Situação Ativa | +20 |
| Data Abertura | +15 |
| CNAE Identificado | +15 |
| Capital > R$ 10k | +10 |
| Rating ≥ 4.0 | +10 |
| Porte Identificado | +5 |

**Interpretação:**
- **80-100**: Excelente (prioridade alta)
- **60-79**: Bom (prioridade média)
- **40-59**: Válido (prioridade baixa)
- **0-39**: Baixa qualidade

---

## 🛠️ Desenvolvimento

### Stack Tecnológico

- **Frontend**: React 18 + TypeScript
- **Desktop**: Electron + Vite
- **Scraping**: Playwright + Chromium
- **Excel**: ExcelJS
- **APIs**: Fetch nativo

### Estrutura de Pastas

```
LeadHunter-Tech4Loop/
├── electron/
│   ├── main.ts          (Lógica principal - 3500+ linhas)
│   └── preload.ts       (IPC bridge)
├── src/
│   ├── App.tsx
│   ├── components/
│   └── styles/
├── dist-electron/       (Compilado)
├── dist/                (Frontend compilado)
├── DOCUMENTACAO_TECNICA.md
├── RESUMO_IMPLEMENTACAO.md
├── AUDITORIA_APIS_COMPLETA.md
├── package.json
└── tsconfig.json
```

### Regras de Desenvolvimento

- ✅ TypeScript strict mode obrigatório
- ✅ ESLint + Prettier configurados
- ✅ Nenhuma chamada fetch sem timeout
- ✅ Sempre retornar tipo correto (nunca misturar string/number para CNAE)
- ✅ Logs estruturados com prefixos [Module]
- ✅ Error handling com try-catch

---

## 📋 Licença

**PROPRIETARY - Todos os Direitos Reservados**

```
Copyright © 2026 LeadHunter

Termos e Condições:

1. USO AUTORIZADO
   - Este software é fornecido sob licença proprietária
   - Uso exclusivo pelo(s) detentor(es) de licença designado(s)
   - Uso comercial estritamente proibido sem autorização explícita

2. RESTRIÇÕES
   - ❌ Cópia, distribuição ou sublicenciamento proibidos
   - ❌ Engenharia reversa, decompilaçãoou análise de código proibida
   - ❌ Modificação sem consentimento escrito proibida
   - ❌ Uso em produção sem licença válida proibido

3. DIREITOS AUTORAIS
   - Todos os direitos mantidos pelo desenvolvedor
   - Código-fonte, documentação, estrutura de dados são propriedade intelectual
   - APIs integradas (ReceitaWS, BrasilAPI, CNPJA) possuem seus próprios termos

4. GARANTIA
   - Fornecido "NO ESTADO" (AS-IS)
   - Sem garantias de qualidade, adequabilidade ou não-infração
   - Desenvolvedor não responsável por prejuízos

5. ACESSO RESTRITO
   - Acesso ao código-fonte limitado apenas a colaboradores autorizados
   - Repositório privado no GitHub (acesso via convite)
   - Credenciais seguras obrigatórias

6. VIOLAÇÃO
   - Qualquer violação sujeita a ação legal
   - Violador responsável por custos legais e indenizações

7. CONTATO LEGAL
   - Para licenças comerciais ou autorização: contato@leadhunter.com
   - Para suporte técnico: suporte@leadhunter.com
```

---

## 🔐 Segurança

- ✅ Chaves de API em variáveis de ambiente (.env)
- ✅ Nunca commitar .env no repositório
- ✅ Repositório privado no GitHub
- ✅ HTTPS para todas as requisições
- ✅ Rate limiting implementado nas APIs
- ✅ User-Agent falsificado para evitar bloqueios

---

## 📞 Suporte

- **Bugs/Issues**: Reporte via GitHub Issues (repositório privado)
- **Documentação Técnica**: Ver [DOCUMENTACAO_TECNICA.md](./DOCUMENTACAO_TECNICA.md)
- **FAQ**: Ver [RESUMO_IMPLEMENTACAO.md](./RESUMO_IMPLEMENTACAO.md)

---

## 📝 Changelog

### v2.0 (Atual)
- ✅ Integração CNPJA como terciária
- ✅ Normalização de PORTE conforme IBGE
- ✅ CNAE sempre retorna número (nunca descrição)
- ✅ Score de qualidade inteligente
- ✅ Documentação técnica consolidada
- ✅ Licença proprietária oficial

### v1.0
- API: ReceitaWS + BrasilAPI
- Extração: Google Maps básica
- Export: Excel simples

---

**© 2026 LeadHunter - Todos os Direitos Reservados**

**Versão:** 2.0  
**Data:** Abril 2026  
**Status:** Production ✅
