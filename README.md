# Sovngarde Notes — frontend

Anotador colaborativo con tematica nordica. Es el servicio `frontend` que
corre en el cluster ECS detras del ALB (2 tasks), y persiste las notas en la
task de MySQL, cuyo volumen vive en EFS.

## Stack

- Node.js 20 + Express (sirve la API y los archivos estaticos)
- mysql2 para la conexion a la base
- Frontend sin framework: HTML, CSS y JS plano.
- La ronda de tomos es una escena 3D con **three.js** (importado por CDN via
  importmap) que carga los modelos GLB reales de los libros.
- Postprocesado con `EffectComposer` + `UnrealBloomPass` para el halo de los
  destellos y el oro. Se apaga con `?bloom=0`.
- Environment map generado por codigo (no hay archivo HDR): un cielo
  equirectangular dibujado en canvas y pasado por `PMREMGenerator`, para que
  los materiales PBR de las tapas tengan algo que reflejar.

## Parametros de URL

Utiles para ajustar sin volver a desplegar:

| Parametro | Por defecto | Que hace |
|-----------|-------------|----------|
| `?escala=` | 1.8 | Cuanto se agranda el modelo del tomo ajeno |
| `?hitbox=` | 1/escala | Porcion del tomo que responde al puntero |
| `?bloom=0` | activo | Apaga el postprocesado |

## Controles de la ronda

- Arrastrar con el puntero la hace girar, y al soltar sigue por inercia
- La rueda del mouse acerca y aleja la camara
- Un click corto (sin arrastre) abre el tomo

## Estructura

```
lab3-app/
├── Dockerfile          imagen del contenedor (Node 20 alpine)
├── buildspec.yml       pasos de build para CodeBuild
├── server.js           API + servidor estatico
├── package.json
└── public/
    ├── index.html
    ├── style.css
    ├── app.js          modulo ES (usa three.js)
    ├── img/
    │   └── aurora.webp     fondo del cielo
    └── models/
        ├── tome-mine.glb    modelo de "tus tomos"
        └── tome-others.glb  modelo de "tomos de otros"
```

## Variables de entorno

Llegan desde Parameter Store, inyectadas como `secrets` en la task
definition (ver `frontend_secrets` en `environments/dev/main.tf`).

Se aceptan dos juegos de nombres, para no depender de como esten mapeados:

| Proposito | Nombres aceptados            |
|-----------|------------------------------|
| Host      | `DB_HOST` o `MYSQL_HOST`     |
| Puerto    | `DB_PORT` o `MYSQL_PORT`     |
| Base      | `DB_NAME` o `MYSQL_DATABASE` |
| Usuario   | `DB_USER` o `MYSQL_USER`     |
| Password  | `DB_PASSWORD` o `MYSQL_PASSWORD` |

`PORT` es opcional y por defecto vale **80**, que es el puerto que espera el
target group del ALB.

## Endpoints

| Metodo | Ruta          | Descripcion                                  |
|--------|---------------|----------------------------------------------|
| GET    | `/health`     | Devuelve 200 apenas el server HTTP esta arriba, aunque MySQL todavia no responda. Evita que el target group tumbe tasks sanas por un problema transitorio de la base. |
| GET    | `/api/notas`  | Lista las notas, mas recientes primero        |
| POST   | `/api/notas`  | Crea una nota. Body: `{ "titulo": "...", "texto": "...", "autor": "..." }` |
| DELETE | `/api/notas/:id` | Borra una nota. Body: `{ "autor": "..." }`. Devuelve 403 si el autor no coincide con el de la nota. |

## Esquema

```sql
CREATE TABLE notas (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  titulo         VARCHAR(120) NOT NULL DEFAULT 'Tomo sin titulo',
  texto          VARCHAR(1000) NOT NULL,
  autor          VARCHAR(80) NOT NULL DEFAULT 'Viajero anonimo',
  fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

La tabla se crea sola al arrancar. Si ya existia sin las columnas `autor` o
`titulo`, se agregan automaticamente con un `ALTER TABLE` (el error 1060 de
columna duplicada se ignora: significa que la migracion ya se aplico).

Las notas cargadas antes de que existiera `titulo` quedan con el valor por
defecto; en pantalla el lomo muestra el primer fragmento del texto para que
ningun tomo aparezca en blanco.

## Borrar notas

Cada quien puede borrar solo sus propias notas. El boton aparece unicamente
si el nombre del visitante coincide con el autor, y pide confirmacion en dos
pasos dentro del mismo boton.

La validacion tambien esta en el servidor (`DELETE` compara el autor enviado
con el de la fila y responde 403 si no coincide). No es seguridad real
—cualquiera podria mandar otro nombre— pero evita el borrado accidental
desde la interfaz, que es el riesgo concreto sin sistema de login.

## Identidad del autor

No hay sistema de login. La app pide el nombre del visitante la primera vez
y lo guarda en el navegador (`localStorage`), y lo manda en cada POST. Eso
es lo que permite separar en pantalla "tus tomos" de "tomos de otros".


## Probar en local

```bash
npm install
DB_HOST=localhost DB_USER=root DB_PASSWORD=secret DB_NAME=app PORT=3000 npm start
```

Sin una base levantada el sitio igual carga; la API responde 503 con un
mensaje claro hasta que MySQL este disponible.
