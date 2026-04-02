# 📚 DOCUMENTAÇÃO TÉCNICA COMPLETA - LeadHunter v2.0

**Data de Atualização:** Abril 2026  
**Versão:** 2.0 (APIs Consolidadas)  
**Status:** ✅ Produção

---

## 📋 Índice

1. [Visão Geral do Sistema](#visão-geral)
2. [APIs Integradas](#apis-integradas)
3. [Arquitetura de Extração](#arquitetura-de-extração)
4. [Processamento de Dados](#processamento-de-dados)
5. [Normalização e Validação](#normalização-e-validação)
6. [Score de Qualidade](#score-de-qualidade)
7. [Tratamento de Erros](#tratamento-de-erros)
8. [Ambiente e Configuração](#ambiente-e-configuração)

---

## 🎯 Visão Geral

LeadHunter é uma aplicação desktop (Electron + Vite) que automatiza a extração e enriquecimento de leads comerciais do Google Maps, consolidando dados de múltiplas APIs brasileiras para gerar relatórios profissionais em Excel.

### Fluxo Principal
```
Google Maps → Extraction → CNPJ Lookup → Data Enrichment → Excel Export
```

### Funcionalidades Principais
- ✅ Scraping inteligente do Google Maps
- ✅ Busca de CNPJ em cascata (3+ APIs)
- ✅ Enriquecimento automático de dados
- ✅ Exportação em Excel formatado
- ✅ Cálculo inteligente de score

---

## 🔌 APIs Integradas

### 1. **ReceitaWS** (✅ Primária)
**Endpoint:** `GET https://www.receitaws.com.br/v1/cnpj/{cnpj}`

#### Resposta Padrão
```json
{
  "cnpj": "11222333000181",
  "situacao": "ATIVA",
  "abertura": "24/11/2009",
  "porte": "MICRO",
  "capital_social": "1000.00",
  "atividade_principal": [
    {
      "code": "6110100",
      "text": "Telecomunicações por fio"
    }
  ]
}
```

#### Campos Extraídos
| Campo | Uso | Tipo |
|-------|-----|------|
| `situacao` | Status cadastral | String |
| `abertura` | Data de abertura (DD/MM/YYYY) | String |
| `porte` | Tamanho da empresa | String |
| `capital_social` | Capital social em números | String |
| `atividade_principal[0].code` | Código CNAE | String |

#### Características
- 70.556.200 CNPJs indexados
- Disponibilidade: 99.9%
- Sem autenticação necessária
- Taxa de sucesso: ~85%

---

### 2. **BrasilAPI** (✅ Secundária)
**Endpoints:**
- Search: `GET https://brasilapi.com.br/api/cnpj/v1/search?query={name}`
- Detail: `GET https://brasilapi.com.br/api/cnpj/v1/{cnpj}`

#### Resposta Padrão (Detail)
```json
{
  "cnpj": "11222333000181",
  "descricao_situacao_cadastral": "ATIVA",
  "data_inicio_atividade": "2009-11-24",
  "establishment_opening_date": "2009-11-24",
  "porte": "MICRO",
  "capital_social": "1000.00",
  "cnae_fiscal": 6110100,
  "cnae_fiscal_descricao": "Telecomunicações por fio"
}
```

#### Campos Extraídos
| Campo | Mapeamento |
|-------|-----------|
| `descricao_situacao_cadastral` | Situação principal |
| `data_inicio_atividade` | Data de abertura (YYYY-MM-DD) |
| `cnae_fiscal` | Código CNAE |
| `porte` | Porte da empresa |
| `capital_social` | Capital em números |

#### Características
- Open source (GitHub/BrasilAPI)
- OpenAPI v3.0 completo
- Sem autenticação necessária
- Taxa de sucesso: ~88%

---

### 3. **CNPJA** (✅ Terciária/Premium)
**Endpoint:** `GET https://api.cnpja.com/office/{cnpj}`

#### Autenticação
```
Authorization: {chave_api_fornecida}
```
⚠️ **Nota:** Header direto (NÃO Bearer token)

#### Resposta Padrão
```json
{
  "taxId": "11222333000181",
  "founded": "2009-11-24",
  "company": {
    "name": "Empresa Exemplo LTDA",
    "equity": 1000.00
  },
  "simples": {
    "optant": false
  }
}
```

#### Campos Extraídos
| Campo | Uso |
|-------|-----|
| `founded` | Data de fundação (YYYY-MM-DD) |
| `company.equity` | Capital social |
| `simples.optant` | Indicação de MEI/SIMPLES |

#### Características
- API Premium (com key fornecida)
- Dados verificados manualmente
- Taxa de sucesso: ~90%

---

## 🏗️ Arquitetura de Extração

### Método 0: SerpAPI (GoogleMaps Context)
_Extração de CNPJ a partir de contexto de busca Google_

```typescript
// Usado quando Google Maps retorna resultados com contexto
// Exemplo: "Cl123xyz... - São Paulo, SP" 
```

### Método 1: ReceitaWS Direct
```typescript
async function searchCNPJViaReceitaWS(cnpj: string)
  ├─ Limpa formato CNPJ
  ├─ Faz request GET
  ├─ Extrai: situacao, abertura, atividade_principal
  └─ Retorna objeto estruturado
```

### Método 2: BrasilAPI (Search → Detail)
```typescript
async function searchCNPJViaBrasilAPI(name: string)
  ├─ Busca por nome (search endpoint)
  ├─ Se encontrado, pega CNPJ
  ├─ Faz request detail
  ├─ Extrai campos completos
  └─ Retorna objeto estruturado
```

### Método 3: Google Search Scraping
_Fallback agressivo usando busca Google + parsing_

```typescript
async function searchCNPJViaGoogle(name: string, city: string)
  ├─ Constrói query: "CNPJ {name} {city}"
  ├─ Scraping de resultados
  ├─ Extrai padrão 14 dígitos
  └─ Retorna primeiro resultado
```

### Método 4: CNPJA Premium
```typescript
async function searchCNPJViaCNPJA(cnpj: string)
  ├─ Valida chave de API
  ├─ Faz request com Authorization header
  ├─ Extrai: founded, company.equity
  └─ Retorna objeto estruturado
```

### Hierarquia de Consolidação
```
Busca CNPJ:
  ├─ SerpAPI → Encontrado? ✓ Usa
  ├─ ReceitaWS → Encontrado? ✓ Usa
  ├─ BrasilAPI → Encontrado? ✓ Usa
  └─ Google Search → Encontrado? ✓ Usa

Enriquecimento (Dados):
  ├─ Step 1: BrasilAPI
  │  ├─ Situação: descricao_situacao_cadastral
  │  ├─ Data: data_inicio_atividade
  │  ├─ CNAE: cnae_fiscal (numérico)
  │  └─ Se completo → Retorna
  │
  ├─ Step 2: ReceitaWS (se BrasilAPI falhou)
  │  ├─ Situação: situacao
  │  ├─ Data: abertura
  │  ├─ CNAE: atividade_principal[0].code
  │  └─ Se completo → Retorna
  │
  └─ Step 3: CNPJA (se ambas falharam)
     ├─ Data: founded
     ├─ Capital: company.equity
     └─ Situação: simples.optant (derivada)
```

---

## 📊 Processamento de Dados

### 1. Normalização de Situação Cadastral

| Entrada | Saída | Categorias |
|---------|-------|-----------|
| ATIVA, ativa, active, regularizado, em funcionamento | **Ativa** | 6+ variações |
| INAPTA, inapta, suspended, suspensa, paralisada, não_regularizada | **Inapta** | 10+ variações |
| BAIXADA, baixada, canceled, extinta, encerrada, cancelada | **Baixada** | 10+ variações |
| Qualquer outro valor | **Nula** | Marcador de fallback |

```typescript
function normalizeSituacaoCadastral(situacao?: string): string
  ├─ Normaliza: trim() + toLowerCase()
  ├─ Aplica 26+ padrões de reconhecimento
  └─ Retorna: Ativa | Inapta | Baixada | Nula
```

### 2. Extração de CNAE (Código Numérico)

✅ **Garantia:** Sempre retorna número, nunca descrição

```typescript
// Prioridade de extração:
1. data.cnae (BrasilAPI)
2. data.cnae_fiscal (BrasilAPI alt)
3. data.main_cnae (BrasilAPI generic)
4. data.atividade_principal[0].code (ReceitaWS)

// Validação:
- Remove caracteres não-numéricos
- Valida tamanho: 4-7 dígitos
- Garante formato NNNNNN (ex: 6110100)
```

**Mapeamento CNAE 2.3 (Prefixos de 2 dígitos):**
- `01-03`: Agricultura/Pecuária/Floresta
- `10-33`: Indústria de Transformação
- `45-47`: Comércio
- `49-53`: Transporte
- `58-63`: Informação/Comunicação
- `69-75`: Serviços Profissionais
- `84-87`: Administração/Educação/Saúde

---

### 3. Abreviação de PORTE (Conforme APIs)

```typescript
function abbreviatePorteProfessional(porte?: string): string
```

**Mapeamento Oficial (IBGE/ReceitaWS/BrasilAPI):**

| Entrada | Abreviação | Significado | Faixa de Faturamento |
|---------|----------|-----------|------------------|
| "Microempreendedor Individual" | **MEI** | Autônomo registrado | < R$ 81.500/ano |
| "Microempresa" | **ME** | Pequeno negócio | R$ 0 - R$ 488.000/ano |
| "Empresa Pequeno Porte" | **EPP** | Porte pequeno | R$ 488k - R$ 2.388M/ano |
| "Empresa Média" | **EMP** | Porte médio | R$ 2.4M - R$ 300M+ |
| "Grande Empresa" | **GE** | Porte grande | > R$ 300M/ano |
| "Limitada" | **LTDA** | Tipo societário | Qualquer |
| "Sociedade Anônima" | **SA** | Tipo societário | Qualquer |
| "Eireli" | **EIRELI** | Empresa Individual | Qualquer |
| "Unipessoal" | **EI** | Empresa Individual | Qualquer |

**Lógica de Prioridade:**
1. Tipo Societário (SA, LTDA, EIRELI, EI)
2. Tamanho (MEI, ME, EPP, EMP, GE)
3. Fallback: "N/A"

---

### 4. Formatação de Datas

```typescript
function formatOpeningDate(dateStr: string): string
```

**Conversões Suportadas:**
- `DD/MM/YYYY` → `31/12/2009` (ReceitaWS)
- `YYYY-MM-DD` → `2009-12-31` (BrasilAPI)
- `YYYY-MM-DDTHH:mm:ss.sssZ` → `31/12/2009` (ISO8601)

**Resultado:** Sempre `DD/MM/YYYY`

---

### 5. Formatação de Capital Social

```typescript
function formatarMoedaProfessional(valor?: string | number): string
```

**Exemplo:**
- Input: `"1000000"` ou `1000000`
- Output: `"R$ 1.000.000,00"`
- Se R$ 0: `"N/A"`

---

### 6. Classificação de Faixa Capital

```typescript
function classifyCapitalRangeProfessional(valor?: string | number): string
```

| Faixa de Capital | Classificação |
|-----------------|--------------|
| ≤ R$ 50.000 | **Pequeno** |
| R$ 50k - R$ 300k | **Médio** |
| > R$ 300.000 | **Estruturado** |
| Valor 0 ou faltante | **N/A** |

---

## ✨ Normalização e Validação

### Validação de Lead

```typescript
// Um lead é válido APENAS se:
1. ✓ Nome não vazio e não "N/A"
2. ✓ Telefone presente (OBRIGATÓRIO)
3. ✓ Cidade extraída com sucesso
4. ✓ Segmento comercial identificado
```

**Leads são REJEITADOS se:**
- ❌ Telefone ausente (rejeição total)
- ❌ Nome genérico (ex: "Estabelecimento")
- ❌ Dados suspeitos (ex: endereço vazio 3+ vezes)

---

### Deduplica²ção

```typescript
// Identificador único por lead:
identifier = `${nome}_${telefone}`

// Se já processado → SKIP
```

---

## 📈 Score de Qualidade

```typescript
function calculateLeadScore(lead: Lead): number
```

**Critérios de Avaliação (Total: 100 pontos)**

| Critério | Pontos | Condição |
|----------|--------|----------|
| **CNPJ Encontrado** | +25 | CNPJ ≠ N/A |
| **Situação Ativa** | +20 | situacao == "Ativa" |
| **Data Abertura** | +15 | dataAbertura ≠ N/A |
| **CNAE Identificado** | +15 | cnae ≠ N/A |
| **Capital Social** | +10 | capital > R$ 10k |
| **Avaliação (Rating)** | +10 | rating ≥ 4.0 |
| **Porte Identificado** | +5 | porte ≠ N/A |

**Fórmulas:**

```typescript
// Score base
base = 0

// CNPJ: 0 ou 25
base += lead.cnpj !== "N/A" ? 25 : 0

// Situação: 0, 15 ou 5
if (lead.situacao === "Ativa") base += 20
else if (lead.situacao === "Inapta") base += 5
else if (lead.situacao === "Baixada") base += 0

// Data: 0 ou 15
base += lead.dataAbertura !== "N/A" ? 15 : 0

// CNAE: 0 ou 15
base += lead.cnae !== "N/A" ? 15 : 0

// Capital: 0 ou 10
base += (parseInt(lead.capitalSocial) || 0) > 10000 ? 10 : 0

// Rating: 0 a 10
const rating = parseFloat(lead.rating) || 0
base += Math.min(10, Math.floor(rating * 2))

// Porte: 0 ou 5
base += lead.porte !== "N/A" ? 5 : 0

// Total normalizado
score = Math.round(base)
```

**Interpretação:**
- **80-100:** Excelente lead (prioridade alta)
- **60-79:** Bom lead (prioridade média)
- **40-59:** Lead válido (prioridade baixa)
- **0-39:** Lead baixa qualidade (não recomendado)

---

## ⚠️ Tratamento de Erros

### Timeouts
- **ReceitaWS:** 5 segundos
- **BrasilAPI:** 5 segundos
- **Google Search:** 8 segundos
- **CNPJA:** 5 segundos

### Retry Logic
```typescript
// Nenhuma retry automática no enriquecimento
// (falha = tenta próxima API na cascata)

// Exception handling: log + continua
try {
  // operação
} catch (err) {
  console.error(`[Modulo] ${err.message}`)
  // continua para próxima
}
```

### HTTP Status Codes

| Status | Ação |
|--------|------|
| 200 | ✅ Sucesso - processa dados |
| 4xx | ❌ Erro cliente - skip |
| 5xx | ⚠️ Erro servidor - tenta próxima API |
| Timeout | ⚠️ Tenta próxima API |

### Autenticação CNPJA

```typescript
// Valida chave antes de usar
if (!process.env.CNPJA_KEY) {
  console.warn("CNPJA_KEY não configurada - pula Method 4")
  return null
}

// Se 401 Unauthorized: chave inválida
if (response.status === 401) {
  console.error("CNPJA_KEY inválida ou expirada")
  return null
}
```

---

## 🔧 Ambiente e Configuração

### Variáveis de Ambiente

```bash
# .env
CNPJA_KEY=43a76ea4-a463-44f9-899e-374746ae048b-8149b5da-dfff-4de5-bee7-68946deff296
VITE_DEV_SERVER_URL=http://localhost:5173
```

### Dependências Principais

```json
{
  "electron": "^Latest",
  "vite": "^Latest",
  "exceljs": "^Latest",
  "playwright": "^Latest",
  "typescript": "^5.0"
}
```

### Estrutura de Pastas

```
LeadHunter-Tech4Loop/
├── electron/
│   └── main.ts          (Logic principal)
├── src/
│   ├── App.tsx          (UI)
│   └── components/      (React components)
├── dist-electron/       (Compiled electron)
├── dist/                (Compiled vite)
└── package.json
```

---

## 📝 Logs e Debug

### Console de Debug

```
[ReceitaWS] Situação: ATIVA
[BrasilAPI] Data abertura from data_inicio_atividade: 24/11/2009
[BrasilAPI Enrichment] HTTP 200
[Consolidation] ✅ CNPJ consolidado com sucesso
[Post-Enrichment] Enriching 45 leads...
[Normalization] Recognized as ATIVA from "ATIVA"
```

### Verbosidade

- **console.debug()**: Detalhes operacionais (request/response)
- **console.info()**: Marcos importantes (início/fim de fase)
- **console.warn()**: Anomalias (valores inesperados)
- **console.error()**: Falhas críticas (exceções)

---

## 🚀 Exemplo de Fluxo Completo

### Input Google Maps
```
Nome: "Clínica de Fisioterapia Vida Plena"
Telefone: "(11) 98765-4321"
Endereço: "Rua das Flores, 123, São Paulo, SP, 01234-567"
Rating: "4.8"
```

### Processamento

```
1. [Extração] Nome/Telefone/Cidade extraídos
2. [CNPJ Lookup] Chamando SerpAPI...
   → Não encontrado
3. [ReceitaWS] Buscando "Clínica de Fisioterapia Vida Plena"...
   → Tentando direto, falhou (nome não exato)
4. [BrasilAPI] Buscando...
   → ✅ Encontrado: 12345678000100
5. [Consolidação Step 1 - BrasilAPI]
   - Situação: "Ativa" ✓
   - Data: "2018-03-15" → "15/03/2018" ✓
   - CNAE: 8610100 ✓
   - Capital: "50000" ✓
6. [Enriquecimento Pós-Extração]
   - CNAE Código: 8610100 → "Atividades de Atenção à Saúde"
   - CNAE Classificação: "Saúde" ✓
   - Porte: "PEQUENO" → "EPP" ✓
7. [Score Cálculo]
   - CNPJ: +25 ✓
   - Situação Ativa: +20 ✓
   - Data: +15 ✓
   - CNAE: +15 ✓
   - Capital > 10k: +10 ✓
   - Rating 4.8: +10 ✓
   - Porte: +5 ✓
   - **Total: 100/100** (Excelente)
8. [Exportação] Adicionado ao Excel
```

### Output Excel

| Nome | Telefone | Cidade | Segmento | CNPJ | Situação | Ano Fund. | Porte | CNAE | Capital | Score |
|------|----------|--------|----------|------|----------|-----------|-------|------|---------|-------|
| Clínica Via Plena | (11) 98765-4321 | São Paulo | Fisioterapia | 12.345.678/0001-00 | Ativa | 2018 | EPP | 8610100 | R$ 50.000,00 | 100 |

---

## 🎓 Referências de APIs

- **ReceitaWS**: https://www.receitaws.com.br/
- **BrasilAPI**: https://brasilapi.com.br/
- **BrasilAPI GitHub**: https://github.com/BrasilAPI/BrasilAPI
- **CNPJA**: https://cnpja.com/api
- **CNAE Oficial (IBGE)**: https://concla.ibge.gov.br/

---

## 📞 Suporte

Para dúvidas sobre:
- **APIs**: Consulte documentação oficial acima
- **LeadHunter**: Versão 2.0, produção
- **Bugs**: Reporte com logs de debug

---

**© 2026 LeadHunter - Sistema de Extração de Leads - Versão 2.0**
