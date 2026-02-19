# Mini Video Cutter (React + Vite + ffmpeg.wasm)

Editor web local para recortar videos MP4 y auto-dividirlos en clips consecutivos, **siempre recodificando** (sin stream copy).

## Stack

- Vite + React + TypeScript
- `@ffmpeg/ffmpeg` + `@ffmpeg/util`
- Core local de ffmpeg servido desde `public/ffmpeg`

## Reglas de codificación aplicadas

En todos los recortes se usa este perfil (re-codificación obligatoria):

```bash
-ss START -i input.mp4 -t DURATION \
  -c:v libx264 -preset veryfast -crf 23 \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  output.mp4
```

No se usa `-c copy`, `-codec copy`, `-copyts` ni modos rápidos sin recodificar.

## Instalación y ejecución

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Docker

### Desarrollo (Vite + hot reload)

```bash
docker compose up --build video-editor-dev
```

App disponible en:

- `http://localhost:5173`

### Producción (build + Nginx)

```bash
docker compose --profile prod up --build video-editor-prod
```

App disponible en:

- `http://localhost:8080`

## Cómo funciona el core local

1. Al instalar dependencias, el script `postinstall` ejecuta `scripts/copy-ffmpeg-assets.mjs`.
2. Ese script copia:
   - `ffmpeg-core.js`
   - `ffmpeg-core.wasm`
   - `worker.js`, `const.js`, `errors.js`
   a `public/ffmpeg/`.
3. La app carga el core con `toBlobURL()` usando:
   - `coreURL` y `wasmURL` (sin CDN)
   - `classWorkerURL` local para el worker de `@ffmpeg/ffmpeg`

## Flujo de uso

1. Cargar video por botón o drag & drop.
2. Definir `Start time` y `Duration`.
3. Click en **Recortar** para generar `output.mp4`.
4. O definir `Clip length` y usar **Auto-dividir** para generar `clip_000.mp4`, `clip_001.mp4`, etc.
5. Descargar desde los links generados.

## Validaciones incluidas

- `start >= 0`
- `duration > 0`
- Si hay metadata de duración: límites contra duración total
- Errores de formato de tiempo claros
- Advertencia para archivos muy grandes

Formatos de tiempo aceptados:

- `HH:MM:SS`
- `HH:MM:SS.mmm`
- segundos con decimales (ej: `34.5`)

## Notas de rendimiento

- Todo corre en navegador (sin backend).
- Archivos grandes pueden tardar y consumir mucha RAM.
- Se limpian recursos:
  - `URL.revokeObjectURL` para previews/salidas
  - borrado de archivos temporales del FS virtual de ffmpeg

## Estructura

```text
.
├── .dockerignore
├── index.html
├── package.json
├── Dockerfile
├── docker-compose.yml
├── docker
│   └── nginx.conf
├── public
│   └── ffmpeg
│       └── .gitkeep
├── README.md
├── scripts
│   └── copy-ffmpeg-assets.mjs
├── src
│   ├── App.css
│   ├── App.tsx
│   ├── index.css
│   ├── lib
│   │   ├── ffmpeg.ts
│   │   └── time.ts
│   ├── main.tsx
│   └── vite-env.d.ts
├── tsconfig.app.json
├── tsconfig.json
├── tsconfig.node.json
└── vite.config.ts
```
