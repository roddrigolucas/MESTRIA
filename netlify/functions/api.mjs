// Cargo IoT - ponte entre a página e o Data Lake da Mestria (S3 compatível, somente leitura).
// As chaves ficam só nas variáveis de ambiente da Netlify; a página nunca as recebe.
//   GET /api/particoes           dias disponíveis no lake
//   GET /api/teste?ini=&fim=     etapas do teste de comunicação + arquivos do período
//   GET /api/objeto?key=         bytes de um arquivo .parquet do lake
//   GET /api/login               só confere usuário e senha
// Toda chamada exige os cabeçalhos x-usuario e x-senha iguais às variáveis APP_USUARIO e APP_SENHA.
import { AwsClient } from "aws4fetch";
import { createHash, timingSafeEqual } from "node:crypto";

const env = k => (globalThis.Netlify?.env.get(k) ?? process.env[k] ?? "").trim();
const ENDPOINT = () => `https://${env("S3_ENDPOINT") || "s3.mestria.com.br"}`;
const BUCKET = "iot-cargo-lake";
const PREFIX = "telemetry/";
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function senhaOk(req) {
  const usuario = env("APP_USUARIO"), senha = env("APP_SENHA");
  if (!usuario || !senha) return null;           // sem credencial configurada: recusa tudo
  const h = s => createHash("sha256").update(s).digest();
  const u = timingSafeEqual(h((req.headers.get("x-usuario") || "").trim().toLowerCase()), h(usuario.toLowerCase()));
  const p = timingSafeEqual(h(req.headers.get("x-senha") || ""), h(senha));
  return u && p;
}

function cliente() {
  const accessKeyId = env("AI_ACCESS_KEY"), secretAccessKey = env("AI_SECRET_KEY");
  if (!accessKeyId || !secretAccessKey) throw new Error("AI_ACCESS_KEY / AI_SECRET_KEY não definidas na Netlify");
  return new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "us-east-1", retries: 2 });
}

const xml = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

async function s3erro(r) {
  const corpo = await r.text().catch(() => "");
  const cod = (corpo.match(/<Code>([^<]+)</) || [])[1] || `HTTP ${r.status}`;
  const msg = (corpo.match(/<Message>([^<]+)</) || [])[1] || "";
  return new Error(msg ? `${cod}: ${msg}` : cod);
}

async function listar(s3, prefix, { delimiter, maxKeys } = {}) {
  const prefixos = [], objetos = [];
  let token;
  do {
    const u = new URL(`${ENDPOINT()}/${BUCKET}`);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix);
    if (delimiter) u.searchParams.set("delimiter", delimiter);
    if (maxKeys) u.searchParams.set("max-keys", String(maxKeys));
    if (token) u.searchParams.set("continuation-token", token);
    const r = await s3.fetch(u);
    if (!r.ok) throw await s3erro(r);
    const x = await r.text();
    for (const m of x.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g)) prefixos.push(xml(m[1]));
    for (const m of x.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = (m[1].match(/<Key>([^<]+)</) || [])[1], size = (m[1].match(/<Size>(\d+)</) || [])[1];
      if (key) objetos.push({ key: xml(key), size: +size || 0 });
    }
    token = maxKeys ? null : (x.match(/<NextContinuationToken>([^<]+)</) || [])[1];
  } while (token);
  return { prefixos: prefixos.sort(), objetos };
}

async function diasDisponiveis(s3) {
  const dias = [];
  for (const ano of (await listar(s3, PREFIX, { delimiter: "/" })).prefixos)
    for (const mes of (await listar(s3, ano, { delimiter: "/" })).prefixos)
      for (const dia of (await listar(s3, mes, { delimiter: "/" })).prefixos) {
        const p = Object.fromEntries(dia.replace(/\/$/, "").split("/").slice(1).map(x => x.split("=")));
        dias.push(`${p.year}-${p.month}-${p.day}`);
      }
  return dias.sort();
}

const prefixoDia = d => `${PREFIX}year=${d.slice(0, 4)}/month=${d.slice(5, 7)}/day=${d.slice(8)}/`;
const diaUtc = delta => new Date(Date.now() - delta * 864e5).toISOString().slice(0, 10);

async function particoes() {
  const dias = await diasDisponiveis(cliente());
  return { dias, esperado_ate: diaUtc(2), hoje_utc: diaUtc(0) };
}

async function teste(url) {
  let ini = url.searchParams.get("ini") || "", fim = url.searchParams.get("fim") || "";
  for (const d of [ini, fim]) if (d && !DATA_RE.test(d)) return json({ erro: "datas no formato AAAA-MM-DD" }, 400);
  const etapas = [], reg = (etapa, ok, detalhe = "") => etapas.push({ etapa, status: ok === true ? "OK" : ok === false ? "FALHA" : "AVISO", detalhe });
  const resp = { etapas, arquivos: [], parametros: { data_inicio: ini, data_fim: fim } };

  let s3;
  try {
    s3 = cliente();
    reg("Credenciais (variáveis da Netlify)", true, `access_key=${env("AI_ACCESS_KEY")} | secret=***`);
  } catch (e) { reg("Credenciais (variáveis da Netlify)", false, e.message); return json(resp); }

  try {
    const t0 = Date.now(), r = await s3.fetch(`${ENDPOINT()}/${BUCKET}?location=`);
    if (!r.ok) throw await s3erro(r);
    const loc = ((await r.text()).match(/<LocationConstraint[^>]*>([^<]*)</) || [])[1] || "default";
    reg("Conexão HTTPS + autenticação (GetBucketLocation)", true, `${ENDPOINT()} | bucket=${BUCKET} | região=${loc} | ${Date.now() - t0} ms`);
  } catch (e) { reg("Conexão HTTPS + autenticação (GetBucketLocation)", false, e.message); return json(resp); }

  let dias = [];
  try {
    dias = await diasDisponiveis(s3);
    reg("ListBucket: dias disponíveis no lake", dias.length > 0, dias.length ? `${dias.length} dias (${dias[0]} a ${dias.at(-1)})` : "nenhum");
  } catch (e) { reg("ListBucket: dias disponíveis no lake", false, e.message); }
  resp.dias_disponiveis = dias;
  if (!dias.length) return json(resp);

  fim = fim || dias.at(-1); ini = ini || fim;
  if (ini > fim) [ini, fim] = [fim, ini];
  const sel = dias.filter(d => d >= ini && d <= fim);
  Object.assign(resp.parametros, { data_inicio: ini, data_fim: fim, dias_lidos: sel });
  reg("Dias no período escolhido", sel.length > 0, sel.length ? sel.join(", ") : `nenhum entre ${ini} e ${fim}`);

  const esperado = diaUtc(2);
  resp.esperado_ate = esperado;
  if (dias.at(-1) < esperado) reg("Atualização do lake", null, `último dia ${dias.at(-1)}; pela regra dos 2 dias deveria haver até ${esperado}`);

  try {
    for (const d of sel)
      for (const o of (await listar(s3, prefixoDia(d))).objetos)
        if (o.key.endsWith(".parquet")) resp.arquivos.push({ ...o, dia: d });
    if (sel.length) {
      const mb = resp.arquivos.reduce((s, a) => s + a.size, 0) / 1048576;
      reg("Arquivos .parquet no período", resp.arquivos.length > 0, `${resp.arquivos.length} arquivos | ${mb.toFixed(2)} MB`);
    }
    if (resp.arquivos.length) {
      const a = resp.arquivos.at(-1), t0 = Date.now();
      const r = await s3.fetch(`${ENDPOINT()}/${BUCKET}/${a.key.split("/").map(encodeURIComponent).join("/")}`, { headers: { range: "bytes=0-3" } });
      if (!r.ok) throw await s3erro(r);
      const magic = new TextDecoder().decode(await r.arrayBuffer());
      reg("GetObject (range)", magic === "PAR1", `${a.key.split("/").pop()} | ${a.size} bytes | magic=${magic} | ${Date.now() - t0} ms`);
    }
  } catch (e) { reg("GetObject", false, e.message); }

  for (const delta of [0, 1]) {
    const d = diaUtc(delta);
    try {
      const n = (await listar(s3, prefixoDia(d), { maxKeys: 1 })).objetos.length;
      reg(`Sem dados em ${d} (hoje-${delta})`, n === 0, n === 0 ? "vazio, conforme esperado" : "há arquivos (inesperado)");
    } catch (e) { reg(`Checagem ${d}`, false, e.message); }
  }
  return json(resp);
}

async function objeto(url) {
  const key = url.searchParams.get("key") || "";
  if (!/^telemetry\/year=\d{4}\/month=\d{2}\/day=\d{2}\/[\w.\-]+\.parquet$/.test(key)) return json({ erro: "arquivo inválido" }, 400);
  const r = await cliente().fetch(`${ENDPOINT()}/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`);
  if (!r.ok) return json({ erro: (await s3erro(r)).message }, r.status === 404 ? 404 : 502);
  return new Response(r.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
}

export default async (req) => {
  const ok = senhaOk(req);
  if (ok === null) return json({ erro: "APP_USUARIO / APP_SENHA não configuradas na Netlify" }, 500);
  if (!ok) return json({ erro: "usuário ou senha incorretos" }, 401);
  const url = new URL(req.url), rota = url.pathname.replace(/\/+$/, "");
  try {
    if (rota === "/api/login") return json({ ok: true });
    if (rota === "/api/particoes") return json(await particoes());
    if (rota === "/api/teste") return await teste(url);
    if (rota === "/api/objeto") return await objeto(url);
    return json({ erro: "rota não encontrada" }, 404);
  } catch (e) {
    return json({ erro: e.message || String(e) }, 502);
  }
};

export const config = { path: "/api/*", method: "GET" };
