"""
EXEMPLO: Como Modificar main.py para Integração com Electron

Este arquivo mostra as mudanças necessárias no script Python (main.py)
para comunicação com a interface Electron via JSON output.
"""

import json
import sys

# ====================================================================
# 1. FUNÇÃO AUXILIAR PARA ENVIAR JSON (adicionar no início do script)
# ====================================================================

def send_json(data):
    """Envia dados JSON para stdout (capturado pelo Electron)"""
    print(json.dumps(data, ensure_ascii=False), flush=True)


# ====================================================================
# 2. MODIFICAR FUNÇÃO scroll_results_panel() - Enviar Progresso
# ====================================================================

def scroll_results_panel(page, max_scrolls=30):
    """
    Rola o painel de resultados para carregar mais estabelecimentos
    E ENVIA progresso para o Electron
    """
    panel_selector = 'div[role="feed"]'
    
    if not page.locator(panel_selector).count():
        print("Painel de resultados não encontrado.")
        return
    
    previous_count = 0
    no_change_count = 0
    
    for scroll in range(max_scrolls):
        page.locator(panel_selector).first.evaluate('el => el.scrollBy(0, el.scrollHeight)')
        time.sleep(2)
        
        current_count = page.locator('div[role="feed"] > div > div > a').count()
        
        # ✅ ENVIAR PROGRESSO PARA ELECTRON
        send_json({
            "type": "progress",
            "current": scroll + 1,
            "total": max_scrolls,
            "percentage": int((scroll + 1) / max_scrolls * 100)
        })
        
        if current_count > previous_count:
            print(f"Scroll {scroll + 1}/{max_scrolls}: Carregou {current_count} resultados até agora.")
            previous_count = current_count
            no_change_count = 0
        else:
            no_change_count += 1
            print(f"Scroll {scroll + 1}/{max_scrolls}: Sem novos resultados ({no_change_count}).")
        
        if no_change_count >= 3:
            print("Parece que chegamos ao fim dos resultados. Encerrando rolagem.")
            break
    
    print(f"Rolagem concluída. Total de resultados carregados: {previous_count}")


# ====================================================================
# 3. MODIFICAR extract_details_from_place() - Enviar Cada Lead
# ====================================================================

def extract_details_from_place(page):
    """
    Extrai dados de um estabelecimento após clicar nele
    E ENVIA cada lead para o Electron
    """
    time.sleep(2)
    
    name = safe_inner_text(page, 'h1.DUwDvf.lfPIob')
    rating = safe_inner_text(page, 'div.F7nice span[role="img"]')
    phone = safe_inner_text(page, 'button[data-item-id*="phone:tel:"]')
    address = safe_inner_text(page, 'button[data-item-id^="address"]')
    url = page.url
    
    # ✅ ENVIAR LEAD PARA ELECTRON
    lead_id = f"lead_{int(time.time() * 1000)}"  # ID único baseado em timestamp
    
    send_json({
        "type": "lead",
        "id": lead_id,
        "name": name if name else "N/A",
        "rating": rating if rating else "N/A",
        "phone": phone if phone else "N/A",
        "address": address if address else "N/A",
        "url": url
    })
    
    return {
        'Nome': name if name else "N/A",
        'Nota': rating if rating else "N/A",
        'Telefone': phone if phone else "N/A",
        'Endereço': address if address else "N/A",
        'URL': url
    }


# ====================================================================
# 4. MODIFICAR save_results_to_excel() - Enviar Conclusão
# ====================================================================

def save_results_to_excel(results, filename='google_maps_results.xlsx'):
    """
    Salva os resultados em um arquivo Excel com formatação
    E ENVIA mensagem de conclusão para o Electron
    """
    if not results:
        print("Nenhum resultado para salvar.")
        return
    
    df = pd.DataFrame(results)
    
    with pd.ExcelWriter(filename, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Resultados')
        
        workbook = writer.book
        worksheet = writer.sheets['Resultados']
        
        # ... (código de formatação existente) ...
        
        for col in worksheet.columns:
            max_length = 0
            column = col[0].column_letter
            for cell in col:
                if cell.value:
                    max_length = max(max_length, len(str(cell.value)))
            adjusted_width = max_length + 2
            worksheet.column_dimensions[column].width = adjusted_width
        
        worksheet.freeze_panes = 'A2'
    
    # ✅ ENVIAR CONCLUSÃO PARA ELECTRON
    full_path = os.path.abspath(filename)
    
    send_json({
        "type": "complete",
        "totalLeads": len(results),
        "filePath": full_path
    })
    
    print(f"\nResultados salvos com sucesso em: {filename}")
    print(f"Total de estabelecimentos extraídos: {len(results)}")


# ====================================================================
# 5. ADICIONAR HANDLER DE ARGUMENTOS (se ainda não tiver)
# ====================================================================

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Google Maps Lead Extractor')
    parser.add_argument('--search', type=str, required=True, help='Termo de busca')
    parser.add_argument('--max-results', type=int, default=200, help='Máximo de resultados')
    parser.add_argument('--headless', action='store_true', help='Executar em modo headless')
    
    args = parser.parse_args()
    
    # ✅ Enviar log de início
    send_json({
        "type": "log",
        "level": "info",
        "message": f"Iniciando extração: {args.search}"
    })
    
    try:
        # ... executar scraping com args.search, args.max_results, args.headless ...
        pass
        
    except Exception as e:
        # ✅ Enviar erro para Electron
        send_json({
            "type": "error",
            "message": str(e)
        })
        sys.exit(1)


# ====================================================================
# RESUMO DAS MUDANÇAS
# ====================================================================
"""
1. ✅ Adicionar função send_json() no início do script
2. ✅ Em scroll_results_panel(): Enviar progresso a cada scroll
3. ✅ Em extract_details_from_place(): Enviar cada lead extraído
4. ✅ Em save_results_to_excel(): Enviar conclusão com path do arquivo
5. ✅ No main: Adicionar argparse para receber --search, --max-results, --headless
6. ✅ Em try/except: Enviar erros via JSON

FORMATO DOS JSONS:
- Progress: {"type": "progress", "current": int, "total": int, "percentage": int}
- Lead: {"type": "lead", "id": str, "name": str, "rating": str, "phone": str, "address": str, "url": str}
- Complete: {"type": "complete", "totalLeads": int, "filePath": str}
- Error: {"type": "error", "message": str}
- Log: {"type": "log", "level": str, "message": str}

IMPORTANTE:
- Usar flush=True no print para envio imediato
- ensure_ascii=False para caracteres especiais (acentos, ç, etc.)
- Gerar IDs únicos para cada lead (timestamp ou uuid)
"""
