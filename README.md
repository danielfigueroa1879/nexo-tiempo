# Nexo Tiempo

Mapa meteorológico interactivo en tiempo real, con código y diseño propios y datos abiertos.

## Cómo abrirla

En la app Terminal:

```bash
cd /Users/daniel/Documents/LABORATORIO/REA/nexo-tiempo && node server.js
```

Luego abre **http://localhost:5173** en el navegador. Para detenerla, presiona `Ctrl + C` en la Terminal.
(Si `node` no se encuentra, usa `~/.local/node/bin/node server.js`.)

## Qué incluye

- Capas: Presión (isobaras, centros A/B), Viento (partículas animadas), Temperatura, Lluvia (pronóstico), Radar (observado) y Nubes.
- Barra de tiempo: 4 días de pronóstico por hora (en Radar, las últimas 2 horas observadas). Botón ▶ o barra espaciadora para reproducir; flechas ← → para avanzar.
- Clic en el mapa: pronóstico del punto (ahora y las próximas 24 h).
- Al pasar el mouse se ve el valor de la capa activa.
- La URL guarda la posición y la capa (ej. `#-33.452,-70.654,5,pressure`).

## Fuentes de datos (gratuitas, sin clave)

- Pronóstico: [Open-Meteo](https://open-meteo.com) (CC BY 4.0). El plan gratuito limita las consultas por minuto/hora/día;
  la app guarda en caché lo descargado y reintenta sola si se llega al límite.
- Radar: [RainViewer](https://www.rainviewer.com/api.html) (cobertura según los radares de cada país; en Chile es limitada).
- Mapa base: © [OpenStreetMap](https://www.openstreetmap.org/copyright) (oscurecido con un filtro CSS).
- Librería de mapas: [Leaflet](https://leafletjs.com) 1.9.4 desde unpkg.

## Archivos

- `server.js`: servidor estático mínimo (sin dependencias).
- `public/index.html`, `public/styles.css`, `public/app.js`: la aplicación.
