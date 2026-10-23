"""Planejador de aportes — servidor local.

Busca a carteira (posição atual + porcentagens ideais) no Investidor10,
indicadores de cada ativo (P/VP, P/L, DY, LPA, VPA) nas páginas públicas do
Investidor10 e cotações/faixa de 52 semanas no Yahoo Finance. Tudo gratuito,
sem chave de API. Serve a página em http://localhost:8010.
"""

import html
import json
import re
import threading
import time
import unicodedata
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PASTA = Path(__file__).resolve().parent
CONFIG = json.loads((PASTA / "config.json").read_text(encoding="utf-8"))
PORTA = CONFIG.get("porta", 8010)
CACHE_ARQUIVO = PASTA / "cache.json"
CACHE_MINUTOS = CONFIG.get("cache_minutos", 30)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
I10 = "https://investidor10.com.br"
API_CARTEIRA = I10 + "/wallet/api/proxy/wallet-app/patrimony/{id}/diversification/{chave}"

# tipo na API -> (chave de diversificação, caminho da página do ativo, nome do ideal por tipo)
CLASSES = {
    "Ticker": ("Ticker,ticker-ideal", "acoes", "Ações"),
    "Fii": ("Fii,fii-ideal", "fiis", "FIIs"),
    "Treasure": ("Treasure,treasure-ideal", None, "Tesouro Direto"),
    "Stock": ("Stock,stock-ideal", "stocks", "Stocks"),
    "EtfInternational": ("EtfInternational,etfinternational-ideal", "etfs-global", "ETFs Internacionais"),
    "Crypto": ("Crypto,crypto-ideal", None, "Criptomoedas"),
}

_trava = threading.Lock()
BRASILIA = timezone(timedelta(hours=-3))


def baixar(url, tentativas=2):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", errors="ignore")
        except Exception:
            if i == tentativas - 1:
                raise
            time.sleep(1.5)


def normalizar(txt):
    txt = unicodedata.normalize("NFKD", txt).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", txt).strip().lower()


def numero_br(txt):
    """'R$ 1.234,56' / '12,63%' -> float."""
    if txt is None:
        return None
    m = re.search(r"-?[\d.]*\d(?:,\d+)?", txt.replace(" ", ""))
    if not m:
        return None
    try:
        return float(m.group(0).replace(".", "").replace(",", "."))
    except ValueError:
        return None


def numero(txt):
    try:
        return float(txt)
    except (TypeError, ValueError):
        return None


def limpar_html(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def indicadores_investidor10(caminho, ticker):
    """Lê os cards do topo e a tabela de indicadores da página do ativo."""
    pagina = baixar(f"{I10}/{caminho}/{ticker.lower()}/")
    cards = {}
    for parte in pagina.split('<div class="_card ')[1:]:
        titulo = re.search(r'title="([^"]+)"', parte)
        corpo = parte.find("_card-body")
        valor = re.search(r"<span[^>]*>(.*?)</span>", parte[corpo:], re.S) if corpo > 0 else None
        if titulo and valor:
            cards[normalizar(titulo.group(1))] = limpar_html(valor.group(1))
    tabela = {normalizar(k): numero(v) for k, v in
              re.findall(r'data-indicator="([^"]+)"\s+data-current-value="([^"]*)"', pagina)}

    def card(*nomes):
        for n in nomes:
            for k, v in cards.items():
                if k.endswith(n):
                    return numero_br(v)
        return None

    def tab(*nomes):
        for n in nomes:
            if tabela.get(n) is not None:
                return tabela[n]
        return None

    return {
        "preco_i10": card("cotacao", "valor atual"),
        "pvp": tab("p/vp") or card("p/vp"),
        "pl": tab("p/l") or card("p/l"),
        "dy": tab("dividend yield", "dividend yield (dy)") or card("dividend yield", "dy (12m)", "dy"),
        "lpa": tab("lpa"),
        "vpa": tab("vpa"),
        "roe": tab("roe"),
    }


def yahoo(simbolo):
    """Cotação atual, faixa de 52 semanas e média de 12 meses."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(simbolo)}?range=1y&interval=1wk"
    d = json.loads(baixar(url))["chart"]["result"][0]
    meta = d["meta"]
    fechamentos = [x for x in d["indicators"]["quote"][0]["close"] if x]
    preco = meta.get("regularMarketPrice") or (fechamentos[-1] if fechamentos else None)
    # faixa pelos fechamentos semanais: o min/max intradiário do Yahoo às vezes vem com cotação errada
    faixa = fechamentos + ([preco] if preco else [])
    return {
        "preco": preco,
        "max52": max(faixa) if faixa else meta.get("fiftyTwoWeekHigh"),
        "min52": min(faixa) if faixa else meta.get("fiftyTwoWeekLow"),
        "media12m": sum(fechamentos) / len(fechamentos) if fechamentos else None,
        "moeda": meta.get("currency"),
    }


def simbolo_yahoo(tipo, ticker):
    if tipo in ("Ticker", "Fii"):
        return ticker + ".SA"
    if tipo == "Crypto":
        return ticker + "-USD"
    if tipo in ("Stock", "EtfInternational"):
        return ticker.replace(".", "-")
    return None


def carregar_ativo(tipo, ticker):
    caminho = CLASSES[tipo][1]
    dados = {"erros": []}
    if caminho:
        try:
            dados.update(indicadores_investidor10(caminho, ticker))
        except Exception as e:
            dados["erros"].append(f"Investidor10: {e}")
    sy = simbolo_yahoo(tipo, ticker)
    if sy:
        try:
            dados.update(yahoo(sy))
        except Exception as e:
            dados["erros"].append(f"Yahoo: {e}")
    if not dados.get("preco") and dados.get("preco_i10"):
        dados["preco"] = dados["preco_i10"]
    return dados


def montar_dados():
    wid = CONFIG["carteira_id"]
    geral = json.loads(baixar(API_CARTEIRA.format(id=wid, chave="all,ideal-per-type")))
    ideal_por_nome = {normalizar(i["name"]): i["percent"] for i in geral.get("ideal", [])}
    atual_por_tipo = {v["type"]: v["value"] for v in geral.get("values", [])}

    classes = []
    tarefas = []
    for tipo, (chave, _, nome_ideal) in CLASSES.items():
        bruto = json.loads(baixar(API_CARTEIRA.format(id=wid, chave=chave)))
        ideais = {normalizar(i["name"]): i["percent"] for i in bruto.get("ideal", [])}
        ativos = []
        nomes = {v["name"] for v in bruto.get("values", [])} | {i["name"] for i in bruto.get("ideal", []) if i.get("percent")}
        atuais = {v["name"]: v["value"] for v in bruto.get("values", [])}
        for nome in sorted(nomes, key=str.upper):
            ativos.append({
                "ticker": nome,
                "atual": atuais.get(nome, 0.0),
                "ideal": ideais.get(normalizar(nome), 0.0),
            })
        # tickers repetidos em maiúsculas/minúsculas (ex.: "Tesouro Selic 2031" e "TESOURO SELIC 2031")
        unicos = {}
        for a in ativos:
            k = normalizar(a["ticker"])
            if k in unicos:
                unicos[k]["atual"] += a["atual"]
                unicos[k]["ideal"] = max(unicos[k]["ideal"], a["ideal"])
            else:
                unicos[k] = a
        ativos = list(unicos.values())
        classe = {
            "tipo": tipo,
            "nome": nome_ideal,
            "atual": atual_por_tipo.get(tipo, sum(a["atual"] for a in ativos)),
            "ideal": ideal_por_nome.get(normalizar(nome_ideal), 0.0),
            "ativos": ativos,
        }
        classes.append(classe)
        for a in ativos:
            tarefas.append((tipo, a))

    with ThreadPoolExecutor(max_workers=8) as pool:
        resultados = pool.map(lambda t: carregar_ativo(t[0], t[1]["ticker"]), tarefas)
        for (tipo, ativo), info in zip(tarefas, resultados):
            ativo["mercado"] = info

    try:
        dolar = yahoo("BRL=X")
    except Exception as e:
        dolar = {"erro": str(e)}
    try:
        aw = json.loads(baixar("https://economia.awesomeapi.com.br/json/last/USD-BRL"))["USDBRL"]
        dolar["preco"] = float(aw["bid"])
    except Exception:
        pass

    return {"atualizado_em": datetime.now(BRASILIA).strftime("%d/%m/%Y %H:%M"), "carteira_id": wid,
            "dolar": dolar, "classes": classes}


def obter_dados(forcar=False):
    with _trava:
        if not forcar and CACHE_ARQUIVO.exists():
            idade = (time.time() - CACHE_ARQUIVO.stat().st_mtime) / 60
            if idade < CACHE_MINUTOS:
                return CACHE_ARQUIVO.read_text(encoding="utf-8")
        texto = json.dumps(montar_dados(), ensure_ascii=False)
        CACHE_ARQUIVO.write_text(texto, encoding="utf-8")
        return texto


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PASTA / "web"), **kw)

    def do_GET(self):
        if self.path.startswith("/api/dados"):
            try:
                corpo = obter_dados(forcar="atualizar=1" in self.path).encode("utf-8")
                self.send_response(200)
            except Exception as e:
                corpo = json.dumps({"erro": str(e)}, ensure_ascii=False).encode("utf-8")
                self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    import sys

    # modo usado pelo GitHub Actions: só gera o arquivo de dados para o site estático
    if len(sys.argv) == 3 and sys.argv[1] == "--gerar":
        Path(sys.argv[2]).write_text(json.dumps(montar_dados(), ensure_ascii=False), encoding="utf-8")
        sys.exit(0)

    servidor = ThreadingHTTPServer(("127.0.0.1", PORTA), Handler)
    url = f"http://localhost:{PORTA}"
    print(f"Planejador rodando em {url}  (Ctrl+C para encerrar)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
