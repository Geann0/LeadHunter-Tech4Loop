# 🎯 LeadHunter Pro - Executável

## 📦 Localização do Executável

O executável pronto para uso está em:

```
release/win-unpacked/LeadHunter Pro.exe
```

## 🚀 Como Usar

### Opção 1: Executar Diretamente (Portable)

1. Navegue até a pasta: `release/win-unpacked/`
2. Execute `LeadHunter Pro.exe`
3. A aplicação abrirá imediatamente

### Opção 2: Copiar para Outra Máquina

1. Copie toda a pasta `win-unpacked` para o computador de destino
2. Execute `LeadHunter Pro.exe` de qualquer local
3. **Importante**: Mantenha todos os arquivos da pasta juntos!

## 🎮 Usando a Aplicação

1. **Digite o termo de busca** no Google Maps (ex: "restaurantes em São Paulo")
2. **Clique em "Iniciar Busca"**
3. **Aguarde**: A aplicação abrirá um navegador automaticamente e coletará os dados
4. **Progresso**: Veja em tempo real quantos leads foram coletados
5. **Arquivo Excel**: Será salvo automaticamente na sua **Área de Trabalho** com nome como:
   ```
   Google Maps Leads - YYYY-MM-DD-HH-mm-ss.xlsx
   ```

## 📊 O que é coletado?

- ✅ Nome do estabelecimento
- ✅ Telefone
- ✅ Avaliação (estrelas)
- ✅ Endereço
- ✅ URL do Google Maps

## ⚙️ Configurações

### Limite de Resultados

- Padrão: **50 leads**
- Máximo suportado: **200 leads** (limitação do Google Maps)

### Espera Entre Scrolls

- Padrão: **2000ms (2 segundos)**
- Ajuste conforme sua conexão de internet
- Conexão lenta: Aumente para 3000-4000ms
- Conexão rápida: Mantenha em 2000ms

## 🔧 Requisitos

- ✅ **Windows 10/11** (64-bit)
- ✅ **Nenhuma instalação necessária** - Totalmente portátil
- ✅ **Navegador incluído** - Playwright Chromium já está empacotado
- ✅ **Sem dependências externas**

## ⚠️ Notas Importantes

### Erros Normais (Podem ser ignorados)

Ao iniciar, você pode ver no terminal:

```
ERROR:cache_util_win.cc - Unable to move cache
ERROR:disk_cache.cc - Unable to create cache
```

**Esses erros são normais** e não afetam o funcionamento da aplicação.

### Playwright/Chromium

- O navegador Chromium está **incluído** no executável
- Não é necessário instalar Chrome ou outro navegador
- A aplicação usa Playwright que automaticamente gerencia o navegador

### Arquivos Excel

- Salvos automaticamente na **Área de Trabalho** do Windows
- Formato: `.xlsx` (compatível com Excel, Google Sheets, etc.)
- Nome inclui data e hora para evitar sobrescrever arquivos

## 🐛 Troubleshooting

### "A aplicação não abre"

- Verifique se tem todos os arquivos da pasta `win-unpacked`
- Execute como Administrador (clique direito → "Executar como administrador")
- Verifique se o Windows Defender não está bloqueando

### "Navegador não abre"

- Confirme que a pasta `resources/app.asar.unpacked/node_modules/playwright-core` existe
- Reinstale: copie novamente toda a pasta `win-unpacked`

### "Nenhum dado coletado"

- Verifique sua conexão com a internet
- Tente aumentar o "Delay Entre Scrolls" para 3000-4000ms
- Use termos de busca mais específicos (ex: "pizzaria em Rio de Janeiro" ao invés de apenas "pizzaria")

## 📝 Logs e Debug

A aplicação exibe logs em tempo real na interface:

- 🔵 **INFO**: Progresso normal
- 🟡 **WARN**: Avisos (ex: telefone não encontrado)
- 🔴 **ERROR**: Erros (problemas de conexão)

## 🔄 Atualizações

Para atualizar a aplicação:

1. Faça um novo build: `npm run build`
2. Substitua a pasta `win-unpacked` pela nova versão
3. Ou copie apenas `LeadHunter Pro.exe` (se não houver mudanças em dependências)

## 📦 Distribuição

### Para Distribuir para Outros Usuários:

1. **Opção Simples**: Compacte toda a pasta `win-unpacked` em ZIP
2. **Instruções**: Inclua este README e peça para extrair tudo antes de executar
3. **Tamanho**: ~200-250 MB (inclui Chromium completo)

### Criar Instalador (Futuro):

Para criar um instalador `.exe` tradicional, você precisará:

1. Habilitar o target NSIS no `package.json`
2. Executar PowerShell/Terminal como **Administrador**
3. Rebuild: `npm run build`

Isso gerará um instalador em `release/LeadHunter Pro Setup X.X.X.exe`

## 🎨 Interface

A aplicação possui uma interface moderna no estilo "cyberpunk":

- 🌙 Tema escuro
- 📊 Estatísticas em tempo real
- 📝 Log de atividades
- 📋 Tabela de resultados ao vivo

## 🛠️ Desenvolvimento

Se você quiser modificar o código:

```bash
# Instalar dependências
npm install

# Executar em modo desenvolvimento
npm run dev

# Compilar novo executável
npm run build
```

O executável estará em: `release/win-unpacked/LeadHunter Pro.exe`

---

## ✨ Tecnologias Utilizadas

- **Electron 30** - Framework desktop
- **React 18** - Interface do usuário
- **TypeScript** - Linguagem com tipos
- **Playwright** - Automação de navegador
- **ExcelJS** - Geração de planilhas
- **Tailwind CSS** - Estilização

---

**Desenvolvido por Tech4Loop** 🚀
