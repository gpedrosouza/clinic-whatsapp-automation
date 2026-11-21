# syntax=docker/dockerfile:1

# ===========================================================================
# Por que Dockerfile e não o builder automático do Railway:
#
# O better-sqlite3 traz binários pré-compilados (prebuilds/linux-x64.node) e
# o lib/binding.js os carrega ANTES de qualquer coisa compilada localmente. No
# runtime do Railpack esse binário faz segmentation fault na hora do require,
# e o processo morre antes de emitir um único log.
#
# A correção é apagar o prebuild e compilar o módulo contra exatamente o Node
# e a glibc desta imagem. Sem o prebuild, o lib/binding.js cai para
# build/Release — que é o que o node-gyp produz aqui.
# ===========================================================================

# --- build: compila o módulo nativo -----------------------------------------
FROM node:24-bookworm-slim AS build

WORKDIR /app

# node-gyp precisa de python3 + toolchain C++ para compilar o SQLite.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# `npm rebuild` aqui não serve: ele não compilou e ainda assim saiu com
# sucesso, e a imagem subiu sem o .node. Chamando o node-gyp direto, com o
# mesmo --force_build=1 do script build-release do próprio pacote, a falha
# aparece; e o `test -f` garante que ninguém publique sem o binário.
RUN npm install -g node-gyp
RUN cd node_modules/better-sqlite3 \
 && rm -rf prebuilds \
 && node-gyp rebuild --release --force_build=1 \
 && test -f build/Release/better_sqlite3.node

# --- runtime: mesma base, sem o toolchain -----------------------------------
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY . .

# Segunda trava: pega o caso de o binário existir no build e não chegar aqui.
RUN test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
 && node -e "require('better-sqlite3'); console.log('better-sqlite3: carrega OK')"

# O Railway injeta PORT; config.js usa 3000 como padrão local.
EXPOSE 3000

CMD ["node", "src/server.js"]
