// Planejador de aportes: divide o aporte do mês entre classes e ativos,
// seguindo as metas da carteira e dando peso extra ao que está barato.

const USD = new Set(["Stock", "EtfInternational", "Crypto"]);
const COTA_INTEIRA = new Set(["Ticker", "Fii"]); // B3: só compra unidade inteira

const $ = (id) => document.getElementById(id);
const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const fmtR = (v) => (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtUS = (v) => "US$ " + fmtN(v, 2);
const fmtN = (v, d = 2) =>
  v == null || isNaN(v) ? "–" : v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtP = (v, d = 1) => fmtN(v * 100, d) + "%";

let DADOS = null;
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);

// ---------- análise de oportunidade ----------

function analisarDolar(d) {
  if (!d || !d.preco) return { score: 0, tags: [] };
  const partes = [];
  const tags = [];
  if (d.max52 > d.min52) {
    const pos = clamp((d.preco - d.min52) / (d.max52 - d.min52), 0, 1);
    partes.push([0.5, 1 - 2 * pos]);
    if (pos <= 0.25) tags.push({ t: "Perto da mínima de 12 meses" });
    if (pos >= 0.85) tags.push({ t: "Perto da máxima de 12 meses", ruim: true });
  }
  if (d.media12m) {
    const desc = (d.media12m - d.preco) / d.media12m;
    partes.push([0.5, clamp(desc / 0.08)]);
    if (desc >= 0.02) tags.push({ t: `${fmtP(desc)} abaixo da média 12m` });
    if (desc <= -0.02) tags.push({ t: `${fmtP(-desc)} acima da média 12m`, ruim: true });
  }
  return { score: media(partes), tags };
}

function media(partes) {
  const w = partes.reduce((s, p) => s + p[0], 0);
  return w ? partes.reduce((s, p) => s + p[0] * p[1], 0) / w : 0;
}

function analisarAtivo(ativo, tipo, ctx) {
  const m = ativo.mercado || {};
  const tags = [];
  if (tipo === "Treasure" || !m.preco) return { score: 0, tags };
  const partes = [];
  const pesoFaixa = { Ticker: 0.3, Fii: 0.25 }[tipo] ?? 0.5;
  const pesoMedia = { Ticker: 0.2, Fii: 0.15 }[tipo] ?? 0.5;

  if (m.max52 > m.min52) {
    const pos = clamp((m.preco - m.min52) / (m.max52 - m.min52), 0, 1);
    partes.push([pesoFaixa, 1 - 2 * pos]);
    if (pos <= 0.25) tags.push({ t: "Perto da mínima 52s" });
    if (pos >= 0.92) tags.push({ t: "Na máxima 52s", ruim: true });
  }
  if (m.media12m) {
    const desc = (m.media12m - m.preco) / m.media12m;
    partes.push([pesoMedia, clamp(desc / 0.15)]);
    if (desc >= 0.05) tags.push({ t: `${fmtP(desc, 0)} abaixo da média 12m` });
    if (desc <= -0.2) tags.push({ t: `${fmtP(-desc, 0)} acima da média 12m`, ruim: true });
  }

  if (tipo === "Ticker") {
    const pvp = m.pvp;
    partes.push([0.2, pvp > 0 && pvp < 1 ? clamp((1 - pvp) / 0.3, 0, 1) : 0]);
    if (pvp > 0 && pvp < 1) tags.push({ t: `P/VP ${fmtN(pvp)}` });
    // Graham: valor intrínseco = √(22,5 × LPA × VPA)
    let graham = 0;
    if (m.lpa > 0 && m.vpa > 0) {
      const vi = Math.sqrt(22.5 * m.lpa * m.vpa);
      const margem = (vi - m.preco) / m.preco;
      graham = clamp(margem / 0.3, 0, 1);
      if (margem >= 0.1) tags.push({ t: `Graham +${fmtP(margem, 0)}` });
    }
    partes.push([0.15, graham]);
    // Bazin: compra com DY ≥ 6%
    partes.push([0.15, m.dy ? clamp((m.dy - 6) / 4, 0, 1) : 0]);
    if (m.dy >= 6) tags.push({ t: `DY ${fmtN(m.dy, 1)}%` });
  }

  if (tipo === "Fii") {
    const pvp = m.pvp;
    if (pvp > 0) {
      partes.push([0.5, clamp((1 - pvp) / 0.15)]);
      if (pvp < 1) tags.push({ t: `P/VP ${fmtN(pvp)}` });
      if (pvp > 1.05) tags.push({ t: `P/VP ${fmtN(pvp)}`, ruim: true });
    }
    if (m.dy && ctx.dyMedioFii) {
      partes.push([0.1, clamp((m.dy - ctx.dyMedioFii) / 3)]);
      if (m.dy >= ctx.dyMedioFii + 1.5) tags.push({ t: `DY ${fmtN(m.dy, 1)}%` });
    }
  }

  let score = media(partes);
  if (USD.has(tipo)) score = 0.65 * score + 0.35 * ctx.dolar.score;
  return { score: clamp(score), tags };
}

const nota = (score) => Math.round((score + 1) * 50) / 10; // -1..1 -> 0..10
function seloNota(score) {
  const n = nota(score);
  const cls = n >= 6.5 ? "alta" : n < 4 ? "baixa" : "media";
  return `<span class="nota ${cls}" title="Nota de oportunidade (0 a 10)">${fmtN(n, 1)}</span>`;
}

// ---------- distribuição ----------

// Reparte `total` proporcional a `peso`, sem passar do `teto` de cada item.
function distribuir(total, itens) {
  const out = itens.map(() => 0);
  let resto = total;
  let abertos = itens.map((_, i) => i).filter((i) => itens[i].peso > 0 && itens[i].teto > 0);
  for (let volta = 0; volta < 60 && resto > 0.005 && abertos.length; volta++) {
    const soma = abertos.reduce((s, i) => s + itens[i].peso, 0);
    let usado = 0;
    const seguem = [];
    for (const i of abertos) {
      const d = Math.min((resto * itens[i].peso) / soma, itens[i].teto - out[i]);
      out[i] += d;
      usado += d;
      if (out[i] < itens[i].teto - 1e-6) seguem.push(i);
    }
    resto -= usado;
    abertos = seguem;
  }
  return { out, resto: Math.max(0, resto) };
}

// Primeiro preenche o que falta para a meta (ajustado pela oportunidade);
// o que sobrar vai proporcional à meta × oportunidade.
function alocar(total, itens) {
  const fase1 = distribuir(
    total,
    itens.map((it) => ({ peso: it.falta * it.mult, teto: it.falta * it.mult }))
  );
  const fase2 = distribuir(
    fase1.resto,
    itens.map((it) => ({ peso: it.ideal * it.mult, teto: Infinity }))
  );
  return itens.map((_, i) => fase1.out[i] + fase2.out[i]);
}

function calcular(aporte, cfg) {
  const k = cfg.k;
  const multDe = (score) => Math.max(0.15, 1 + k * score);
  // oportunidade também estica (ou encolhe) a meta em até 30%
  const metaEf = (ideal, score) => (ideal / 100) * (1 + k * score * 0.3);
  const dolar = DADOS.dolar;
  const ctx = { dolar: analisarDolar(dolar) };
  const fii = DADOS.classes.find((c) => c.tipo === "Fii");
  const dys = fii ? fii.ativos.map((a) => a.mercado?.dy).filter((x) => x > 0) : [];
  ctx.dyMedioFii = dys.length ? dys.reduce((s, x) => s + x, 0) / dys.length : null;

  const classes = DADOS.classes.map((c) => {
    const ativos = c.ativos.map((a) => ({ ...a, ...analisarAtivo(a, c.tipo, ctx) }));
    const somaIdeal = ativos.reduce((s, a) => s + a.ideal, 0) || 1;
    let score = ativos.reduce((s, a) => s + a.score * a.ideal, 0) / somaIdeal;
    return { ...c, ativos, score, ligada: cfg.classes[c.tipo] !== false };
  });

  const totalAtual = classes.reduce((s, c) => s + c.atual, 0);
  const totalDepois = totalAtual + aporte;
  let ligadas = classes.filter((c) => c.ligada && c.ideal > 0);

  // classes que receberiam menos que o mínimo saem e o valor vai para as outras
  for (;;) {
    const porClasse = alocar(
      aporte,
      ligadas.map((c) => ({
        falta: Math.max(0, metaEf(c.ideal, c.score) * totalDepois - c.atual),
        ideal: c.ideal,
        mult: multDe(c.score),
      }))
    );
    ligadas.forEach((c, i) => (c.aporte = porClasse[i]));
    const pequenas = ligadas.filter((c) => c.aporte > 0 && c.aporte < cfg.minimo);
    if (!pequenas.length || pequenas.length === ligadas.length) break;
    const menor = pequenas.reduce((x, y) => (y.aporte < x.aporte ? y : x));
    menor.aporte = 0;
    ligadas = ligadas.filter((c) => c !== menor);
  }

  let sobra = 0;
  for (const c of classes) {
    c.aporte = c.aporte || 0;
    c.ativos.forEach((a) => (a.aporte = 0));
    if (!c.aporte) continue;
    const depois = c.atual + c.aporte;
    const cand = c.ativos
      .filter((a) => a.ideal > 0)
      .map((a) => ({
        a,
        falta: Math.max(0, metaEf(a.ideal, a.score) * depois - a.atual),
        mult: multDe(a.score),
      }));
    cand.forEach((x) => (x.prioridade = x.falta > 0 ? x.falta * x.mult : 0));
    let escolhidos = cand.filter((x) => x.prioridade > 0).sort((x, y) => y.prioridade - x.prioridade);
    if (!escolhidos.length) escolhidos = [...cand].sort((x, y) => y.a.ideal * y.mult - x.a.ideal * x.mult);
    escolhidos = escolhidos.slice(0, cfg.maxAtivos);

    const valores = alocar(
      c.aporte,
      escolhidos.map((x) => ({ falta: x.falta, ideal: x.a.ideal, mult: x.mult }))
    );
    escolhidos.forEach((x, i) => {
      x.a.aporte = valores[i];
      x.a.escolhido = true;
    });

    // arredonda para cotas inteiras na B3; o troco volta para o caixa
    if (COTA_INTEIRA.has(c.tipo)) {
      for (const x of escolhidos) {
        const p = x.a.mercado?.preco;
        if (!p) continue;
        const qtd = Math.floor(x.a.aporte / p + 1e-9);
        sobra += x.a.aporte - qtd * p;
        x.a.aporte = qtd * p;
      }
    }
  }

  // troco: compra mais uma cota dos escolhidos com melhor oportunidade, enquanto couber
  const inteiros = classes
    .filter((c) => c.ligada && COTA_INTEIRA.has(c.tipo))
    .flatMap((c) => c.ativos.filter((a) => a.escolhido && a.mercado?.preco))
    .sort((x, y) => y.score - x.score);
  let comprou = true;
  while (comprou) {
    comprou = false;
    for (const a of inteiros) {
      if (a.mercado.preco <= sobra + 1e-6) {
        a.aporte += a.mercado.preco;
        sobra -= a.mercado.preco;
        comprou = true;
        break;
      }
    }
  }
  // o que não fecha uma cota vai para o Tesouro Selic, se ele estiver no aporte
  const tesouro = classes.find((c) => c.tipo === "Treasure" && c.ligada && c.ativos.length);
  if (tesouro && sobra > 0.01) {
    const alvo = tesouro.ativos.find((a) => a.ideal > 0) || tesouro.ativos[0];
    alvo.aporte += sobra;
    alvo.escolhido = true;
    sobra = 0;
  }
  for (const c of classes) c.aporte = c.ativos.reduce((s, a) => s + a.aporte, 0);

  return { classes, totalAtual, totalDepois, sobra, ctx };
}

// ---------- tela ----------

function quantidade(a, tipo) {
  const p = a.mercado?.preco;
  if (!a.aporte || !p) return "";
  if (COTA_INTEIRA.has(tipo)) return `${Math.round(a.aporte / p)} ${tipo === "Fii" ? "cotas" : "ações"}`;
  if (USD.has(tipo)) {
    const usd = a.aporte / DADOS.dolar.preco;
    const casas = tipo === "Crypto" ? 6 : 4;
    return `${fmtUS(usd)} · ${fmtN(usd / p, casas)} ${tipo === "Crypto" ? a.ticker : "un."}`;
  }
  return "";
}

function precoTxt(a, tipo) {
  const p = a.mercado?.preco;
  if (tipo === "Treasure") return "–";
  if (!p) return `<span class="erro" title="${(a.mercado?.erros || []).join(" | ")}">sem cotação</span>`;
  return USD.has(tipo) ? fmtUS(p) : fmtR(p);
}

function indicadoresTxt(a, tipo) {
  const m = a.mercado || {};
  const it = [];
  if (m.pvp != null && tipo !== "Stock") it.push(`P/VP ${fmtN(m.pvp)}`);
  if (m.pl != null && tipo === "Ticker") it.push(`P/L ${fmtN(m.pl, 1)}`);
  if (m.pl != null && tipo === "Stock") it.push(`P/L ${fmtN(m.pl, 1)}`);
  if (m.dy != null && tipo !== "Stock") it.push(`DY ${fmtN(m.dy, 1)}%`);
  return it.join(" · ") || "–";
}

function tagsHtml(tags) {
  return `<div class="tags">${tags.map((t) => `<span class="tag${t.ruim ? " ruim" : ""}">${t.t}</span>`).join("")}</div>`;
}

function render(r, aporte) {
  $("resultado").hidden = false;
  $("resumo").innerHTML = `
    <div><span>Aporte</span><b>${fmtR(aporte)}</b></div>
    <div><span>Patrimônio hoje</span><b>${fmtR(r.totalAtual)}</b></div>
    <div><span>Depois do aporte</span><b>${fmtR(r.totalDepois - r.sobra)}</b></div>
    <div><span>Troco que sobra</span><b>${fmtR(r.sobra)}</b></div>`;

  const ordem = [...r.classes].sort((x, y) => y.aporte - x.aporte);
  $("classes").innerHTML = ordem
    .map((c) => {
      const pctAtual = r.totalAtual ? c.atual / r.totalAtual : 0;
      const pctDepois = (c.atual + c.aporte) / (r.totalDepois - r.sobra);
      const meta = c.ideal / 100;
      const preench = meta ? clamp(pctDepois / meta, 0, 1.0) : 0;
      const ativos = [...c.ativos].sort((x, y) => y.aporte - x.aporte || y.score - x.score);
      const linhas = ativos
        .map((a) => {
          const pctNaClasse = c.atual ? a.atual / c.atual : 0;
          return `<tr class="${a.aporte > 0 ? "compra" : ""}">
            <td><b>${a.ticker}</b></td>
            <td class="num">${precoTxt(a, c.tipo)}</td>
            <td class="col-opc">${indicadoresTxt(a, c.tipo)}</td>
            <td>${c.tipo === "Treasure" ? "–" : seloNota(a.score)}${a.tags.length ? tagsHtml(a.tags) : ""}</td>
            <td class="num col-opc">${fmtP(pctNaClasse)} <small>/ ${fmtN(a.ideal, 1)}%</small></td>
            <td class="num aporte">${a.aporte > 0 ? fmtR(a.aporte) : "–"}</td>
            <td class="num">${quantidade(a, c.tipo)}</td>
          </tr>`;
        })
        .join("");
      return `<section class="painel classe ${c.aporte > 0 ? "" : "zerada"}">
        <div class="classe-head">
          <h2>${c.nome} ${c.tipo !== "Treasure" ? seloNota(c.score) : ""}</h2>
          <span class="valor-classe">${c.aporte > 0 ? fmtR(c.aporte) : c.ligada ? "Não aportar agora" : "Fora deste aporte"}</span>
        </div>
        <div class="meta-linha">Hoje ${fmtP(pctAtual)} · Meta ${fmtN(c.ideal, 0)}% · Depois do aporte ${fmtP(pctDepois)}</div>
        <div class="barra" title="Quanto da meta a classe vai atingir"><i style="width:${preench * 100}%"></i></div>
        <div class="tabela-wrap"><table>
          <thead><tr><th>Ativo</th><th class="num">Preço</th><th class="col-opc">Indicadores</th><th>Oportunidade</th>
          <th class="num col-opc">Na classe / meta</th><th class="num">Aportar</th><th class="num">Quantidade</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table></div>
      </section>`;
    })
    .join("");
}

function renderOportunidades() {
  const cfg = lerCfg();
  const r = calcular(0, cfg);
  const d = DADOS.dolar;
  $("oportunidades").hidden = false;
  $("dolarBox").innerHTML = d.preco
    ? `<span>Dólar</span><strong>${fmtR(d.preco)}</strong>${seloNota(r.ctx.dolar.score)}
       <small>mín. 12m ${fmtR(d.min52)} · média ${fmtR(d.media12m)} · máx. ${fmtR(d.max52)}</small>
       ${tagsHtml(r.ctx.dolar.tags)}`
    : `<span class="erro">Cotação do dólar indisponível</span>`;
  const todos = r.classes
    .filter((c) => c.tipo !== "Treasure")
    .flatMap((c) => c.ativos.filter((a) => a.mercado?.preco).map((a) => ({ ...a, classe: c.nome })))
    .sort((x, y) => y.score - x.score)
    .slice(0, 8);
  $("opLista").innerHTML = todos
    .map(
      (a) => `<div class="op"><div class="op-top"><span>${a.ticker} <small>${a.classe}</small></span>${seloNota(a.score)}</div>
      ${tagsHtml(a.tags.filter((t) => !t.ruim))}</div>`
    )
    .join("");
}

// ---------- preferências e eventos ----------

function lerCfg() {
  const classes = {};
  document.querySelectorAll("#classesOn input").forEach((i) => (classes[i.value] = i.checked));
  return {
    k: Number($("k").value) / 100,
    maxAtivos: Math.max(1, Number($("maxAtivos").value) || 3),
    minimo: Math.max(0, Number($("minimo").value) || 0),
    classes,
  };
}

function salvar() {
  try {
    localStorage.setItem("planejador", JSON.stringify({ ...lerCfg(), aporte: $("aporte").value }));
  } catch {}
}

function restaurar() {
  try {
    return JSON.parse(localStorage.getItem("planejador")) || {};
  } catch {
    return {};
  }
}

function lerAporte() {
  let s = $("aporte").value.replace(/[^\d.,]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (!/^\d+\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
  return Number(s) || 0;
}

function executar() {
  if (!DADOS) return;
  const aporte = lerAporte();
  salvar();
  renderOportunidades();
  if (aporte <= 0) {
    $("resultado").hidden = true;
    return;
  }
  render(calcular(aporte, lerCfg()), aporte);
}

async function carregar(forcar) {
  $("btnAtualizar").disabled = $("btnCalcular").disabled = true;
  $("status").textContent = forcar && LOCAL ? "Atualizando cotações e indicadores…" : "Carregando carteira…";
  try {
    // no PC o servidor local busca na hora; na internet o site lê o arquivo gerado pelo GitHub
    const url = LOCAL ? "/api/dados" + (forcar ? "?atualizar=1" : "") : "dados.json?t=" + Date.now();
    const resp = await fetch(url, { cache: "no-store" });
    const j = await resp.json();
    if (j.erro) throw new Error(j.erro);
    aplicarDados(j);
  } catch (e) {
    $("status").innerHTML = `<span class="erro">Falha ao carregar: ${e.message}</span>`;
  } finally {
    $("btnAtualizar").disabled = $("btnCalcular").disabled = false;
  }
}

function aplicarDados(j) {
  DADOS = j;
  $("status").textContent = `Carteira ${j.carteira_id} · dados de ${j.atualizado_em}`;
  montarChips();
  executar();
}

// Na internet não há servidor: o botão abre o robô no GitHub para rodar na hora
// e a página fica conferindo até o arquivo novo ser publicado.
const WORKFLOW_URL = "https://github.com/vasco3107/planejador-investimento/actions/workflows/atualizar.yml";
let espera = null;

function atualizarOnline() {
  window.open(WORKFLOW_URL, "_blank");
  const antes = DADOS?.atualizado_em;
  $("status").textContent =
    'No GitHub, toque em "Run workflow" e confirme. Esta página atualiza sozinha quando os dados novos chegarem (1 a 2 min).';
  clearInterval(espera);
  let tentativas = 0;
  const conferir = async () => {
    tentativas++;
    try {
      const j = await fetch("dados.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json());
      if (j.atualizado_em !== antes) {
        clearInterval(espera);
        aplicarDados(j);
        return;
      }
    } catch {}
    if (tentativas >= 40) {
      clearInterval(espera);
      $("status").textContent = `Ainda sem dados novos · dados de ${antes}. Confira se o robô rodou no GitHub.`;
    }
  };
  espera = setInterval(conferir, 15000);
  document.addEventListener("visibilitychange", () => !document.hidden && espera && conferir(), { once: true });
}

function montarChips() {
  const salvo = restaurar().classes || {};
  $("classesOn").innerHTML = DADOS.classes
    .filter((c) => c.ideal > 0)
    .map(
      (c) => `<label class="chip"><input type="checkbox" value="${c.tipo}" ${salvo[c.tipo] === false ? "" : "checked"}>${c.nome}</label>`
    )
    .join("");
  $("classesOn").querySelectorAll("input").forEach((i) => i.addEventListener("change", executar));
}

const prefs = restaurar();
if (prefs.aporte) $("aporte").value = prefs.aporte;
if (prefs.k != null) $("k").value = Math.round(prefs.k * 100);
if (prefs.maxAtivos) $("maxAtivos").value = prefs.maxAtivos;
if (prefs.minimo != null) $("minimo").value = prefs.minimo;
$("kOut").textContent = $("k").value + "%";

$("btnCalcular").addEventListener("click", executar);
$("aporte").addEventListener("keydown", (e) => e.key === "Enter" && executar());
$("k").addEventListener("input", () => {
  $("kOut").textContent = $("k").value + "%";
  executar();
});
$("maxAtivos").addEventListener("change", executar);
$("minimo").addEventListener("change", executar);
$("btnAtualizar").addEventListener("click", () => (LOCAL ? carregar(true) : atualizarOnline()));

carregar(false);
