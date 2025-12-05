# 🚀 Build para Executável - LeadHunter Pro

## ⚡ Comando Rápido

```powershell
cd C:\Users\haduk\OneDrive\Desktop\Extrator_Leads\LeadHunter-Tech4Loop
npm run build
```

## 📦 O Que Será Gerado

**Localização**: `release/`

**Arquivos**:

- `LeadHunter Pro Setup X.X.X.exe` - Instalador NSIS
- `LeadHunter Pro X.X.X.exe` - Executável portátil

**Tamanho**: ~120-150MB (inclui Chromium)

## ⚙️ Configurações Aplicadas

✅ **Playwright incluído** - Browser automation embutido
✅ **ExcelJS incluído** - Exportação Excel nativa
✅ **Preload correto** - IPC funcionando
✅ **Sandbox desabilitado** - Para Playwright funcionar
✅ **ASAR com unpack** - Playwright fora do arquivo compactado
✅ **Instalador NSIS** - Instalação customizável

## 🎯 Após Build

1. **Navegue até** `release/`
2. **Execute** `LeadHunter Pro Setup X.X.X.exe`
3. **Instale** no local desejado
4. **Abra** o aplicativo
5. **Teste** extração real

## ✅ Funcionará no Executável

- ✅ Janela frameless com controles
- ✅ IPC communication ativa
- ✅ Playwright abrindo Chromium
- ✅ Google Maps scraping
- ✅ Excel export para Desktop
- ✅ Todos recursos funcionais

## 🐛 Se Houver Erro

**"Chromium not found"**:

- Chromium está incluído no build
- Deve funcionar automaticamente

**"IPC não disponível"**:

- Preload.mjs configurado corretamente
- Sandbox desabilitado

**"Cannot find module"**:

- Playwright e ExcelJS estão no asar
- Dependencies incluídas

## 🏆 Pronto para Distribuir

O executável gerado é **completamente standalone**:

- ✅ Não precisa Node.js instalado
- ✅ Não precisa Python
- ✅ Chromium incluído
- ✅ Todas bibliotecas embutidas
- ✅ Pode ser distribuído para outros usuários

---

**Tempo estimado**: 2-5 minutos para build completo
