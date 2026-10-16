# Audios del despacho

Aquí van las notas de voz grabadas por el abogado, en `.ogg` con códec **OPUS**. El nombre
del fichero sin extensión es la clave del audio: `bienvenida.ogg` es el audio `bienvenida`.

```bash
ffmpeg -i grabacion.m4a -c:a libopus -b:a 32k bienvenida.ogg
npm run audios:registrar <slug>
```

**Cualquier otro formato llega a WhatsApp como archivo adjunto**, sin dar error en ninguna
parte: el contacto ve un fichero para descargar en vez de una nota de voz que se escucha de
un toque. `scripts/audios.ts` lo comprueba al registrar, que es el único momento en que
alguien está mirando.

Esta carpeta existe aunque esté vacía porque el `Dockerfile` la copia: sin ella la imagen
no se construye. Un despacho sin audios funciona igual — el bot simplemente no manda voz.
