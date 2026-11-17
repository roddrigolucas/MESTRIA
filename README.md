# Cargo IoT · Mission Control (Mestria × SENAI MG)

Aplicação web do projeto **Frota 4.0 / Cargo IoT (PCE41000)** para testar a API do Data Lake da Mestria,
coletar os dados de telemetria e analisá-los (velocidade, estabilidade, carga, eventos dinâmicos e
indicadores para navegação semi-autônoma).

Publicada em: **https://mestriacargoiot.netlify.app** (acesso com usuário e senha).

## Deploy contínuo

O site Netlify `mestriacargoiot` está ligado a este repositório: **cada commit na branch `main` gera
um deploy de produção automaticamente**. Pull requests geram um *Deploy Preview* com link próprio.

Não há etapa de build: a Netlify publica a pasta `public/` e empacota a função em `netlify/functions/`
(ver `netlify.toml`).

## Estrutura

```
public/index.html            interface (login, coleta, cockpit, gráficos, análises)
public/vendor/hyparquet.js   leitor de Parquet no navegador (hyparquet + compressores)
public/media/                vídeo e imagem de fundo da tela de login
netlify/functions/api.mjs    ponte com o Data Lake (S3 compatível, somente leitura)
netlify.toml                 configuração da Netlify
```

A função expõe `GET /api/login`, `/api/particoes`, `/api/teste` e `/api/objeto`. Todas exigem os
cabeçalhos `x-usuario` e `x-senha`.

## Variáveis de ambiente (configuradas na Netlify, nunca no código)

| Variável | Uso |
|---|---|
| `APP_USUARIO`, `APP_SENHA` | login da aplicação |
| `AI_ACCESS_KEY`, `AI_SECRET_KEY` | credencial somente leitura do Data Lake da Mestria |
| `S3_ENDPOINT` | opcional; padrão `s3.mestria.com.br` |

Para trocar a senha: Netlify → *Project configuration* → *Environment variables* → `APP_SENHA`, e
depois *Deploys* → *Trigger deploy*.

## Observações sobre os dados

- O campo `time` repete o mesmo horário para muitas leituras; a análise ordena as amostras pelo
  horímetro (`hour_meter`), que avança uma vez por leitura.
- O hodômetro é tratado como **milímetros** (o dicionário diz cm); assim a distância bate com o GPS.
- Índices e limites da seção "Navegação semi-autônoma" são regras heurísticas, ainda não validadas em campo.

O vídeo de fundo é do banco gratuito Mixkit (licença Mixkit), usado apenas como fundo do site.
