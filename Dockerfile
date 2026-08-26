# Imagen del frontend: Sovngarde Notes (Node + Express)
#
# Se usa el mirror de Docker Official Images en ECR Public en vez de Docker
# Hub. Motivo: CodeBuild corre sobre IPs compartidas de AWS y los pulls
# anonimos a Docker Hub estan limitados (100 cada 6hs por IP), lo que hacia
# fallar el build con "429 Too Many Requests".
FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

# Primero los manifests, para aprovechar el cache de capas de Docker
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# server.js usa process.env.PORT || 80, y el target group del ALB apunta al 80
EXPOSE 80

CMD ["node", "server.js"]
