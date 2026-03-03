# FormatFlow Studio (React + Vite + ffmpeg.wasm)

Editor web local para recortar videos MP4, auto-dividirlos, generar cortes multiples por rangos inicio/fin, reformatear videos a Instagram 4:5 y convertir lotes de imagenes, **siempre recodificando** (sin stream copy).

## Stack

- Vite + React + TypeScript
- `@ffmpeg/ffmpeg` + `@ffmpeg/util`
- `JSZip` para descarga masiva en `.zip`
- Core local de ffmpeg servido desde `public/ffmpeg`

## Reglas de codificacion aplicadas

En los procesos de video se usa este perfil (recodificacion obligatoria):

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

Para uso normal, **basta con el contenedor de producción** (`video-editor-prod`).
El contenedor `video-editor-dev` es opcional y se usa solo para desarrollo con hot reload.

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
2. Definir patrón de nombre con variables: `{video}`, `{idx}`, `{start}`, `{end}`, `{duration}`.
3. Usar el **timeline visual con handles** para ajustar inicio/fin del corte activo arrastrando.
4. Ajustar tiempos con botones de **snapping** (`+/-1s`, `+/-100ms`) o atajos `I` (inicio) / `O` (fin).
5. Definir `Start time` y `Duration` para recorte simple.
6. O definir `Clip length` y usar **Auto-dividir**.
7. O definir varios cortes independientes (`inicio` + `fin`) en **Cortes múltiples**.
8. O usar **Lote imágenes 4:5** para cargar múltiples `.jpg/.jpeg/.png/.webp` y convertirlos a `.jpg` en `1080x1350` (`scale + crop`).
9. Reordenar cortes múltiples con **drag & drop**.
10. Lanzar proceso y, en colas largas (auto/multi/imágenes), usar **Pausar / Reanudar / Cancelar**.
11. Descargar salidas individuales o por lote en `.zip`.

## Funciones avanzadas

- Timeline visual con handles (inicio/fin) y foco dinámico según el corte seleccionado.
- Snapping temporal fino y atajos de teclado (`I`/`O`).
- Inicialización automática del motor ffmpeg al cargar video (sin botón manual).
- Reordenamiento de cortes múltiples por drag & drop.
- Cola de trabajos con pausa/reanudar/cancelar.
- Conversión en lote de imágenes a `1080x1350` con `force_original_aspect_ratio=increase` + `crop`.
- ETA estimada y métricas de ejecución en tiempo real.
- Métricas por salida antes de descargar:
  - tamaño
  - duración solicitada
  - duración real detectada
- Verificación de integridad por clip (reproducible/no reproducible) antes de habilitar descarga.
- Previsualización en loop del rango de cada corte.
- Historial local de sesiones con recuperación de plantillas de cortes múltiples.

## Validaciones incluidas

- `start >= 0`
- `duration > 0`
- Si hay metadata de duración: límites contra duración total
- Errores de formato de tiempo claros
- Advertencia para archivos muy grandes

Formatos de tiempo aceptados:

- `HH:MM:SS`
- `HH:MM:SS.mmm`
- `MM:SS` / `MM:SS.mmm`
- separador decimal con punto o coma (ej: `34.5` o `34,5`)
- segundos con decimales (ej: `34.5`)

## Notas de rendimiento

- Todo corre en navegador (sin backend).
- Archivos grandes pueden tardar y consumir mucha RAM.
- La pausa/reanudación aplica entre jobs de cola; la cancelación intenta interrumpir el job actual reiniciando el worker.
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
